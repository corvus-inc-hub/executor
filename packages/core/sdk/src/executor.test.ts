import { describe, expect, it } from "@effect/vitest";
import { Clock, Data, Effect, Fiber, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";

import { ToolNotFoundError } from "./errors";
import { createExecutor } from "./executor";
import type { FumaDb } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { IntegrationDetectionResult } from "./types";
import { makeTestConfig, makeTestExecutor } from "./testing";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// removed: v1 secret browser-handoff, source.configure, case-insensitive tool-id
// resolution, secrets/sources/scope-stack. The integration coverage below is
// ported to the v2 surface (integrations/connections/OAuth/resolveTools/execute/
// tools.schema).

class TestPluginError extends Data.TaggedError("TestPluginError")<{
  readonly message: string;
}> {}

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const fixedClock = (millis: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => millis,
  currentTimeMillis: Effect.succeed(millis),
  currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
  sleep: () => Effect.void,
});

type TerminalStatus = "completed" | "expired";

const gateTerminalWrites = (root: FumaDb, preferredWinner?: TerminalStatus) => {
  let arrivals = 0;
  let releaseWrites!: () => void;
  let finishPreferredWrite!: () => void;
  let signalFirstWrite!: () => void;
  const writesReleased = new Promise<void>((resolve) => {
    releaseWrites = resolve;
  });
  const preferredWriteFinished = new Promise<void>((resolve) => {
    finishPreferredWrite = resolve;
  });
  const firstWriteReached = new Promise<void>((resolve) => {
    signalFirstWrite = resolve;
  });

  const waitForOverlap = async (table: unknown, value: unknown): Promise<TerminalStatus | null> => {
    const data =
      value && typeof value === "object"
        ? ((value as Record<string, unknown>)["data"] ??
          ((value as Record<string, unknown>)["set"] as Record<string, unknown> | undefined)?.[
            "data"
          ])
        : undefined;
    const status =
      data && typeof data === "object" ? (data as Record<string, unknown>)["status"] : undefined;
    if (table !== "plugin_storage" || (status !== "completed" && status !== "expired")) {
      return null;
    }
    arrivals += 1;
    if (arrivals === 1) signalFirstWrite();
    if (arrivals === 2) releaseWrites();
    await writesReleased;
    if (preferredWinner && status !== preferredWinner) await preferredWriteFinished;
    return status;
  };

  const completeWrite = (status: TerminalStatus | null) => {
    if (preferredWinner && status === preferredWinner) finishPreferredWrite();
  };

  const wrap = (db: FumaDb): FumaDb =>
    new Proxy(db, {
      get(target, property, receiver) {
        if (property === "withContext") {
          return (context: unknown) => {
            const withContext = Reflect.get(target, property, receiver) as (
              context: unknown,
            ) => FumaDb;
            return wrap(withContext.call(target, context));
          };
        }
        if (property === "transaction") {
          return (run: (transactionDb: FumaDb) => Promise<unknown>) => run(wrap(target));
        }
        if (property === "create") {
          return async (table: unknown, values: unknown) => {
            const status = await waitForOverlap(table, values);
            const create = Reflect.get(target, property, receiver) as (
              table: unknown,
              values: unknown,
            ) => Promise<unknown>;
            return create.call(target, table, values).finally(() => completeWrite(status));
          };
        }
        if (property === "updateMany") {
          return async (table: unknown, options: unknown) => {
            const status = await waitForOverlap(table, options);
            const updateMany = Reflect.get(target, property, receiver) as (
              table: unknown,
              options: unknown,
            ) => Promise<void>;
            return updateMany.call(target, table, options).finally(() => completeWrite(status));
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return { db: wrap(root), firstWriteReached } as const;
};

const INTEG = IntegrationSlug.make("demo");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const addr = (tool: string): ToolAddress => ToolAddress.make(`tools.${INTEG}.org.${CONN}.${tool}`);

// ---------------------------------------------------------------------------
// A plugin that registers an integration, produces per-connection tools via
// resolveTools (with shared $defs), and supports ctx.transaction rollback.
// ---------------------------------------------------------------------------

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: ({ pluginStorage }) => ({
    put: (owner: "org" | "user", key: string, value: string) =>
      pluginStorage.put({ collection: "item", key, owner, data: { value } }).pipe(Effect.asVoid),
    list: () =>
      pluginStorage
        .list<{ readonly value: string }>({ collection: "item" })
        .pipe(Effect.map((rows) => rows.map((row) => ({ id: row.key, value: row.data.value })))),
  }),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        {
          name: ToolName.make("inspect"),
          description: "inspect",
          inputSchema: {
            type: "object",
            properties: { pet: { $ref: "#/$defs/Pet" } },
            required: ["pet"],
          },
          outputSchema: { $ref: "#/$defs/Owner" },
        },
        { name: ToolName.make("run"), description: "run" },
      ],
      definitions: {
        Pet: { anyOf: [{ $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Cat" }] },
        Dog: {
          type: "object",
          properties: { collar: { $ref: "#/$defs/Collar" } },
        },
        Cat: { type: "object", properties: { lives: { type: "number" } } },
        Collar: { type: "object", properties: { id: { type: "string" } } },
        Owner: { type: "object", properties: { pet: { $ref: "#/$defs/Pet" } } },
        Unused: { type: "object", properties: { value: { type: "string" } } },
      },
    }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Demo",
        config: {},
      }),
    storagePut: (owner: "org" | "user", key: string, value: string) =>
      ctx.storage.put(owner, key, value),
    storageList: () => ctx.storage.list(),
    failAfterPluginAndCoreWrites: () =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.put("org", "tx-row", "created-before-failure");
          yield* ctx.core.integrations.register({
            slug: IntegrationSlug.make("tx-integration"),
            description: "Tx",
            config: {},
          });
          return yield* new TestPluginError({ message: "rollback" });
        }),
      ),
  }),
}))();

const makeTerminalRaceExecutor = (
  connectionHandoffTtlMs = 15 * 60 * 1_000,
  preferredWinner?: TerminalStatus,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [demoPlugin] as const,
        coreTools: {
          webBaseUrl: "https://executor.example",
          orgSlug: "acme",
          connectionReturnOrigins: ["https://manifest.example"],
          connectionHandoffTtlMs,
        },
      });
      const gate = gateTerminalWrites(config.db, preferredWinner);
      const executor = yield* createExecutor({ ...config, db: gate.db });
      return {
        executor,
        testDb: config.testDb,
        firstWriteReached: gate.firstWriteReached,
      } as const;
    }),
    ({ executor, testDb }) =>
      executor
        .close()
        .pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => testDb.close()).pipe(Effect.ignore)),
        ),
  );

const detector = (id: string, confidence: IntegrationDetectionResult["confidence"]) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    detect: () =>
      Effect.succeed(
        IntegrationDetectionResult.make({
          kind: id,
          confidence,
          endpoint: `https://example.com/${id}`,
          name: id,
          slug: id,
        }),
      ),
  }))();

describe("createExecutor", () => {
  it.effect("rolls back plugin and core writes from ctx.transaction failures", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      const result = yield* Effect.result(executor.demo.failAfterPluginAndCoreWrites());
      expect(Result.isFailure(result)).toBe(true);

      // Neither the plugin row nor the core integration row should survive.
      const rows = yield* executor.demo.storageList();
      expect(rows).toEqual([]);
      const integrations = yield* executor.integrations.list();
      expect(integrations.map((i) => String(i.slug))).not.toContain("tx-integration");
    }),
  );

  it.effect("runs plugin close hooks", () =>
    Effect.gen(function* () {
      let closed = false;
      const closingPlugin = definePlugin(() => ({
        id: "closing" as const,
        storage: () => ({}),
        close: () => Effect.sync(() => void (closed = true)),
      }))();
      const executor = yield* makeTestExecutor({
        plugins: [closingPlugin] as const,
      });
      yield* executor.close();
      expect(closed).toBe(true);
    }),
  );

  it.effect("projects core tools as the built-in Executor integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      const integrations = yield* executor.integrations.list();
      const executorIntegration = integrations.find((i) => String(i.slug) === "executor");
      expect(executorIntegration).toMatchObject({
        description: "Executor",
        kind: "built-in",
        canRemove: false,
        canRefresh: false,
      });

      const address = ToolAddress.make("executor.coreTools.integrations.list");
      const tools = yield* executor.tools.list({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      const listed = tools.find((toolRow) => toolRow.address === address);
      expect(listed).toMatchObject({
        address,
        integration: IntegrationSlug.make("executor"),
        connection: ConnectionName.make("coreTools"),
        name: ToolName.make("coreTools.integrations.list"),
        static: true,
      });

      const schema = yield* executor.tools.schema(address);
      expect(schema).toMatchObject({
        address,
        name: "coreTools.integrations.list",
        outputSchema: {
          type: "object",
          required: ["integrations"],
        },
      });

      const out = yield* executor.execute(address, {});
      expect(out).toMatchObject({
        integrations: [expect.objectContaining({ slug: "executor" })],
      });
    }),
  );

  it.effect("can omit provider tools from the built-in Executor integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: {
          webBaseUrl: "http://localhost:3000",
          includeProviders: false,
        },
      });

      const tools = yield* executor.tools.list({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      const names = tools.map((toolRow) => String(toolRow.name)).sort();

      expect(names).toContain("coreTools.integrations.list");
      expect(names).not.toContain("coreTools.providers.list");
      expect(names).not.toContain("coreTools.providers.items");
    }),
  );

  it.effect("creates provider-backed connections through the built-in Executor tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      yield* executor.demo.seed();

      const created = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.create"),
        {
          owner: "org",
          name: String(CONN),
          integration: String(INTEG),
          template: String(TEMPLATE),
          identityLabel: "Demo",
          from: { provider: "memory", id: "secret-token" },
        },
      );
      expect(created).toMatchObject({
        owner: "org",
        name: String(CONN),
        integration: String(INTEG),
        template: String(TEMPLATE),
        address: "tools.demo.org.main",
        identityLabel: "Demo",
        oauthClient: null,
      });

      const listed = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.list"),
        { integration: String(INTEG), owner: "org" },
      );
      expect(listed).toMatchObject({
        connections: [expect.objectContaining({ address: "tools.demo.org.main" })],
      });

      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
    }),
  );

  it.effect("settles a member-bound handoff only through explicit exact-ref completion", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: {
          webBaseUrl: "https://executor.example",
          orgSlug: "acme",
          connectionReturnOrigins: ["https://manifest.example"],
        },
      });
      yield* executor.demo.seed();

      // A saved row with the exact future target predates this handoff. Merely
      // observing the handoff must never infer that this old row completed it.
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("avazaDelivery"),
        integration: INTEG,
        template: TEMPLATE,
        value: "real-shaped-pre-existing-credential",
      });

      const handoff = yield* executor.connectionHandoffs.create({
        memberId: "test-subject",
        integration: INTEG,
        template: TEMPLATE,
        label: "Avaza delivery",
        returnTo: "https://manifest.example/os/connections?handoff=github",
      });

      expect(handoff).toMatchObject({
        status: "pending",
        memberId: "test-subject",
        integration: INTEG,
        owner: "user",
        connectionName: "avazaDelivery",
        returnTo: "https://manifest.example/os/connections?handoff=github",
      });
      expect(handoff.handoffId).toMatch(/^handoff_[a-zA-Z0-9_-]+$/);
      expect(handoff.url).toBe(
        `https://executor.example/acme/connect/${encodeURIComponent(handoff.handoffId)}`,
      );
      expect(handoff.url).not.toContain("manifest.example");
      expect(handoff.url).not.toContain("Avaza");

      const pending = yield* executor.connectionHandoffs.observe(handoff.handoffId);
      expect(pending).toEqual(handoff);

      const ref = {
        owner: "user",
        name: ConnectionName.make("avazaDelivery"),
        integration: INTEG,
      } as const;

      const settlementAt = handoff.createdAt + 1_000;
      yield* TestClock.setTime(settlementAt);
      const completed = yield* executor.connectionHandoffs.complete(handoff.handoffId, ref);
      expect(completed).toMatchObject({
        status: "completed",
        receipt: {
          schema: "executor.connection-handoff.receipt.v1",
          handoffId: handoff.handoffId,
          tenant: "test-tenant",
          memberId: "test-subject",
          connection: {
            owner: "user",
            integration: INTEG,
            name: "avazaDelivery",
          },
          readback: { connectionPresent: true },
        },
      });
      expect(completed.receipt.completedAt).toBe(settlementAt);
      expect(completed.receipt.completedAt).toBeGreaterThanOrEqual(handoff.createdAt);
      const duplicate = yield* executor.connectionHandoffs.complete(handoff.handoffId, ref);
      expect(duplicate).toEqual(completed);
      expect(duplicate.receipt).toStrictEqual(completed.receipt);
      expect(yield* executor.connectionHandoffs.read(handoff.handoffId)).toEqual(completed);
    }),
  );

  it.effect("persists one canonical receipt across overlapping completions", () =>
    Effect.gen(function* () {
      const { executor, firstWriteReached } = yield* makeTerminalRaceExecutor();
      yield* executor.demo.seed();
      const handoff = yield* executor.connectionHandoffs.create({
        memberId: "test-subject",
        integration: INTEG,
        template: TEMPLATE,
        label: "Concurrent target",
        returnTo: "https://manifest.example/os/connections",
      });
      yield* executor.connections.create({
        owner: "user",
        integration: INTEG,
        name: handoff.connectionName,
        template: TEMPLATE,
        value: "real-shaped-concurrent-credential",
      });
      const ref = {
        owner: "user",
        integration: INTEG,
        name: handoff.connectionName,
      } as const;
      const firstAt = handoff.createdAt + 1_000;
      const secondAt = handoff.createdAt + 2_000;
      const firstFiber = yield* executor.connectionHandoffs
        .complete(handoff.handoffId, ref)
        .pipe(Effect.provideService(Clock.Clock, fixedClock(firstAt)), Effect.forkChild);

      yield* Effect.promise(() => firstWriteReached);
      const second = yield* executor.connectionHandoffs
        .complete(handoff.handoffId, ref)
        .pipe(Effect.provideService(Clock.Clock, fixedClock(secondAt)));
      const first = yield* Fiber.join(firstFiber);
      const persisted = yield* executor.connectionHandoffs.read(handoff.handoffId);

      expect(first).toStrictEqual(second);
      expect(persisted).toStrictEqual(first);
      expect(first.receipt.completedAt).toBeGreaterThanOrEqual(handoff.createdAt);
      expect([firstAt, secondAt]).toContain(first.receipt.completedAt);
    }),
  );

  it.effect("returns the canonical expiry when expiration wins an overlapping completion", () =>
    Effect.gen(function* () {
      const { executor, firstWriteReached } = yield* makeTerminalRaceExecutor(100, "expired");
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "user",
        integration: INTEG,
        name: ConnectionName.make("expiringRace"),
        template: TEMPLATE,
        value: "real-shaped-expiring-race-credential",
      });
      const handoff = yield* executor.connectionHandoffs.create({
        memberId: "test-subject",
        integration: INTEG,
        template: TEMPLATE,
        label: "Expiring race",
        returnTo: "https://manifest.example/os/connections",
      });
      const ref = {
        owner: "user",
        integration: INTEG,
        name: handoff.connectionName,
      } as const;
      const completionFiber = yield* executor.connectionHandoffs
        .complete(handoff.handoffId, ref)
        .pipe(
          Effect.provideService(Clock.Clock, fixedClock(handoff.createdAt + 50)),
          Effect.result,
          Effect.forkChild,
        );

      yield* Effect.promise(() => firstWriteReached);
      const observed = yield* executor.connectionHandoffs
        .observe(handoff.handoffId)
        .pipe(Effect.provideService(Clock.Clock, fixedClock(handoff.expiresAt)));
      const completion = yield* Fiber.join(completionFiber);
      const persisted = yield* executor.connectionHandoffs.read(handoff.handoffId);

      expect(observed).toMatchObject({ status: "expired" });
      expect(persisted).toStrictEqual(observed);
      expect(completion).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionHandoffExpiredError" },
      });
    }),
  );

  it.effect("returns the canonical completion when completion wins overlapping expiration", () =>
    Effect.gen(function* () {
      const { executor, firstWriteReached } = yield* makeTerminalRaceExecutor(100, "completed");
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "user",
        integration: INTEG,
        name: ConnectionName.make("completionRace"),
        template: TEMPLATE,
        value: "real-shaped-completion-race-credential",
      });
      const handoff = yield* executor.connectionHandoffs.create({
        memberId: "test-subject",
        integration: INTEG,
        template: TEMPLATE,
        label: "Completion race",
        returnTo: "https://manifest.example/os/connections",
      });
      const ref = {
        owner: "user",
        integration: INTEG,
        name: handoff.connectionName,
      } as const;
      const completionFiber = yield* executor.connectionHandoffs
        .complete(handoff.handoffId, ref)
        .pipe(
          Effect.provideService(Clock.Clock, fixedClock(handoff.createdAt + 50)),
          Effect.forkChild,
        );

      yield* Effect.promise(() => firstWriteReached);
      const observed = yield* executor.connectionHandoffs
        .observe(handoff.handoffId)
        .pipe(Effect.provideService(Clock.Clock, fixedClock(handoff.expiresAt)));
      const completed = yield* Fiber.join(completionFiber);
      const persisted = yield* executor.connectionHandoffs.read(handoff.handoffId);

      expect(observed).toMatchObject({ status: "completed" });
      expect(observed).toStrictEqual(completed);
      expect(persisted).toStrictEqual(completed);
    }),
  );

  it.effect("refuses foreign members and non-allowlisted handoff return targets", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: {
          webBaseUrl: "https://executor.example",
          connectionReturnOrigins: ["https://manifest.example"],
        },
      });
      yield* executor.demo.seed();

      const invalidReturn = yield* Effect.result(
        executor.connectionHandoffs.create({
          memberId: "test-subject",
          integration: INTEG,
          label: "GitHub",
          returnTo: "https://attacker.example/steal",
        }),
      );
      expect(invalidReturn).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionHandoffInvalidReturnTargetError" },
      });

      const foreign = yield* executor.connectionHandoffs.create({
        memberId: "user_foreign",
        integration: INTEG,
        label: "GitHub",
        returnTo: "https://manifest.example/os/connections",
      });
      const observed = yield* Effect.result(executor.connectionHandoffs.observe(foreign.handoffId));
      expect(observed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionHandoffMemberMismatchError" },
      });
      const foreignCompletion = yield* Effect.result(
        executor.connectionHandoffs.complete(foreign.handoffId, {
          owner: "user",
          integration: INTEG,
          name: foreign.connectionName,
        }),
      );
      expect(foreignCompletion).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionHandoffMemberMismatchError" },
      });

      const tools = yield* executor.tools.list({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      expect(tools.map((entry) => String(entry.name))).not.toContain(
        "coreTools.connections.createHandoff",
      );
    }),
  );

  it.effect("rejects every mismatched completion ref and an expired handoff", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: {
          webBaseUrl: "https://executor.example",
          connectionReturnOrigins: ["https://manifest.example"],
        },
      });
      yield* executor.demo.seed();
      const handoff = yield* executor.connectionHandoffs.create({
        memberId: "test-subject",
        integration: INTEG,
        label: "Exact target",
        returnTo: "https://manifest.example/os/connections",
      });

      for (const ref of [
        { owner: "org", integration: INTEG, name: handoff.connectionName },
        {
          owner: "user",
          integration: IntegrationSlug.make("other"),
          name: handoff.connectionName,
        },
        { owner: "user", integration: INTEG, name: ConnectionName.make("tampered") },
      ] as const) {
        const result = yield* Effect.result(
          executor.connectionHandoffs.complete(handoff.handoffId, ref),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConnectionHandoffTargetMismatchError" },
        });
      }
      const missingReadback = yield* Effect.result(
        executor.connectionHandoffs.complete(handoff.handoffId, {
          owner: "user",
          integration: INTEG,
          name: handoff.connectionName,
        }),
      );
      expect(missingReadback).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionNotFoundError" },
      });
      expect(yield* executor.connectionHandoffs.observe(handoff.handoffId)).toEqual(handoff);

      const expiringExecutor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: {
          webBaseUrl: "https://executor.example",
          connectionReturnOrigins: ["https://manifest.example"],
          connectionHandoffTtlMs: -1,
        },
      });
      yield* expiringExecutor.demo.seed();
      const expired = yield* expiringExecutor.connectionHandoffs.create({
        memberId: "test-subject",
        integration: INTEG,
        label: "Expired target",
        returnTo: "https://manifest.example/os/connections",
      });
      yield* expiringExecutor.connections.create({
        owner: "user",
        integration: INTEG,
        name: expired.connectionName,
        template: TEMPLATE,
        value: "real-shaped-expired-credential",
      });
      const completion = yield* Effect.result(
        expiringExecutor.connectionHandoffs.complete(expired.handoffId, {
          owner: "user",
          integration: INTEG,
          name: expired.connectionName,
        }),
      );
      expect(completion).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionHandoffExpiredError" },
      });
      expect(yield* expiringExecutor.connectionHandoffs.read(expired.handoffId)).toMatchObject({
        status: "expired",
        receipt: { code: "CONNECTION_HANDOFF_EXPIRED" },
      });
    }),
  );

  it.effect("starts a client-credentials connection through the oauth.start tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const executor = yield* makeTestExecutor({
          plugins: [demoPlugin] as const,
          coreTools: { webBaseUrl: "http://localhost:3000" },
          redirectUri: null,
        });
        yield* executor.demo.seed();

        const client = OAuthClientSlug.make("demo-machine");
        // A confidential client_credentials app carries a secret, so it is
        // registered through the service layer (the browser-handoff path the web
        // UI uses) rather than the agent-facing `oauth.clients.create` tool,
        // which no longer accepts a client secret. The connection still starts
        // through the `oauth.start` tool below.
        const registered = yield* executor.oauth.createClient({
          owner: "org",
          slug: client,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.resourceUrl,
        });
        expect(registered).toEqual(client);

        const started = yield* executor.execute(
          ToolAddress.make("executor.coreTools.oauth.start"),
          {
            client: String(client),
            clientOwner: "org",
            owner: "org",
            name: "oauth",
            integration: String(INTEG),
            template: String(TEMPLATE),
          },
        );
        expect(started).toMatchObject({
          status: "connected",
          connection: {
            owner: "org",
            name: "oauth",
            integration: String(INTEG),
            oauthClient: String(client),
            oauthClientOwner: "org",
          },
        });

        const requests = yield* server.requests;
        const tokenRequest = requests.find(
          (request) =>
            request.path === "/token" && request.body.includes("grant_type=client_credentials"),
        );
        expect(tokenRequest).toBeDefined();
        expect(new URLSearchParams(tokenRequest!.body).get("resource")).toBe(server.resourceUrl);

        const out = yield* executor.execute(ToolAddress.make("tools.demo.org.oauth.run"), {});
        expect(out).toEqual({ ran: "run" });
      }),
    ),
  );

  it.effect("orders integration detection results by confidence", () =>
    Effect.gen(function* () {
      const plugins = [
        detector("low-detector", "low"),
        detector("high-detector", "high"),
        detector("medium-detector", "medium"),
      ] as const;
      const executor = yield* makeTestExecutor({ plugins });
      const results = yield* executor.integrations.detect("https://example.com/thing");
      // Every detector recognizes the URL; the list contains all three.
      expect(results.map((r) => r.kind).sort()).toEqual([
        "high-detector",
        "low-detector",
        "medium-detector",
      ]);
    }),
  );

  it.effect("tools.schema returns roots with shared reachable definitions", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const schema = yield* executor.tools.schema(addr("inspect"));
      expect(schema).not.toBeNull();
      const defs = schema?.schemaDefinitions ?? {};
      // Reachable defs from inspect's input/output are attached; Unused is not.
      expect(Object.keys(defs).sort()).toEqual(["Cat", "Collar", "Dog", "Owner", "Pet"]);
    }),
  );

  it.effect("execute dispatches a connection-produced tool to the owning plugin", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
    }),
  );

  it.effect("resolves complete credential material for a privileged host", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [demoPlugin] as const });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        value: "lease-secret",
      });

      const values = yield* executor.connections.resolveValues({
        owner: "org",
        name: CONN,
        integration: INTEG,
      });
      expect(values).toEqual({ token: "lease-secret" });
    }),
  );

  it.effect("execute on a missing address fails with ToolNotFoundError", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("other"),
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const result = yield* Effect.result(executor.execute(addr("un"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      const error = result.failure;
      expect(Predicate.isTagged(error, "ToolNotFoundError")).toBe(true);
      const suggestions = (error as ToolNotFoundError).suggestions ?? [];
      expect(suggestions).toEqual([addr("run")]);
      expect(
        suggestions.every((suggestion) =>
          String(suggestion).startsWith(`tools.${INTEG}.org.${CONN}.`),
        ),
      ).toBe(true);
    }),
  );
});
