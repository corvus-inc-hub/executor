import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolName,
  ToolAddress,
  ToolResult,
  ExecuteOperationResultCodec,
  deriveOperationDescriptor,
  hashExecuteOperationRequest,
  createExecutor,
  definePlugin,
  tool,
  type ExecuteOperationDefinition,
  type ExecuteOperationRequest,
  type Executor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { ExecutorApi, OperationExecutorApi } from "./api";
import { observabilityMiddleware } from "./observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "./server";

// ---------------------------------------------------------------------------
// v2 owner-scoped API behaviour.
//
// v1's "explicit target scope" tests gated writes by a route scope vs a payload
// `targetScope`, and exercised the `[user, org]` scope-stack shadowing rules.
// v2 has neither: the executor binds `{ tenant, subject }` from auth, addresses
// name their owner explicitly (`tools.<int>.<owner>.<conn>.<tool>`), and there is
// no shadowing (D12) — an org connection and a user connection are DISTINCT rows
// with distinct addresses. These ports keep the spirit (writes target an owner,
// owner rows are independent) against the real v2 surface.
// ---------------------------------------------------------------------------

// removed: "policy update uses the row target scope instead of the route read
//   scope" — v2 policies have no route read-scope vs payload target-scope split;
//   they are owner-scoped. The owner-scoped create/update path is covered below.
// removed: "OAuth start requires the route scope to match the requested token
//   scope" and "OAuth complete requires the route scope to match the pending
//   session scope" — v2 OAuth carries no scope segment; start/complete are stubbed
//   in the SDK (milestone 2) and have no scope-matching gate to assert.

const webHandlerFor = (executor: Executor, api = OperationExecutorApi) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(api)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

const INTEGRATION = IntegrationSlug.make("vercel");

const OPERATION_INPUT = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ value: Schema.String })),
);

const operationHttpPlugin = definePlugin(() => ({
  id: "http-attestation" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "http-attestation",
      kind: "plugin" as const,
      name: "HTTP attestation",
      tools: [
        tool({
          name: "echo",
          description: "Echo a public value.",
          inputSchema: OPERATION_INPUT,
          outputSchema: OPERATION_INPUT,
          execute: ({ value }) => Effect.succeed({ value }),
        }),
      ],
    },
  ],
}))();

const HTTP_OPERATION: ExecuteOperationDefinition = {
  operationKey: "http.attestation.echo",
  version: 1,
  target: ToolAddress.make("http-attestation.echo"),
  inputSchema: OPERATION_INPUT,
  outputSchema: OPERATION_INPUT,
  providerTransport: "none",
};

const HTTP_PROVIDER_LEAK_OPERATION: ExecuteOperationDefinition = {
  operationKey: "http.attestation.provider-leak",
  version: 1,
  target: ToolAddress.make("http-provider-attestation.echo"),
  inputSchema: OPERATION_INPUT,
  outputSchema: OPERATION_INPUT,
  providerTransport: "http",
};

const HTTP_DEFECT_OPERATION: ExecuteOperationDefinition = {
  operationKey: "http.attestation.defect",
  version: 1,
  target: ToolAddress.make("http-defect-attestation.echo"),
  inputSchema: OPERATION_INPUT,
  outputSchema: OPERATION_INPUT,
  providerTransport: "none",
};

const operationHttpDefectPlugin = definePlugin(() => ({
  id: "http-defect-attestation" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "http-defect-attestation",
      kind: "plugin" as const,
      name: "HTTP defect attestation",
      tools: [
        tool({
          name: "echo",
          description: "Throws an opaque provider defect.",
          inputSchema: OPERATION_INPUT,
          outputSchema: OPERATION_INPUT,
          // oxlint-disable-next-line executor/no-effect-escape-hatch, executor/no-error-constructor -- adversarial HTTP redaction regression
          execute: () => Effect.die(new Error("https://provider.invalid/?token=http-sentinel")),
        }),
      ],
    },
  ],
}))();

const operationHttpProviderLeakPlugin = definePlugin(() => ({
  id: "http-provider-attestation" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "http-provider-attestation",
      kind: "plugin" as const,
      name: "HTTP provider attestation",
      tools: [
        tool({
          name: "echo",
          description: "Returns deliberately unsafe provider metadata.",
          inputSchema: OPERATION_INPUT,
          outputSchema: OPERATION_INPUT,
          execute: ({ value }) =>
            Effect.succeed(
              ToolResult.ok(
                { value },
                {
                  provider: {
                    transport: "http",
                    responseSha256:
                      "9b2d43affbf49a367028df2e1414f84c0e099ac98c3d54a8a80157fd7771af25",
                    requestId: "Bearer leaked-provider-token",
                    status: 200,
                    observedAt: "2026-01-01T00:00:00.000Z",
                  },
                },
              ),
            ),
        }),
      ],
    },
  ],
}))();

const operationRequestFor = (
  operation: ExecuteOperationDefinition,
  jobId: string,
  input: unknown,
) =>
  Effect.gen(function* () {
    const descriptor = yield* deriveOperationDescriptor(operation);
    const unsigned = {
      schemaVersion: "executor.operation.v2" as const,
      operationKey: operation.operationKey,
      version: operation.version,
      jobId,
      descriptorSha256: descriptor.descriptorSha256,
      input,
      requestSha256: "0".repeat(64),
    } satisfies ExecuteOperationRequest;
    return {
      ...unsigned,
      requestSha256: yield* hashExecuteOperationRequest(unsigned),
    } satisfies ExecuteOperationRequest;
  });

// A plugin that owns the `vercel` integration and produces one tool per
// connection so the per-connection address scheme is exercised.
const vercelPlugin = definePlugin(() => ({
  id: "vercel" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("deploy"), description: "deploy" }],
    }),
  invokeTool: () => Effect.succeed({ ok: true }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEGRATION,
        description: "Vercel",
        config: {},
      }),
  }),
}))();

describe("core API owner-scoped writes (v2)", () => {
  it.effect("does not mount the operation route when the default API is used", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [operationHttpPlugin] as const }),
      );
      const web = yield* webHandlerFor(executor, ExecutorApi);
      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/operations", {
            method: "POST",
            headers: { "content-type": "application/json" },
          }),
          handlerContextFor(executor),
        ),
      );
      expect(response.status).toBe(404);
    }),
  );

  it.effect("HTTP operation carrier delegates to the same attested core envelope", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [operationHttpPlugin] as const,
        operations: [HTTP_OPERATION],
      });
      const directExecutor = yield* createExecutor(config);
      const directRequest = yield* operationRequestFor(HTTP_OPERATION, "http-parity-direct", {
        value: "same",
      });
      const direct = yield* directExecutor.executeOperation(directRequest, "internal");

      const httpConfig = makeTestConfig({
        plugins: [operationHttpPlugin] as const,
        operations: [HTTP_OPERATION],
      });
      const httpExecutor = yield* createExecutor(httpConfig);
      const web = yield* webHandlerFor(httpExecutor);
      const context = handlerContextFor(httpExecutor);
      const httpRequest = yield* operationRequestFor(HTTP_OPERATION, "http-parity-http", {
        value: "same",
      });
      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/operations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(httpRequest),
          }),
          context,
        ),
      );

      expect(response.status).toBe(200);
      const httpResult = ExecuteOperationResultCodec.decodeSync(
        yield* Effect.promise(() => response.json()),
      );
      expect(httpResult.carrier).toBe("http");
      expect(httpResult).toMatchObject({
        schemaVersion: direct.schemaVersion,
        operationKey: direct.operationKey,
        version: direct.version,
        descriptorSha256: direct.descriptorSha256,
        target: direct.target,
        providerTransport: direct.providerTransport,
        policy: direct.policy,
        approval: { decision: direct.approval.decision },
        providerReconciliation: direct.providerReconciliation,
        status: direct.status,
        outputSha256: direct.outputSha256,
        output: direct.output,
      });
    }),
  );

  it.effect("HTTP operation results do not expose unsafe provider metadata", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [operationHttpProviderLeakPlugin] as const,
        operations: [HTTP_PROVIDER_LEAK_OPERATION],
      });
      const executor = yield* createExecutor(config);
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);
      const request = yield* operationRequestFor(
        HTTP_PROVIDER_LEAK_OPERATION,
        "http-provider-leak",
        { value: "same" },
      );
      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/operations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          }),
          context,
        ),
      );

      expect(response.status).toBe(200);
      const result = ExecuteOperationResultCodec.decodeSync(
        yield* Effect.promise(() => response.json()),
      );
      expect(result.status).toBe("failed");
      expect(result.output).toBeUndefined();
      expect(result.providerReconciliation.status).toBe("unavailable");
      expect(result.providerReconciliation.receipt).toBeUndefined();
    }),
  );

  it.effect("HTTP operation defects stay opaque and replayable", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [operationHttpDefectPlugin] as const,
          operations: [HTTP_DEFECT_OPERATION],
        }),
      );
      const web = yield* webHandlerFor(executor);
      const request = yield* operationRequestFor(HTTP_DEFECT_OPERATION, "http-defect", {
        value: "same",
      });
      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/operations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          }),
          handlerContextFor(executor),
        ),
      );
      const body = JSON.stringify(yield* Effect.promise(() => response.json()));
      expect(response.status).toBe(200);
      expect(body).not.toContain("http-sentinel");
      expect(body).not.toContain("provider.invalid");
    }),
  );

  it.effect("policy create + update target an explicit owner", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({}));
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const createResponse = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/policies", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "org",
              pattern: "vercel.*",
              action: "require_approval",
            }),
          }),
          context,
        ),
      );
      expect(createResponse.status).toBe(200);
      const created = (yield* Effect.promise(() => createResponse.json())) as {
        id: string;
      };

      const updateResponse = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/policies/${encodeURIComponent(created.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ owner: "org", action: "block" }),
          }),
          context,
        ),
      );

      expect(updateResponse.status).toBe(200);
      const policies = yield* executor.policies.list();
      expect(policies[0]).toMatchObject({
        id: created.id,
        owner: "org",
        action: "block",
      });
    }),
  );

  it.effect("connection remove deletes the named owner row, not the other owner", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), vercelPlugin] as const,
      });
      const executor = yield* createExecutor(config);
      yield* executor.vercel.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const name = ConnectionName.make("default");
      yield* executor.connections.create({
        owner: "org",
        name,
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name,
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "user-token",
      });

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/connections/org/${INTEGRATION}/${name}`, {
            method: "DELETE",
          }),
          context,
        ),
      );

      expect(response.status).toBe(200);
      // The org row is gone; the user row survives (no shadowing — distinct rows).
      const remaining = yield* executor.connections.list({
        integration: INTEGRATION,
      });
      expect(remaining.map((c) => c.owner).sort()).toEqual(["user"]);
    }),
  );

  it.effect("connection create accepts pasted values payloads", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), vercelPlugin] as const,
      });
      const executor = yield* createExecutor(config);
      yield* executor.vercel.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/connections", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "user",
              name: "api-key",
              integration: "vercel",
              template: "apiKey",
              values: { token: "user-token" },
            }),
          }),
          context,
        ),
      );

      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly owner: string;
        readonly name: string;
        readonly provider: string;
      };
      expect(body).toMatchObject({
        owner: "user",
        name: "apiKey",
        provider: "memory",
      });
    }),
  );

  it.effect("connection list returns both owners' rows under one integration", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), vercelPlugin] as const,
      });
      const executor = yield* createExecutor(config);
      yield* executor.vercel.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("default"),
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "user-token",
      });

      const response = yield* Effect.promise(() =>
        web.handler(new Request("http://localhost/connections", { method: "GET" }), context),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        readonly owner: string;
        readonly name: string;
      }>;
      expect(body.map((c) => `${c.owner}:${c.name}`).sort()).toEqual([
        "org:default",
        "user:personal",
      ]);
    }),
  );
});
