import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Predicate, Result, Schema } from "effect";

import { ToolResult } from "./tool-result";
import type { ToolProviderEvidence } from "./tool-result";
import { definePlugin, tool } from "./plugin";
import { ToolAddress } from "./ids";
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
  type ExecuteOperationDefinition,
  type ExecuteOperationResult,
  type ExecuteOperationRequest,
} from "./operation";
import { createExecutor } from "./executor";
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
