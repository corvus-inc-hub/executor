import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, beforeAll, expect, test } from "@effect/vitest";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import { makeScopedExecutor } from "@executor-js/api/server";

import { createSelfHostDb, SelfHostDb } from "./db/self-host-db";
import { SelfHostScopedExecutorSeams } from "./execution";
import type { SelfHostPlugins } from "./plugins";

// In v2 a connection IS the credential: its inline `value` is written through the
// default writable provider — here the encrypted-secrets provider, which stores
// an AES-GCM payload at rest. This test registers an integration, attaches an
// org connection carrying a plaintext needle, and asserts the needle never
// reaches the SQLite file while the versioned "v1." ciphertext does.
const dataDir = mkdtempSync(join(tmpdir(), "eh-secrets-"));
const dbPath = join(dataDir, "data.db");
process.env.EXECUTOR_DATA_DIR = dataDir;
process.env.EXECUTOR_SECRET_KEY = "integration-test-master-key";

const createScopedExecutor = (
  accountId: string,
  organizationId: string,
  organizationName: string,
) =>
  makeScopedExecutor<SelfHostPlugins>(accountId, organizationId, organizationName).pipe(
    Effect.provide(SelfHostScopedExecutorSeams),
  );

let dbLayer!: Layer.Layer<SelfHostDb>;
let dbHandle: Awaited<ReturnType<typeof createSelfHostDb>> | undefined;

beforeAll(async () => {
  dbHandle = await createSelfHostDb({
    path: dbPath,
    namespace: "executor_selfhost",
    version: "1.0.0",
  });
  dbLayer = Layer.succeed(SelfHostDb)(dbHandle);
});
afterAll(async () => {
  await dbHandle?.close();
});

const TINY_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tiny", version: "1.0.0" },
  servers: [{ url: "https://httpbin.org" }],
  paths: {
    "/get": {
      get: {
        operationId: "httpGet",
        summary: "GET",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const NEEDLE = "PLAINTEXT_NEEDLE_9f3a";

test("a connection value is stored encrypted at rest by the 'encrypted' provider", async () => {
  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const admin = yield* createScopedExecutor("admin", "default-org", "Default");
      yield* admin.openapi.addSpec({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "tiny",
        baseUrl: "",
      });
      // The connection's inline `value` is opaque to core (D11) — it is written
      // through the default writable provider regardless of the template slug.
      return yield* admin.connections.create({
        owner: "org",
        name: ConnectionName.make("gh"),
        integration: IntegrationSlug.make("tiny"),
        template: AuthTemplateSlug.make("bearer"),
        value: NEEDLE,
      });
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );

  // The first writable provider is the encrypted one — it handled the write.
  expect(String(created.provider)).toBe("encrypted");

  // Inspect the real SQLite file through a SEPARATE libSQL connection: the
  // plaintext must NOT appear anywhere, and a versioned AES-GCM payload ("v1.")
  // must be present. Reading through an independent connection also exercises the
  // cross-connection visibility of FumaDB's writes.
  const db = createClient({ url: `file:${dbPath}` });
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(
    // oxlint-disable-next-line executor/no-redundant-primitive-cast -- boundary: sqlite_master.name is TEXT; narrow libSQL's SQLValue to string for the table list
    (r) => r.name as string,
  );
  const cells: string[] = [];
  for (const name of tables) {
    const rows = (await db.execute(`SELECT * FROM "${name}"`)).rows;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        // Plugin-storage data is a BLOB (libSQL returns ArrayBuffer); decode it.
        if (typeof value === "string") cells.push(value);
        else if (value instanceof ArrayBuffer) cells.push(Buffer.from(value).toString("utf8"));
        else if (ArrayBuffer.isView(value))
          cells.push(
            Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8"),
          );
      }
    }
  }
  db.close();

  expect(cells.some((c) => c.includes(NEEDLE))).toBe(false);
  expect(cells.some((c) => c.includes("v1."))).toBe(true);
});

// Regression (credential custody): an org-owned connection saved by a signed-in
// USER must be resolvable by every other subject in the same tenant, in
// particular the M2M service-account subject the credential-lease path binds.
// Pre-fix, the encrypted provider captured the writer's binding owner and filed
// the material under (owner=user, subject=<creator>), so any other subject
// resolved `{ token: null }` and leases failed 409 "Credential material is
// incomplete".
test("org connection material saved by one subject resolves for another subject in the tenant", async () => {
  const values = await Effect.runPromise(
    Effect.gen(function* () {
      const creator = yield* createScopedExecutor("user_creator", "default-org", "Default");
      yield* creator.openapi.addSpec({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "tiny-shared",
        baseUrl: "",
      });
      yield* creator.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: IntegrationSlug.make("tiny-shared"),
        template: AuthTemplateSlug.make("bearer"),
        value: "org-shared-token",
      });
      // A DIFFERENT subject (shaped like a WorkOS M2M service-account client id)
      // bound to the same tenant resolves the org connection's material.
      const service = yield* createScopedExecutor("client_test_01ABCDEF", "default-org", "Default");
      return yield* service.connections.resolveValues({
        owner: "org",
        integration: IntegrationSlug.make("tiny-shared"),
        name: ConnectionName.make("shared"),
      });
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );
  expect(values).toEqual({ token: "org-shared-token" });

  // The material's storage row itself sits in the org partition (owner='org',
  // subject=''), not the creating user's: that is what makes it visible to
  // every subject in the tenant. Resolve the (namespaced) table name from
  // sqlite_master rather than hard-coding the FumaDB prefix.
  const db = createClient({ url: `file:${dbPath}` });
  const [table] = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%plugin_storage%'",
    )
  ).rows;
  expect(table).toBeDefined();
  const rows = (
    await db.execute(
      `SELECT owner, subject FROM "${String(table!.name)}" WHERE key LIKE 'connection:org:tiny-shared:%'`,
    )
  ).rows;
  db.close();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.owner).toBe("org");
    expect(row.subject).toBe("");
  }
});

// The org-sharing fix must not widen user-owned connections: a personal
// connection (row and material both under the creating subject's partition)
// stays invisible to every other subject in the tenant.
test("a user-owned connection's material stays invisible to other subjects", async () => {
  const { own, other } = await Effect.runPromise(
    Effect.gen(function* () {
      const creator = yield* createScopedExecutor("user_private", "default-org", "Default");
      yield* creator.openapi.addSpec({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "tiny-private",
        baseUrl: "",
      });
      yield* creator.connections.create({
        owner: "user",
        name: ConnectionName.make("mine"),
        integration: IntegrationSlug.make("tiny-private"),
        template: AuthTemplateSlug.make("bearer"),
        value: "user-private-token",
      });
      const ref = {
        owner: "user",
        integration: IntegrationSlug.make("tiny-private"),
        name: ConnectionName.make("mine"),
      } as const;
      const stranger = yield* createScopedExecutor(
        "client_test_01ABCDEF",
        "default-org",
        "Default",
      );
      return {
        own: yield* creator.connections.resolveValues(ref),
        other: yield* stranger.connections.resolveValues(ref),
      };
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );
  // Positive control: the owner resolves their own material.
  expect(own).toEqual({ token: "user-private-token" });
  // Another subject cannot even see the connection row, let alone the value.
  expect(other).toEqual({});
});
