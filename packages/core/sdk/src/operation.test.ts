import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Predicate, Result, Schema } from "effect";

import { ToolResult } from "./tool-result";
import type { ToolProviderEvidence } from "./tool-result";
import { definePlugin, tool } from "./plugin";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  ProviderKey,
  ToolAddress,
} from "./ids";
import {
  EXECUTE_OPERATION_SCHEMA_VERSION,
  ExecuteOperationRequestCodec,
  ExecuteOperationResultCodec,
  canonicalExecuteOperationRequest,
  canonicalOperationJson,
  canonicalizeOperationValue,
  deriveOperationDescriptor,
  hashExecuteOperationRequest,
  hashOperationValue,
  makeInMemoryOperationReplayStore,
  type ExecuteOperationApprovalContext,
  type ExecuteOperationBindingResolver,
  type ExecuteOperationBindingResolverContext,
  type ExecuteOperationDefinition,
  type ExecuteOperationReplayReservation,
  type ExecuteOperationResult,
  type ExecuteOperationRequest,
} from "./operation";
import { createExecutor } from "./executor";
import { StorageError } from "./fuma-runtime";
import {
  GOLDEN_OPERATION_DEFINITION,
  GOLDEN_OPERATION_DESCRIPTOR,
  GOLDEN_OPERATION_DESCRIPTOR_CANONICAL,
  GOLDEN_OPERATION_DESCRIPTOR_SHA256,
  GOLDEN_OPERATION_REQUEST,
  GOLDEN_OPERATION_REQUEST_CANONICAL,
  GOLDEN_OPERATION_REQUEST_SHA256,
  GOLDEN_OPERATION_RESULT,
} from "./operation-fixtures";
import { makeTestConfig, makeTestExecutor } from "./testing";

const descriptorPayloadForTest = (descriptor: typeof GOLDEN_OPERATION_DESCRIPTOR) => ({
  schemaVersion: descriptor.schemaVersion,
  operationKey: descriptor.operationKey,
  version: descriptor.version,
  target: String(descriptor.target),
  providerTransport: descriptor.providerTransport,
  inputSchema: descriptor.inputSchema,
  outputSchema: descriptor.outputSchema,
});

const INPUT = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ value: Schema.String })),
);
const OUTPUT = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ value: Schema.String })),
);
const UNKNOWN = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Unknown));
const TARGET = ToolAddress.make("attestation.echo");
const HTTP_TARGET = ToolAddress.make("attestation-http.echo");

const operationPlugin = definePlugin(() => ({
  id: "attestation" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "attestation",
      kind: "plugin",
      name: "Attestation",
      tools: [
        tool({
          name: "echo",
          description: "Echo a public operation input.",
          inputSchema: INPUT,
          outputSchema: OUTPUT,
          execute: ({ value }) => Effect.succeed({ value }),
        }),
      ],
    },
  ],
}))();

const failingOperationPlugin = definePlugin(() => ({
  id: "attestation-fail" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "attestation-fail",
      kind: "plugin",
      name: "Attestation failure",
      tools: [
        tool({
          name: "fail",
          description: "Return an expected provider failure.",
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
          outputSchema: UNKNOWN,
          execute: () =>
            Effect.succeed(
              ToolResult.fail({
                code: "upstream_bad_request",
                message: "this must never cross the operation boundary",
                status: 400,
              }),
            ),
        }),
      ],
    },
  ],
}))();

const providerOperationPlugin = definePlugin(() => ({
  id: "attestation-http" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "attestation-http",
      kind: "plugin",
      name: "Attestation HTTP",
      tools: [
        tool({
          name: "echo",
          description: "Echo with provider evidence.",
          inputSchema: INPUT,
          outputSchema: OUTPUT,
          execute: ({ value }) =>
            Effect.gen(function* () {
              const data = { value };
              const responseSha256 = yield* hashOperationValue(data);
              return ToolResult.ok(data, {
                provider: {
                  transport: "http",
                  providerRequestSha256: "f".repeat(64),
                  responseSha256,
                  status: 200,
                  observedAt: new Date().toISOString(),
                },
              });
            }),
        }),
      ],
    },
  ],
}))();

const makeProviderEvidencePlugin = (id: string, provider?: ToolProviderEvidence) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id,
        kind: "plugin" as const,
        name: id,
        tools: [
          tool({
            name: "echo",
            description: "Echo with deliberately varied provider evidence.",
            inputSchema: INPUT,
            outputSchema: OUTPUT,
            execute: ({ value }) =>
              Effect.succeed(
                provider ? ToolResult.ok({ value }, { provider }) : ToolResult.ok({ value }),
              ),
          }),
        ],
      },
    ],
  }))();

const providerEvidenceOutputHash =
  "9b2d43affbf49a367028df2e1414f84c0e099ac98c3d54a8a80157fd7771af25";
const providerEvidenceBase = {
  transport: "http" as const,
  responseSha256: providerEvidenceOutputHash,
  status: 200,
  observedAt: "2026-01-01T00:00:00.000Z",
};

const definition = (target: ToolAddress = TARGET, key = "echo"): ExecuteOperationDefinition => ({
  operationKey: key,
  version: 1,
  target,
  inputSchema: INPUT,
  outputSchema: OUTPUT,
  providerTransport: "none",
});

const makeRequest = (operation: ExecuteOperationDefinition, jobId: string, input: unknown) =>
  Effect.gen(function* () {
    const descriptor = yield* deriveOperationDescriptor(operation);
    const unsigned = {
      schemaVersion: EXECUTE_OPERATION_SCHEMA_VERSION,
      operationKey: operation.operationKey,
      version: operation.version,
      jobId,
      descriptorSha256: descriptor.descriptorSha256,
      input,
      requestSha256: "0".repeat(64),
    } satisfies ExecuteOperationRequest;
    const requestSha256 = yield* hashExecuteOperationRequest(unsigned);
    return { ...unsigned, requestSha256 } satisfies ExecuteOperationRequest;
  });

const providerDefinition: ExecuteOperationDefinition = {
  ...definition(HTTP_TARGET, "http-echo"),
  providerTransport: "http",
};

class BindingResolverError extends Error {}

const BOUND_TARGET = ToolAddress.make("attestation-bound.echo");
const BOUND_BINDING_A = "a".repeat(64);
const BOUND_BINDING_B = "b".repeat(64);

const makeBinding = (bindingSha256: string, generation = "generation-a") => ({
  bindingSha256,
  connection: {
    address: ConnectionAddress.make("tools.attestation.org.primary"),
    owner: "org" as const,
    integration: IntegrationSlug.make("attestation"),
    name: ConnectionName.make("primary"),
    credentialProvider: ProviderKey.make("memory"),
    template: AuthTemplateSlug.make("none"),
    generation,
    catalogRevision: "catalog-a",
    sourceTransport: "none" as const,
  },
});

const boundDefinition = (
  bindingResolver: ExecuteOperationBindingResolver,
): ExecuteOperationDefinition => ({
  ...definition(BOUND_TARGET, "bound-echo"),
  bindingMode: "connection",
  bindingKey: "executor.connection",
  bindingVersion: 1,
  bindingResolver,
});

const makeBoundOperationPlugin = (calls: { count: number }) =>
  definePlugin(() => ({
    id: "attestation-bound" as const,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "attestation-bound",
        kind: "plugin" as const,
        name: "Attestation bound",
        tools: [
          tool({
            name: "echo",
            description: "Execute a bound operation.",
            inputSchema: INPUT,
            outputSchema: OUTPUT,
            execute: ({ value }) =>
              Effect.sync(() => {
                calls.count += 1;
                return { value };
              }),
          }),
        ],
      },
    ],
  }))();

describe("carrier-neutral operation attestation", () => {
  it.effect("keeps the exported canonical adapter fixture derived and codec-valid", () =>
    Effect.gen(function* () {
      const descriptor = yield* deriveOperationDescriptor(GOLDEN_OPERATION_DEFINITION);
      expect(descriptor).toEqual(GOLDEN_OPERATION_DESCRIPTOR);
      expect(descriptor.descriptorSha256).toBe(GOLDEN_OPERATION_DESCRIPTOR_SHA256);
      expect(yield* canonicalOperationJson(descriptorPayloadForTest(descriptor))).toBe(
        GOLDEN_OPERATION_DESCRIPTOR_CANONICAL,
      );
      expect(yield* canonicalExecuteOperationRequest(GOLDEN_OPERATION_REQUEST)).toBe(
        GOLDEN_OPERATION_REQUEST_CANONICAL,
      );
      expect(yield* hashExecuteOperationRequest(GOLDEN_OPERATION_REQUEST)).toBe(
        GOLDEN_OPERATION_REQUEST_SHA256,
      );
      expect(ExecuteOperationRequestCodec.decodeSync(GOLDEN_OPERATION_REQUEST)).toEqual(
        GOLDEN_OPERATION_REQUEST,
      );
      expect(ExecuteOperationResultCodec.decodeSync(GOLDEN_OPERATION_RESULT)).toEqual(
        GOLDEN_OPERATION_RESULT,
      );
    }),
  );

  it.effect("refuses to start an operation registry without an explicit replay store", () =>
    Effect.gen(function* () {
      const operation = definition();
      const startup = yield* Effect.result(
        makeTestExecutor({
          plugins: [operationPlugin] as const,
          operations: [operation],
          operationReplayStore: null,
        }),
      );
      expect(
        Result.match(startup, {
          onFailure: (failure) => Predicate.isTagged(failure, "StorageError"),
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("refuses a process-local replay store without the local-only opt-in", () =>
    Effect.gen(function* () {
      const operation = definition();
      const config = makeTestConfig({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const startup = yield* Effect.result(
        createExecutor({ ...config, allowProcessLocalOperationReplayStore: false }),
      );
      expect(
        Result.match(startup, {
          onFailure: (failure) => Predicate.isTagged(failure, "StorageError"),
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("canonicalizes strict JSON, permits repeated refs, and rejects cycles/accessors", () =>
    Effect.gen(function* () {
      const repeated = { value: "same" };
      const snapshot = yield* canonicalizeOperationValue({ a: repeated, b: repeated });
      expect(snapshot.canonical).toBe('{"a":{"value":"same"},"b":{"value":"same"}}');
      expect(yield* canonicalOperationJson(Array.from({ length: 12 }, (_, index) => index))).toBe(
        "[0,1,2,3,4,5,6,7,8,9,10,11]",
      );

      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      const cycleResult = yield* Effect.result(canonicalizeOperationValue(cycle));
      expect(
        Result.match(cycleResult, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") && failure.reason === "cycle",
          onSuccess: () => false,
        }),
      ).toBe(true);

      const accessor = Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => "side effect",
      });
      const accessorResult = yield* Effect.result(canonicalizeOperationValue(accessor));
      expect(
        Result.match(accessorResult, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.reason === "accessor_property",
          onSuccess: () => false,
        }),
      ).toBe(true);

      const arrayWithExtraKey = ["value"] as unknown[] & { extra?: string };
      arrayWithExtraKey.extra = "must-not-disappear";
      const arrayResult = yield* Effect.result(canonicalizeOperationValue(arrayWithExtraKey));
      expect(Result.isFailure(arrayResult)).toBe(true);
    }),
  );

  it.effect("turns revoked proxy reflection traps into typed contract failures", () =>
    Effect.gen(function* () {
      const revoked = Proxy.revocable({ value: "secret" }, {});
      revoked.revoke();
      const result = yield* Effect.result(canonicalizeOperationValue(revoked.proxy));
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.reason === "invalid_value",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("executes the reviewed registry target and returns an attested result", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-success", { value: "hello" });
      const result = yield* executor.executeOperation(request, "http");

      expect(result.status).toBe("completed");
      expect(result.target).toBe(TARGET);
      expect(result.policy.decision).toBe("allow");
      expect(result.approval.decision).toBe("not_required");
      expect(result.providerReconciliation.status).toBe("not_attempted");
      expect(result.output).toEqual({ value: "hello" });
      expect(result.failure).toBeUndefined();
    }),
  );

  it.effect("gives operation handlers a capability-scoped plugin context", () =>
    Effect.gen(function* () {
      let ambientCapabilities = false;
      let ownerMutable = false;
      let ambientKey = false;
      let symbolMutable = false;
      let accessorMutable = false;
      const scopedPlugin = definePlugin(() => ({
        id: "attestation-scoped-context" as const,
        storage: () => ({
          getValue: () => "readable",
          putValue: () => "must-not-be exposed",
        }),
        staticIntegrations: () => [
          {
            id: "attestation-scoped-context",
            kind: "plugin" as const,
            name: "Scoped context",
            tools: [
              tool({
                name: "echo",
                description: "Scoped operation target.",
                inputSchema: INPUT,
                outputSchema: OUTPUT,
                execute: ({ value }, context) =>
                  Effect.sync(() => {
                    const storage = context.ctx.storage;
                    const storageHasMutation =
                      typeof storage === "object" &&
                      storage !== null &&
                      (Reflect.get(storage, "putValue") !== undefined ||
                        Reflect.get(storage, "appendOperations") !== undefined);
                    ownerMutable = Reflect.set(context.ctx.owner, "tenant", "redirected");
                    symbolMutable = Reflect.set(context.ctx, Symbol("ambient"), "redirected");
                    accessorMutable = Reflect.defineProperty(context.ctx, "storage", {
                      get: () => ({ appendOperations: () => undefined }),
                    });
                    expect(Object.getPrototypeOf(context.ctx)).toBe(null);
                    expect(Object.getPrototypeOf(context.ctx.owner)).toBe(null);
                    ambientKey = Reflect.ownKeys(context.ctx).some((key) =>
                      [
                        "storage",
                        "pluginStorage",
                        "core",
                        "connections",
                        "providers",
                        "oauth",
                        "execute",
                        "transaction",
                      ].includes(String(key)),
                    );
                    ambientCapabilities =
                      context.ctx.connections !== undefined ||
                      context.ctx.providers !== undefined ||
                      context.ctx.execute !== undefined ||
                      context.ctx.transaction !== undefined ||
                      context.ctx.pluginStorage !== undefined ||
                      storageHasMutation ||
                      !Object.isFrozen(context.ctx.owner);
                    return { value };
                  }),
              }),
            ],
          },
        ],
      }))();
      const operation = definition(
        ToolAddress.make("attestation-scoped-context.echo"),
        "scoped-context",
      );
      const executor = yield* makeTestExecutor({
        plugins: [scopedPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-scoped-context", { value: "scoped" });
      const result = yield* executor.executeOperation(request, "http");
      expect(result.status).toBe("completed");
      expect(ambientCapabilities).toBe(false);
      expect(ownerMutable).toBe(false);
      expect(ambientKey).toBe(false);
      expect(symbolMutable).toBe(false);
      expect(accessorMutable).toBe(false);
    }),
  );

  it.effect("atomically replays the same job and rejects a different request hash", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-replay", { value: "one" });
      const first = yield* executor.executeOperation(request, "http");
      const replay = yield* executor.executeOperation(request, "mcp");
      expect(replay).toEqual({
        ...first,
        carrier: "mcp",
        approval: { ...first.approval, carrier: "mcp" },
      });

      const changed = yield* makeRequest(operation, "job-replay", { value: "two" });
      const mismatch = yield* Effect.result(executor.executeOperation(changed, "http"));
      expect(
        Result.match(mismatch, {
          onFailure: (failure) => Predicate.isTagged(failure, "OperationRequestHashMismatchError"),
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("rejects an unbound replay after its effective policy changes", () =>
    Effect.gen(function* () {
      const operation = definition(TARGET, "unbound-policy-replay");
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-unbound-policy-replay", {
        value: "policy",
      });
      const first = yield* executor.executeOperation(request, "http");
      expect(first.status).toBe("completed");
      yield* executor.policies.create({
        owner: "org",
        pattern: String(operation.target),
        action: "block",
      });
      const replay = yield* Effect.result(executor.executeOperation(request, "mcp"));
      expect(
        Result.match(replay, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "binding.replay.policy" &&
            failure.reason === "invalid_value",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("uses a collision-free tenant/job replay key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryOperationReplayStore();
      const first = yield* store.reserve({
        tenant: "tenant:one",
        jobId: "job",
        requestSha256: "1".repeat(64),
      });
      const second = yield* store.reserve({
        tenant: "tenant",
        jobId: "one:job",
        requestSha256: "2".repeat(64),
      });
      expect(first.status).toBe("reserved");
      expect(second.status).toBe("reserved");
    }),
  );

  it.effect("rejects a stale reservation settlement instead of returning success", () =>
    Effect.gen(function* () {
      const operation = definition();
      const inner = makeInMemoryOperationReplayStore();
      const staleStore = {
        ...inner,
        settle: () => Effect.succeed("stale" as const),
      };
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationReplayStore: staleStore,
      });
      const request = yield* makeRequest(operation, "job-stale-settle", { value: "stale" });
      const result = yield* Effect.result(executor.executeOperation(request, "http"));
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.reason === "stale_reservation",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("settles a reservation after a policy-store defect so retry is not stuck", () =>
    Effect.gen(function* () {
      const policyDefectPlugin = definePlugin(() => ({
        id: "attestation-policy-defect" as const,
        storage: () => ({}),
        toolPolicyProvider: () => ({
          list: () =>
            // oxlint-disable-next-line executor/no-effect-escape-hatch, executor/no-error-constructor -- adversarial defect regression
            Effect.die(new Error("https://provider.invalid/?token=policy-sentinel")),
        }),
        staticIntegrations: () => [
          {
            id: "attestation-policy-defect",
            kind: "plugin" as const,
            name: "Policy defect",
            tools: [
              tool({
                name: "echo",
                description: "Policy defect target.",
                inputSchema: INPUT,
                outputSchema: OUTPUT,
                execute: ({ value }) => Effect.succeed({ value }),
              }),
            ],
          },
        ],
      }))();
      const operation = definition(
        ToolAddress.make("attestation-policy-defect.echo"),
        "policy-defect",
      );
      const executor = yield* makeTestExecutor({
        plugins: [policyDefectPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-policy-defect", { value: "policy" });
      const first = yield* Effect.result(executor.executeOperation(request, "http"));
      expect(Result.isFailure(first)).toBe(true);
      const retry = yield* executor.executeOperation(request, "mcp");
      expect(retry.status).toBe("cancelled");
      expect(retry.failure?.code).toBe("operation_cancelled");
    }),
  );

  it.effect("settles a reservation after an approval-handler defect so retry is not stuck", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        // oxlint-disable-next-line executor/no-effect-escape-hatch, executor/no-error-constructor -- adversarial defect regression
        operationApproval: () => Effect.die(new Error("approval token sentinel")),
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: "attestation.echo",
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-approval-defect", { value: "approval" });
      const first = yield* Effect.result(executor.executeOperation(request, "http"));
      expect(
        Result.match(first, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "approval.handler",
          onSuccess: () => false,
        }),
      ).toBe(true);
      const retry = yield* executor.executeOperation(request, "mcp");
      expect(retry.status).toBe("cancelled");
    }),
  );

  it.effect("normalizes a provider defect and leaves a replayable terminal result", () =>
    Effect.gen(function* () {
      const defectPlugin = definePlugin(() => ({
        id: "attestation-provider-defect" as const,
        storage: () => ({}),
        staticIntegrations: () => [
          {
            id: "attestation-provider-defect",
            kind: "plugin" as const,
            name: "Provider defect",
            tools: [
              tool({
                name: "echo",
                description: "Provider defect target.",
                inputSchema: INPUT,
                outputSchema: OUTPUT,
                execute: () =>
                  // oxlint-disable-next-line executor/no-error-constructor -- adversarial defect regression
                  Effect.die(new Error("https://provider.invalid/?token=provider-sentinel")),
              }),
            ],
          },
        ],
      }))();
      const operation = definition(
        ToolAddress.make("attestation-provider-defect.echo"),
        "provider-defect",
      );
      const executor = yield* makeTestExecutor({
        plugins: [defectPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-provider-defect", { value: "provider" });
      const first = yield* executor.executeOperation(request, "http");
      expect(first.status).toBe("failed");
      expect(first.failure?.code).toBe("operation_failed");
      expect(JSON.stringify(first)).not.toContain("provider-sentinel");
      const retry = yield* executor.executeOperation(request, "mcp");
      expect(retry.status).toBe("failed");
    }),
  );

  it.effect("normalizes a synchronous provider throw without exposing its message", () =>
    Effect.gen(function* () {
      const syncThrowPlugin = definePlugin(() => ({
        id: "attestation-sync-throw" as const,
        storage: () => ({}),
        staticIntegrations: () => [
          {
            id: "attestation-sync-throw",
            kind: "plugin" as const,
            name: "Synchronous provider throw",
            tools: [
              {
                name: "echo",
                description: "Synchronous provider throw target.",
                inputSchema: INPUT,
                outputSchema: OUTPUT,
                handler: () => {
                  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- adversarial defect regression
                  throw new Error("https://provider.invalid/?access_token=sync-sentinel");
                },
              },
            ],
          },
        ],
      }))();
      const operation = definition(ToolAddress.make("attestation-sync-throw.echo"), "sync-throw");
      const executor = yield* makeTestExecutor({
        plugins: [syncThrowPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-sync-throw", { value: "sync" });
      const result = yield* executor.executeOperation(request, "http");
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("sync-sentinel");
    }),
  );

  it.effect("retries settlement after a transient store failure", () =>
    Effect.gen(function* () {
      const inner = makeInMemoryOperationReplayStore();
      let settleCalls = 0;
      const flakyStore = {
        ...inner,
        settle: (input: Parameters<typeof inner.settle>[0]) => {
          settleCalls += 1;
          return settleCalls === 1
            ? Effect.fail(new StorageError({ message: "settlement unavailable", cause: undefined }))
            : inner.settle(input);
        },
      };
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationReplayStore: flakyStore,
      });
      const request = yield* makeRequest(operation, "job-settlement-failure", { value: "settle" });
      const first = yield* Effect.result(executor.executeOperation(request, "http"));
      expect(Result.isFailure(first)).toBe(true);
      expect(settleCalls).toBeGreaterThanOrEqual(2);
      const retry = yield* executor.executeOperation(request, "mcp");
      expect(retry.status).toBe("cancelled");
    }),
  );

  it.effect("decodes and rebinds replay results before returning them", () =>
    Effect.gen(function* () {
      const operation = definition();
      const inner = makeInMemoryOperationReplayStore();
      let settled: ExecuteOperationResult | undefined;
      const replayStore = {
        ...inner,
        reserve: (input: Parameters<typeof inner.reserve>[0]) =>
          settled
            ? Effect.succeed({
                status: "replay" as const,
                result: { ...settled, target: ToolAddress.make("attestation.evil") },
              })
            : inner.reserve(input),
        settle: (input: Parameters<typeof inner.settle>[0]) => {
          settled = input.result;
          return inner.settle(input);
        },
      };
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationReplayStore: replayStore,
      });
      const request = yield* makeRequest(operation, "job-tampered-replay", { value: "replay" });
      yield* executor.executeOperation(request, "http");
      const replay = yield* Effect.result(executor.executeOperation(request, "mcp"));
      expect(
        Result.match(replay, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "result.binding",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("rejects accessor and proxy replay results before reading nested fields", () =>
    Effect.gen(function* () {
      const operation = definition(ToolAddress.make("attestation-replay-trap.echo"), "replay-trap");
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-replay-accessor", { value: "trap" });
      const first = yield* executor.executeOperation(request, "http");
      let getterCalls = 0;
      const accessorResult = Object.defineProperty({ ...first }, "policy", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return first.policy;
        },
      });
      const accessorReservation = (
        result: ExecuteOperationResult,
      ): ExecuteOperationReplayReservation => ({
        status: "replay",
        result,
      });
      const accessorStore = {
        ...makeInMemoryOperationReplayStore(),
        reserve: () => Effect.succeed(accessorReservation(accessorResult)),
      };
      const accessorExecutor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationReplayStore: accessorStore,
      });
      const accessorReplay = yield* Effect.result(
        accessorExecutor.executeOperation(request, "mcp"),
      );
      expect(getterCalls).toBe(0);
      expect(
        Result.match(accessorReplay, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "result" &&
            failure.reason === "invalid_value",
          onSuccess: () => false,
        }),
      ).toBe(true);

      const revoked = Proxy.revocable({ ...first }, {});
      revoked.revoke();
      const proxyStore = {
        ...makeInMemoryOperationReplayStore(),
        reserve: () => Effect.succeed(accessorReservation(revoked.proxy)),
      };
      const proxyExecutor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationReplayStore: proxyStore,
      });
      const proxyReplay = yield* Effect.result(proxyExecutor.executeOperation(request, "mcp"));
      expect(
        Result.match(proxyReplay, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "result" &&
            failure.reason === "invalid_value",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("does not lose a reservation if interruption races reserve completion", () =>
    Effect.gen(function* () {
      const inner = makeInMemoryOperationReplayStore();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const racingStore = {
        ...inner,
        reserve: (input: Parameters<typeof inner.reserve>[0]) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* inner.reserve(input);
          }),
      };
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationReplayStore: racingStore,
      });
      const request = yield* makeRequest(operation, "job-reserve-race", { value: "race" });
      const fiber = yield* executor
        .executeOperation(request, "http")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const interruption = Fiber.interrupt(fiber);
      yield* Deferred.succeed(release, undefined);
      yield* interruption;
      const replay = yield* executor.executeOperation(request, "mcp");
      expect(replay.status).toBe("cancelled");
    }),
  );

  it.effect("rejects replay authorization bound to a different subject", () =>
    Effect.gen(function* () {
      const inner = makeInMemoryOperationReplayStore();
      const captureStore = {
        ...inner,
        settle: (input: Parameters<typeof inner.settle>[0]) => inner.settle(input),
      };
      const operation = definition();
      const firstExecutor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        subject: "subject-one",
        operationReplayStore: captureStore,
      });
      const request = yield* makeRequest(operation, "job-subject-binding", { value: "subject" });
      const completed = yield* firstExecutor.executeOperation(request, "http");
      const replayStore = {
        ...captureStore,
        reserve: () => Effect.succeed({ status: "replay" as const, result: completed }),
      };
      const secondExecutor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        subject: "subject-two",
        operationReplayStore: replayStore,
      });
      const replay = yield* Effect.result(secondExecutor.executeOperation(request, "mcp"));
      expect(
        Result.match(replay, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "result.approval",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("rejects corrupt approval state and session on replay", () =>
    Effect.gen(function* () {
      const inner = makeInMemoryOperationReplayStore();
      const captureStore = {
        ...inner,
        settle: (input: Parameters<typeof inner.settle>[0]) => inner.settle(input),
      };
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationReplayStore: captureStore,
        operationApproval: () => Effect.succeed("approved" as const),
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: "attestation.echo",
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-approval-binding", { value: "approval" });
      const completed = yield* executor.executeOperation(request, "http");
      expect(completed.status).toBe("completed");
      const { decidedAt: _decidedAt, ...approvalWithoutDecisionTime } = completed.approval;
      const corruptions = [
        {
          ...completed,
          approval: { ...completed.approval, decision: "not_required" as const },
        },
        {
          ...completed,
          approval: { ...completed.approval, sessionId: "approval:wrong-execution" },
        },
        {
          ...completed,
          approval: approvalWithoutDecisionTime,
        },
      ];
      for (const corrupted of corruptions) {
        const replayStore = {
          ...captureStore,
          reserve: () => Effect.succeed({ status: "replay" as const, result: corrupted }),
        };
        const replayExecutor = yield* makeTestExecutor({
          plugins: [operationPlugin] as const,
          operations: [operation],
          operationApproval: () => Effect.succeed("approved" as const),
          operationReplayStore: replayStore,
        });
        const replay = yield* Effect.result(replayExecutor.executeOperation(request, "mcp"));
        expect(
          Result.match(replay, {
            onFailure: (failure) =>
              Predicate.isTagged(failure, "OperationContractError") &&
              (failure.field === "result.approval" ||
                failure.field === "result.binding" ||
                failure.field === "result.state"),
            onSuccess: () => false,
          }),
        ).toBe(true);
      }
    }),
  );

  it.effect("rejects secret-shaped provider evidence read from replay", () =>
    Effect.gen(function* () {
      const inner = makeInMemoryOperationReplayStore();
      let settled: ExecuteOperationResult | undefined;
      const replayStore = {
        ...inner,
        reserve: (input: Parameters<typeof inner.reserve>[0]) => {
          if (!settled) return inner.reserve(input);
          return Effect.succeed({
            status: "replay" as const,
            result: {
              ...settled,
              providerReconciliation: {
                ...settled.providerReconciliation,
                ...(settled.providerReconciliation.receipt
                  ? {
                      receipt: {
                        ...settled.providerReconciliation.receipt,
                        requestId: "AKIA-replayed-secret",
                      },
                    }
                  : {}),
              },
            },
          });
        },
        settle: (input: Parameters<typeof inner.settle>[0]) => {
          settled = input.result;
          return inner.settle(input);
        },
      };
      const executor = yield* makeTestExecutor({
        plugins: [providerOperationPlugin] as const,
        operations: [providerDefinition],
        operationReplayStore: replayStore,
      });
      const request = yield* makeRequest(providerDefinition, "job-replay-provider", {
        value: "replay",
      });
      yield* executor.executeOperation(request, "http");
      const replay = yield* Effect.result(executor.executeOperation(request, "mcp"));
      expect(
        Result.match(replay, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "result.providerReconciliation.receipt",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("rejects impossible policy, approval, status, and failure combinations", () =>
    Effect.gen(function* () {
      const inner = makeInMemoryOperationReplayStore();
      const captureStore = {
        ...inner,
        settle: (input: Parameters<typeof inner.settle>[0]) => {
          return inner.settle(input);
        },
      };
      const operation = definition(
        ToolAddress.make("attestation-state-matrix.echo"),
        "state-matrix",
      );
      const plugin = definePlugin(() => ({
        id: "attestation-state-matrix" as const,
        storage: () => ({}),
        staticIntegrations: () => [
          {
            id: "attestation-state-matrix",
            kind: "plugin" as const,
            name: "State matrix",
            tools: [
              tool({
                name: "echo",
                description: "State matrix operation target.",
                inputSchema: INPUT,
                outputSchema: OUTPUT,
                execute: ({ value }) => Effect.succeed({ value }),
              }),
            ],
          },
        ],
      }))();
      const executor = yield* makeTestExecutor({
        plugins: [plugin] as const,
        operations: [operation],
        operationReplayStore: captureStore,
      });
      const request = yield* makeRequest(operation, "job-state-matrix", { value: "matrix" });
      const completed = yield* executor.executeOperation(request, "http");
      expect(completed.status).toBe("completed");
      const { output: _output, ...withoutOutput } = completed;
      const corruptions: readonly ExecuteOperationResult[] = [
        {
          ...withoutOutput,
          status: "failed",
          outputSha256: null,
          approval: { ...completed.approval, decision: "approved" },
          failure: { code: "operation_failed", retryable: false },
        },
        {
          ...withoutOutput,
          status: "blocked",
          outputSha256: null,
          approval: { ...completed.approval, decision: "declined" },
          failure: { code: "approval_declined", retryable: false },
        },
        {
          ...withoutOutput,
          status: "blocked",
          outputSha256: null,
          approval: { ...completed.approval, decision: "not_required" },
          failure: { code: "approval_declined", retryable: false },
        },
      ];
      for (const corrupted of corruptions) {
        const replayStore = {
          ...captureStore,
          reserve: () => Effect.succeed({ status: "replay" as const, result: corrupted }),
        };
        const replayExecutor = yield* makeTestExecutor({
          plugins: [plugin] as const,
          operations: [operation],
          operationReplayStore: replayStore,
        });
        const replay = yield* Effect.result(replayExecutor.executeOperation(request, "mcp"));
        expect(
          Result.match(replay, {
            onFailure: (failure) =>
              Predicate.isTagged(failure, "OperationContractError") &&
              failure.field === "result.state",
            onSuccess: () => false,
          }),
        ).toBe(true);
      }
    }),
  );

  it.effect("rejects a concurrent replay while the first reservation is in progress", () =>
    Effect.gen(function* () {
      let calls = 0;
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const concurrentPlugin = definePlugin(() => ({
        id: "attestation-concurrent" as const,
        storage: () => ({}),
        staticIntegrations: () => [
          {
            id: "attestation-concurrent",
            kind: "plugin" as const,
            name: "Attestation concurrent",
            tools: [
              tool({
                name: "echo",
                description: "Wait for concurrent replay test.",
                inputSchema: INPUT,
                outputSchema: OUTPUT,
                execute: ({ value }) =>
                  Effect.gen(function* () {
                    calls += 1;
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(gate);
                    return { value };
                  }),
              }),
            ],
          },
        ],
      }))();
      const operation = definition(
        ToolAddress.make("attestation-concurrent.echo"),
        "concurrent-echo",
      );
      const executor = yield* makeTestExecutor({
        plugins: [concurrentPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-concurrent", { value: "one" });
      const firstFiber = yield* executor
        .executeOperation(request, "http")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const second = yield* Effect.result(executor.executeOperation(request, "mcp"));
      expect(
        Result.match(second, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.reason === "replay_in_progress",
          onSuccess: () => false,
        }),
      ).toBe(true);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(firstFiber);
      expect(calls).toBe(1);
    }),
  );

  it.effect("settles an interrupted reservation as a typed cancelled replay", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const plugin = definePlugin(() => ({
        id: "attestation-cancel" as const,
        storage: () => ({}),
        staticIntegrations: () => [
          {
            id: "attestation-cancel",
            kind: "plugin" as const,
            name: "Attestation cancellation",
            tools: [
              tool({
                name: "echo",
                description: "Wait for cancellation.",
                inputSchema: INPUT,
                outputSchema: OUTPUT,
                execute: ({ value }) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(gate);
                    return { value };
                  }),
              }),
            ],
          },
        ],
      }))();
      const operation = definition(ToolAddress.make("attestation-cancel.echo"), "cancel-echo");
      const executor = yield* makeTestExecutor({
        plugins: [plugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-cancel", { value: "cancel" });
      const fiber = yield* executor
        .executeOperation(request, "http")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const replay = yield* executor.executeOperation(request, "mcp");
      expect(replay.status).toBe("cancelled");
      expect(replay.failure).toMatchObject({ code: "operation_cancelled" });
      expect(replay.carrier).toBe("mcp");
    }),
  );

  it.effect("fails closed for a policy-gated operation without an explicit grant adapter", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: "attestation.echo",
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-approval", { value: "wait" });
      const result = yield* executor.executeOperation(request, "http");
      expect(result.status).toBe("blocked");
      expect(result.approval.decision).toBe("declined");
      expect(result.failure).toMatchObject({ code: "approval_handler_required" });
      expect(result.providerReconciliation.status).toBe("not_attempted");
    }),
  );

  it.effect("rejects an approval adapter result outside the public decision vocabulary", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationApproval: () => Effect.succeed("unexpected" as never),
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: "attestation.echo",
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-invalid-approval", { value: "bad" });
      const result = yield* Effect.result(executor.executeOperation(request, "http"));
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "approval.decision" &&
            failure.reason === "invalid_value",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("binds an explicit approval grant to the immutable execution context", () =>
    Effect.gen(function* () {
      const operation = definition();
      let approvalContext:
        | {
            readonly executionId: string;
            readonly jobId: string;
            readonly requestSha256: string;
            readonly descriptorSha256: string;
            readonly operationKey: string;
            readonly target: ToolAddress;
            readonly sessionId: string;
          }
        | undefined;
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationApproval: (context) =>
          Effect.sync(() => {
            approvalContext = context;
            return "approved" as const;
          }),
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: "attestation.echo",
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-approved", { value: "grant" });
      const result = yield* executor.executeOperation(request, "http");
      expect(result.status).toBe("completed");
      expect(result.approval.decision).toBe("approved");
      expect(approvalContext).toMatchObject({
        tenant: "test-tenant",
        jobId: request.jobId,
        requestSha256: request.requestSha256,
        descriptorSha256: request.descriptorSha256,
        operationKey: request.operationKey,
        target: TARGET,
        providerTransport: "none",
        carrier: "http",
        policy: {
          decision: "require_approval",
          source: "user",
          pattern: "attestation.echo",
        },
      });
      expect(approvalContext?.executionId).toBe(result.executionId);
      expect(approvalContext?.sessionId).toBe(result.approval.sessionId);
    }),
  );

  it.effect("freezes approval context and its nested policy at runtime", () =>
    Effect.gen(function* () {
      let approvalContext: ExecuteOperationApprovalContext | undefined;
      let contextMutation = true;
      let policyMutation = true;
      const operation = definition(TARGET, "frozen");
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
        operationApproval: (context) =>
          Effect.sync(() => {
            approvalContext = context;
            contextMutation = Reflect.set(context, "tenant", "attacker");
            policyMutation = Reflect.set(context.policy, "pattern", "attacker");
            return "approved" as const;
          }),
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: String(operation.target),
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-frozen-approval", { value: "frozen" });
      const result = yield* executor.executeOperation(request, "http");
      expect(result.status).toBe("completed");
      expect(approvalContext).toBeDefined();
      if (!approvalContext) return;
      expect(Object.isFrozen(approvalContext)).toBe(true);
      expect(Object.isFrozen(approvalContext.policy)).toBe(true);
      expect(contextMutation).toBe(false);
      expect(policyMutation).toBe(false);
      expect(approvalContext.tenant).toBe("test-tenant");
      expect(approvalContext.policy.pattern).toBe(String(operation.target));
    }),
  );

  it.effect("never invokes a provider after a bound approval decline or cancel", () =>
    Effect.gen(function* () {
      for (const [index, decision] of (["declined", "cancelled"] as const).entries()) {
        let calls = 0;
        const id = `attestation-approval-${decision}`;
        const plugin = definePlugin(() => ({
          id,
          storage: () => ({}),
          staticIntegrations: () => [
            {
              id,
              kind: "plugin" as const,
              name: id,
              tools: [
                tool({
                  name: "echo",
                  description: "Approval boundary test.",
                  inputSchema: INPUT,
                  outputSchema: OUTPUT,
                  execute: ({ value }) =>
                    Effect.sync(() => {
                      calls += 1;
                      return { value };
                    }),
                }),
              ],
            },
          ],
        }))();
        const operation = definition(ToolAddress.make(`${id}.echo`), `approval-${decision}`);
        const executor = yield* makeTestExecutor({
          plugins: [plugin] as const,
          operations: [operation],
          operationApproval: () => Effect.succeed(decision),
        });
        yield* executor.policies.create({
          owner: "org",
          pattern: String(operation.target),
          action: "require_approval",
        });
        const request = yield* makeRequest(operation, `job-approval-${index}`, { value: decision });
        const result = yield* executor.executeOperation(request, "http");
        expect(result.status).toBe(decision === "cancelled" ? "cancelled" : "blocked");
        expect(result.approval.decision).toBe(decision);
        expect(result.providerReconciliation.status).toBe("not_attempted");
        expect(calls).toBe(0);
      }
    }),
  );

  it.effect("classifies ToolResult.fail as failed and strips its message", () =>
    Effect.gen(function* () {
      const operation: ExecuteOperationDefinition = {
        operationKey: "fail",
        version: 1,
        target: ToolAddress.make("attestation-fail.fail"),
        inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
        outputSchema: UNKNOWN,
        providerTransport: "none",
      };
      const executor = yield* makeTestExecutor({
        plugins: [failingOperationPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-failure", {});
      const result = yield* executor.executeOperation(request, "mcp");
      expect(result.status).toBe("failed");
      expect(result.failure).toMatchObject({ code: "upstream_bad_request", status: 400 });
      expect(result.failure).not.toHaveProperty("message");
      expect(result.output).toBeUndefined();
    }),
  );

  it.effect(
    "attests a concrete provider receipt when the adapter supplies the shared evidence",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor({
          plugins: [providerOperationPlugin] as const,
          operations: [providerDefinition],
        });
        const request = yield* makeRequest(providerDefinition, "job-provider", { value: "hello" });
        const result = yield* executor.executeOperation(request, "http");
        expect(result.status).toBe("completed");
        expect(result.providerReconciliation.status).toBe("matched");
        expect(result.providerReconciliation.receipt).toMatchObject({
          transport: "http",
          status: 200,
          operationRequestSha256: request.requestSha256,
          providerRequestSha256: "f".repeat(64),
        });
        expect(result.output).toEqual({ value: "hello" });
      }),
  );

  it.effect("fails closed for missing or mismatched provider evidence", () =>
    Effect.gen(function* () {
      const wrongHash = "f".repeat(64);
      const cases: ReadonlyArray<{
        readonly id: string;
        readonly provider?: ToolProviderEvidence;
        readonly expected: "unavailable" | "mismatch";
      }> = [
        { id: "provider-missing", expected: "unavailable" },
        {
          id: "provider-transport",
          provider: { ...providerEvidenceBase, transport: "graphql" },
          expected: "mismatch",
        },
        {
          id: "provider-request",
          provider: { ...providerEvidenceBase, providerRequestSha256: wrongHash },
          expected: "mismatch",
        },
        {
          id: "provider-response",
          provider: { ...providerEvidenceBase, responseSha256: wrongHash },
          expected: "mismatch",
        },
        {
          id: "provider-leak",
          provider: { ...providerEvidenceBase, requestId: "Bearer leaked-provider-token" },
          expected: "unavailable",
        },
        {
          id: "provider-oversized",
          provider: { ...providerEvidenceBase, requestId: "x".repeat(257) },
          expected: "unavailable",
        },
        {
          id: "provider-status-out-of-range",
          provider: { ...providerEvidenceBase, status: 700 },
          expected: "unavailable",
        },
        {
          id: "provider-observed-at-oversized",
          provider: { ...providerEvidenceBase, observedAt: "x".repeat(65) },
          expected: "unavailable",
        },
        {
          id: "provider-github-pat",
          provider: { ...providerEvidenceBase, requestId: "ghp_secret-shaped-value" },
          expected: "unavailable",
        },
        {
          id: "provider-aws-observed-at",
          provider: {
            ...providerEvidenceBase,
            observedAt: "AWS_ACCESS_KEY_ID=AKIA-secret-value",
          },
          expected: "unavailable",
        },
        {
          id: "provider-access-key-observed-at",
          provider: { ...providerEvidenceBase, observedAt: "access_key=secret-value" },
          expected: "unavailable",
        },
        {
          id: "provider-admin-key-observed-at",
          provider: { ...providerEvidenceBase, observedAt: "admin_key=secret-value" },
          expected: "unavailable",
        },
      ];
      for (const [index, scenario] of cases.entries()) {
        const operation: ExecuteOperationDefinition = {
          ...definition(ToolAddress.make(`${scenario.id}.echo`), scenario.id),
          providerTransport: "http",
        };
        const executor = yield* makeTestExecutor({
          plugins: [makeProviderEvidencePlugin(scenario.id, scenario.provider)] as const,
          operations: [operation],
        });
        const request = yield* makeRequest(operation, `job-provider-negative-${index}`, {
          value: "hello",
        });
        const result = yield* executor.executeOperation(request, "http");
        expect(result.status).toBe("failed");
        expect(result.output).toBeUndefined();
        expect(result.providerReconciliation.status).toBe(scenario.expected);
      }
    }),
  );

  it.effect("does not mark informational or redirect responses as matched", () =>
    Effect.gen(function* () {
      const responseSha256 = yield* hashOperationValue({ value: "hello" });
      for (const [index, status] of [102, 302].entries()) {
        const id = `provider-terminal-${status}`;
        const operation: ExecuteOperationDefinition = {
          ...definition(ToolAddress.make(`${id}.echo`), id),
          providerTransport: "http",
        };
        const executor = yield* makeTestExecutor({
          plugins: [
            makeProviderEvidencePlugin(id, {
              transport: "http",
              responseSha256,
              status,
              observedAt: "2026-01-01T00:00:00.000Z",
            }),
          ] as const,
          operations: [operation],
        });
        const request = yield* makeRequest(operation, `job-terminal-${index}`, { value: "hello" });
        const result = yield* executor.executeOperation(request, "http");
        expect(result.status).toBe("failed");
        expect(result.providerReconciliation.status).toBe("unavailable");
        expect(result.providerReconciliation.receipt?.status).toBe(status);
      }
    }),
  );

  it.effect("rejects secret-shaped public input before reservation or invocation", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const requestResult = yield* Effect.result(
        makeRequest(operation, "job-secret", { password: "do-not-send" }),
      );
      expect(
        Result.match(requestResult, {
          onFailure: (failure) => Predicate.isTagged(failure, "OperationSecretRejectedError"),
          onSuccess: () => false,
        }),
      ).toBe(true);
      // The malformed request never reserves the job, so a valid retry is
      // still allowed to execute under the same job id.
      const valid = yield* makeRequest(operation, "job-secret", { value: "safe" });
      const result = yield* executor.executeOperation(valid, "http");
      expect(result.status).toBe("completed");
    }),
  );

  it.effect("rejects common AWS/access/admin secret field aliases", () =>
    Effect.gen(function* () {
      const operation = definition();
      for (const [index, field] of ["AWS_ACCESS_KEY_ID", "access_key", "admin_key"].entries()) {
        const result = yield* Effect.result(
          makeRequest(operation, `job-secret-alias-${index}`, { [field]: "secret-value" }),
        );
        expect(
          Result.match(result, {
            onFailure: (failure) =>
              Predicate.isTagged(failure, "OperationSecretRejectedError") &&
              failure.field.endsWith(field),
            onSuccess: () => false,
          }),
        ).toBe(true);
      }
    }),
  );

  it.effect("does not honor a caller-supplied descriptor target", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-target", { value: "server-owned" });
      // There is no target field on the public request. A caller can only
      // provide a descriptor hash that the registry can reproduce.
      expect(request).not.toHaveProperty("target");
      const result = yield* executor.executeOperation(request, "http");
      expect(result.target).toBe(TARGET);
    }),
  );

  it.effect("hashes the reviewed binding mode, key, and version into the descriptor", () =>
    Effect.gen(function* () {
      const first = yield* deriveOperationDescriptor({
        ...definition(),
        bindingMode: "connection",
        bindingKey: "executor.connection",
        bindingVersion: 1,
      });
      const second = yield* deriveOperationDescriptor({
        ...definition(),
        bindingMode: "connection",
        bindingKey: "executor.connection",
        bindingVersion: 2,
      });
      expect(first).toMatchObject({
        bindingMode: "connection",
        bindingKey: "executor.connection",
        bindingVersion: 1,
      });
      expect(second.bindingVersion).toBe(2);
      expect(second.descriptorSha256).not.toBe(first.descriptorSha256);
    }),
  );

  it.effect("gives a binding resolver only frozen canonical host context", () =>
    Effect.gen(function* () {
      let observed: ExecuteOperationBindingResolverContext | undefined;
      const calls = { count: 0 };
      const operation = boundDefinition((context) =>
        Effect.sync(() => {
          observed = context;
          return makeBinding(BOUND_BINDING_A);
        }),
      );
      const executor = yield* makeTestExecutor({
        plugins: [makeBoundOperationPlugin(calls)] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-binding-context", { value: "context" });
      const result = yield* executor.executeOperation(request, "http");
      expect(result.status).toBe("completed");
      expect(calls.count).toBe(1);
      expect(observed).toBeDefined();
      if (!observed) return;
      expect(Object.getPrototypeOf(observed)).toBe(null);
      expect(Object.getPrototypeOf(observed.owner)).toBe(null);
      expect(Object.isFrozen(observed)).toBe(true);
      expect(Object.isFrozen(observed.owner)).toBe(true);
      expect(Object.isFrozen(observed.request)).toBe(true);
      expect(Object.isFrozen(observed.descriptor)).toBe(true);
      expect(observed).not.toHaveProperty("tenant");
      expect(observed).not.toHaveProperty("subject");
      expect(observed).not.toHaveProperty("target");
      expect(observed).not.toHaveProperty("transport");
      expect(observed).not.toHaveProperty("cursor");
      expect(observed.owner).toMatchObject({ tenant: "test-tenant", subject: "test-subject" });
      expect(observed.request.input).toEqual({ value: "context" });
      expect(observed.descriptor.target).toBe(BOUND_TARGET);
      expect(Reflect.set(observed.owner, "tenant", "attacker")).toBe(false);
    }),
  );

  it.effect("redacts every binding resolver failure to a fixed contract error", () =>
    Effect.gen(function* () {
      const sentinel = "https://provider.invalid/?token=binding-resolver-sentinel";
      const resolvers: readonly ExecuteOperationBindingResolver[] = [
        () => Effect.die(new BindingResolverError(sentinel)),
        () =>
          Effect.fail(
            new StorageError({
              message: sentinel,
              cause: { url: sentinel, token: "binding-resolver-token" },
            }),
          ),
      ];

      for (const [index, bindingResolver] of resolvers.entries()) {
        const operation = boundDefinition(bindingResolver);
        const executor = yield* makeTestExecutor({
          plugins: [makeBoundOperationPlugin({ count: 0 })] as const,
          operations: [operation],
        });
        const request = yield* makeRequest(operation, `job-binding-resolver-${index}`, {
          value: "resolver",
        });
        const result = yield* Effect.result(executor.executeOperation(request, "http"));
        expect(
          Result.match(result, {
            onFailure: (failure) =>
              Predicate.isTagged(failure, "OperationContractError") &&
              failure.field === "binding.resolver" &&
              failure.reason === "invalid_value" &&
              failure.message ===
                "Invalid Executor operation contract (binding.resolver: invalid_value)." &&
              !JSON.stringify(failure).includes(sentinel),
            onSuccess: () => false,
          }),
        ).toBe(true);
      }
    }),
  );

  it.effect("binds approval context to the resolved connection identity", () =>
    Effect.gen(function* () {
      let approvalContext: ExecuteOperationApprovalContext | undefined;
      const operation = boundDefinition(() => Effect.succeed(makeBinding(BOUND_BINDING_A)));
      const executor = yield* makeTestExecutor({
        plugins: [makeBoundOperationPlugin({ count: 0 })] as const,
        operations: [operation],
        operationApproval: (context) =>
          Effect.sync(() => {
            approvalContext = context;
            return "approved" as const;
          }),
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: String(BOUND_TARGET),
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-binding-approval", { value: "approval" });
      const result = yield* executor.executeOperation(request, "http");
      expect(result.status).toBe("completed");
      expect(approvalContext).toMatchObject({
        bindingSha256: BOUND_BINDING_A,
        connectionAddress: "tools.attestation.org.primary",
      });
    }),
  );

  it.effect("fails before reservation for an invalid resolved binding", () =>
    Effect.gen(function* () {
      let reserveCalls = 0;
      const inner = makeInMemoryOperationReplayStore();
      const replayStore = {
        ...inner,
        reserve: (input: Parameters<typeof inner.reserve>[0]) => {
          reserveCalls += 1;
          return inner.reserve(input);
        },
      };
      const invalidBinding = {
        ...makeBinding(BOUND_BINDING_A),
        connection: {
          ...makeBinding(BOUND_BINDING_A).connection,
          address: ConnectionAddress.make("tools.attestation.user.primary"),
        },
      };
      const operation = boundDefinition(() => Effect.succeed(invalidBinding));
      const executor = yield* makeTestExecutor({
        plugins: [makeBoundOperationPlugin({ count: 0 })] as const,
        operations: [operation],
        operationReplayStore: replayStore,
      });
      const request = yield* makeRequest(operation, "job-binding-invalid", { value: "invalid" });
      const result = yield* Effect.result(executor.executeOperation(request, "http"));
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "binding.connection.address",
          onSuccess: () => false,
        }),
      ).toBe(true);
      expect(reserveCalls).toBe(0);
    }),
  );

  it.effect("fails closed after approval drift before credential/provider work", () =>
    Effect.gen(function* () {
      let resolverCalls = 0;
      const calls = { count: 0 };
      const operation = boundDefinition(() =>
        Effect.sync(() => {
          resolverCalls += 1;
          return makeBinding(resolverCalls === 1 ? BOUND_BINDING_A : BOUND_BINDING_B);
        }),
      );
      const executor = yield* makeTestExecutor({
        plugins: [makeBoundOperationPlugin(calls)] as const,
        operations: [operation],
        operationApproval: () => Effect.succeed("approved" as const),
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: String(BOUND_TARGET),
        action: "require_approval",
      });
      const request = yield* makeRequest(operation, "job-binding-drift", { value: "drift" });
      const result = yield* Effect.result(executor.executeOperation(request, "http"));
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "binding.execution",
          onSuccess: () => false,
        }),
      ).toBe(true);
      expect(resolverCalls).toBe(2);
      expect(calls.count).toBe(0);
    }),
  );

  it.effect("re-resolves the binding before replay and rejects drift", () =>
    Effect.gen(function* () {
      let resolverCalls = 0;
      const calls = { count: 0 };
      const operation = boundDefinition(() =>
        Effect.sync(() => {
          resolverCalls += 1;
          return makeBinding(resolverCalls <= 3 ? BOUND_BINDING_A : BOUND_BINDING_B);
        }),
      );
      const executor = yield* makeTestExecutor({
        plugins: [makeBoundOperationPlugin(calls)] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-binding-replay-drift", {
        value: "replay",
      });
      const first = yield* executor.executeOperation(request, "http");
      expect(first.status).toBe("completed");
      const replay = yield* Effect.result(executor.executeOperation(request, "mcp"));
      expect(
        Result.match(replay, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "binding.replay",
          onSuccess: () => false,
        }),
      ).toBe(true);
      expect(resolverCalls).toBe(4);
      expect(calls.count).toBe(1);
    }),
  );

  it.effect("does not replay the same request/job across different binding lineages", () =>
    Effect.gen(function* () {
      let currentBinding = BOUND_BINDING_A;
      const calls = { count: 0 };
      const operation = boundDefinition(() => Effect.succeed(makeBinding(currentBinding)));
      const executor = yield* makeTestExecutor({
        plugins: [makeBoundOperationPlugin(calls)] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-binding-key", { value: "same" });
      const first = yield* executor.executeOperation(request, "http");
      expect(first.status).toBe("completed");
      currentBinding = BOUND_BINDING_B;
      const second = yield* executor.executeOperation(request, "mcp");
      expect(second.status).toBe("completed");
      expect(calls.count).toBe(2);
    }),
  );

  it.effect("rejects a request proxy/accessor before schema or policy reads", () =>
    Effect.gen(function* () {
      const operation = definition();
      const executor = yield* makeTestExecutor({
        plugins: [operationPlugin] as const,
        operations: [operation],
      });
      const request = yield* makeRequest(operation, "job-request-trap", { value: "safe" });
      const revoked = Proxy.revocable({ value: "trap" }, {});
      revoked.revoke();
      const hostile = Object.defineProperty({ ...request }, "input", {
        enumerable: true,
        get: () => Reflect.get(revoked.proxy, "value"),
      }) as ExecuteOperationRequest;
      const result = yield* Effect.result(executor.executeOperation(hostile, "http"));
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "OperationContractError") &&
            failure.field === "request" &&
            failure.reason === "invalid_request",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("the typed request codec round-trips the versioned wire shape", () =>
    Effect.gen(function* () {
      const operation = definition();
      const request = yield* makeRequest(operation, "job-codec", { value: "codec" });
      const decoded = yield* ExecuteOperationRequestCodec.decode(request);
      expect(decoded).toEqual(request);
    }),
  );
});
