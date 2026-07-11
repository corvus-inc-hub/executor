import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, beforeAll, expect, test } from "@effect/vitest";

import { makeScopedExecutor } from "@executor-js/api/server";
import { AuthTemplateSlug, ConnectionName, ProviderKey } from "@executor-js/sdk";

import { AWS_ROLE_INTEGRATION_SLUG, AWS_ROLE_TEMPLATE } from "./aws-role-integration";
import { createSelfHostDb, SelfHostDb } from "./db/self-host-db";
import { SelfHostScopedExecutorSeams } from "./execution";
import type { SelfHostPlugins } from "./plugins";

const dataDir = mkdtempSync(join(tmpdir(), "eh-aws-role-"));
process.env.EXECUTOR_DATA_DIR = dataDir;
process.env.EXECUTOR_SECRET_KEY = "aws-role-integration-test-key";

const createScopedExecutor = (accountId: string, organizationId: string) =>
  makeScopedExecutor<SelfHostPlugins>(accountId, organizationId, "Test organization").pipe(
    Effect.provide(SelfHostScopedExecutorSeams),
  );

let dbLayer!: Layer.Layer<SelfHostDb>;
let dbHandle: Awaited<ReturnType<typeof createSelfHostDb>> | undefined;

beforeAll(async () => {
  dbHandle = await createSelfHostDb({
    path: join(dataDir, "data.db"),
    namespace: "executor_selfhost",
    version: "1.0.0",
  });
  dbLayer = Layer.succeed(SelfHostDb)(dbHandle);
});

afterAll(async () => {
  await dbHandle?.close();
});

test("registers amazonaws.com idempotently and produces no executable tools", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* createScopedExecutor("admin", "aws-org");
      const integration = yield* first.integrations.get(AWS_ROLE_INTEGRATION_SLUG);
      expect(integration).toMatchObject({
        slug: AWS_ROLE_INTEGRATION_SLUG,
        name: "Amazon Web Services",
        kind: "awsRole",
        canRemove: false,
        canRefresh: false,
      });
      expect(integration?.authMethods).toEqual([
        expect.objectContaining({
          id: AWS_ROLE_TEMPLATE,
          template: AWS_ROLE_TEMPLATE,
          label: expect.stringContaining("AWS_EXTERNAL_ID optional"),
          placements: [
            expect.objectContaining({ variable: "AWS_ROLE_ARN" }),
            expect.objectContaining({ variable: "AWS_REGION" }),
          ],
        }),
      ]);

      const connection = yield* first.connections.create({
        owner: "org",
        name: ConnectionName.make("deploy"),
        integration: AWS_ROLE_INTEGRATION_SLUG,
        template: AuthTemplateSlug.make(AWS_ROLE_TEMPLATE),
        values: {
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/ExecutorDeploy",
          AWS_REGION: "us-west-2",
          AWS_EXTERNAL_ID: "manifest-executor",
        },
      });
      expect(String(connection.provider)).toBe("encrypted");

      const tools = yield* first.tools.list();
      expect(
        tools.filter((tool) => String(tool.integration) === String(AWS_ROLE_INTEGRATION_SLUG)),
      ).toEqual([]);

      const second = yield* createScopedExecutor("admin", "aws-org");
      const integrations = yield* second.integrations.list();
      expect(
        integrations.filter(
          (candidate) => String(candidate.slug) === String(AWS_ROLE_INTEGRATION_SLUG),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );
});

test("rejects and removes static AWS access-key material", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* createScopedExecutor("admin", "aws-reject-org");
      const name = ConnectionName.make("static-keys");
      const failure = yield* executor.connections
        .create({
          owner: "org",
          name,
          integration: AWS_ROLE_INTEGRATION_SLUG,
          template: AuthTemplateSlug.make(AWS_ROLE_TEMPLATE),
          values: {
            AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
            AWS_SECRET_ACCESS_KEY: "must-not-remain",
          },
        })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("StorageError");

      const ref = { owner: "org" as const, integration: AWS_ROLE_INTEGRATION_SLUG, name };
      const rejectedConnection = yield* executor.connections.get(ref);
      expect(rejectedConnection).toBeNull();
      const encryptedItems = yield* executor.providers.items(ProviderKey.make("encrypted"));
      for (const variable of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
        const itemId = `connection:org:${AWS_ROLE_INTEGRATION_SLUG}:${name}:${variable}`;
        expect(encryptedItems.some((item) => String(item.id) === itemId)).toBe(false);
      }
    }).pipe(Effect.provide(dbLayer), Effect.scoped),
  );
});
