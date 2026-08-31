import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  Subject,
  ToolName,
  createExecutor,
  definePlugin,
  type Executor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { observabilityMiddleware } from "../observability";
import { AuthContext, CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

const INTEGRATION = IntegrationSlug.make("github");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const githubPlugin = definePlugin(() => ({
  id: "github" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("viewer"), description: "viewer" }],
    }),
  invokeTool: () => Effect.succeed({ ok: true }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEGRATION,
        description: "GitHub",
        config: {},
      }),
  }),
}))();

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
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

const handlerContextFor = (
  executor: Executor,
  input: { kind: "user" | "service"; id: string; scopes?: readonly string[] },
) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
    Context.add(AuthContext, {
      kind: input.kind,
      accountId: input.id,
      organizationId: "test-tenant",
      email: "",
      name: null,
      avatarUrl: null,
      roles: input.kind === "service" ? ["service"] : [],
      scopes: input.scopes ?? (input.kind === "service" ? ["connections:handoff"] : []),
    }),
  );

describe("connection handoff HTTP authority", () => {
  it.effect("lets only a service create and only the exact user explicitly complete", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), githubPlugin] as const,
        coreTools: {
          webBaseUrl: "https://executor.example",
          orgSlug: "acme",
          connectionReturnOrigins: ["https://manifest.example"],
        },
      });
      const service = yield* createExecutor({
        ...config,
        subject: Subject.make("service-client"),
      });
      const member = yield* createExecutor({ ...config, subject: Subject.make("test-subject") });
      const foreign = yield* createExecutor({ ...config, subject: Subject.make("foreign-user") });
      yield* service.github.seed();

      const serviceWeb = yield* webHandlerFor(service);
      const createResponse = yield* Effect.promise(() =>
        serviceWeb.handler(
          new Request("http://localhost/connection-handoffs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              memberId: "test-subject",
              integration: INTEGRATION,
              template: TEMPLATE,
              label: "Manifest GitHub",
              returnTo: "https://manifest.example/os/connections?connected=github",
            }),
          }),
          handlerContextFor(service, { kind: "service", id: "service-client" }),
        ),
      );
      expect(createResponse.status).toBe(200);
      const pending = (yield* Effect.promise(() => createResponse.json())) as {
        readonly handoffId: string;
        readonly connectionName: string;
        readonly status: string;
        readonly url: string;
      };
      expect(pending).toMatchObject({ status: "pending" });
      expect(pending.url).toBe(`https://executor.example/acme/connect/${pending.handoffId}`);

      const leaseOnlyRead = yield* Effect.promise(() =>
        serviceWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}`),
          handlerContextFor(service, {
            kind: "service",
            id: "service-client",
            scopes: ["credentials:lease"],
          }),
        ),
      );
      expect(leaseOnlyRead.status).toBe(403);

      const userCreate = yield* Effect.promise(() =>
        serviceWeb.handler(
          new Request("http://localhost/connection-handoffs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              memberId: "test-subject",
              integration: INTEGRATION,
              label: "Rejected",
              returnTo: "https://manifest.example/os/connections",
            }),
          }),
          handlerContextFor(service, { kind: "user", id: "service-client" }),
        ),
      );
      expect(userCreate.status).toBe(403);

      const leaseOnlyCreate = yield* Effect.promise(() =>
        serviceWeb.handler(
          new Request("http://localhost/connection-handoffs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              memberId: "test-subject",
              integration: INTEGRATION,
              label: "Rejected lease identity",
              returnTo: "https://manifest.example/os/connections",
            }),
          }),
          handlerContextFor(service, {
            kind: "service",
            id: "service-client",
            scopes: ["credentials:lease"],
          }),
        ),
      );
      expect(leaseOnlyCreate.status).toBe(403);

      const foreignWeb = yield* webHandlerFor(foreign);
      const foreignRead = yield* Effect.promise(() =>
        foreignWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}`),
          handlerContextFor(foreign, { kind: "user", id: "foreign-user" }),
        ),
      );
      expect(foreignRead.status).toBe(403);

      const foreignCompletion = yield* Effect.promise(() =>
        foreignWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "user",
              integration: INTEGRATION,
              name: pending.connectionName,
            }),
          }),
          handlerContextFor(foreign, { kind: "user", id: "foreign-user" }),
        ),
      );
      expect(foreignCompletion.status).toBe(403);

      const memberWeb = yield* webHandlerFor(member);
      const tamperedRead = yield* Effect.promise(() =>
        memberWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}-tampered`),
          handlerContextFor(member, { kind: "user", id: "test-subject" }),
        ),
      );
      expect(tamperedRead.status).toBe(404);

      const tamperedCompletion = yield* Effect.promise(() =>
        memberWeb.handler(
          new Request(
            `http://localhost/connection-handoffs/${pending.handoffId}-tampered/complete`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                owner: "user",
                integration: INTEGRATION,
                name: pending.connectionName,
              }),
            },
          ),
          handlerContextFor(member, { kind: "user", id: "test-subject" }),
        ),
      );
      expect(tamperedCompletion.status).toBe(404);

      const pendingRead = yield* Effect.promise(() =>
        memberWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}`),
          handlerContextFor(member, { kind: "user", id: "test-subject" }),
        ),
      );
      expect(pendingRead.status).toBe(200);
      const pendingBody = yield* Effect.promise(() => pendingRead.json());
      expect(pendingBody).toMatchObject({ status: "pending" });

      yield* member.connections.create({
        owner: "user",
        name: ConnectionName.make(pending.connectionName),
        integration: INTEGRATION,
        template: TEMPLATE,
        value: "real-shaped-test-token",
      });
      expect(
        yield* member.connections.list({ owner: "user", integration: INTEGRATION }),
      ).toMatchObject([{ name: pending.connectionName }]);

      // GET remains observational even after an exact-name row exists.
      const stillPendingRead = yield* Effect.promise(() =>
        memberWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}`),
          handlerContextFor(member, { kind: "user", id: "test-subject" }),
        ),
      );
      expect(stillPendingRead.status).toBe(200);
      expect(yield* Effect.promise(() => stillPendingRead.json())).toMatchObject({
        status: "pending",
      });

      const serviceCompletion = yield* Effect.promise(() =>
        serviceWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "user",
              integration: INTEGRATION,
              name: pending.connectionName,
            }),
          }),
          handlerContextFor(service, { kind: "service", id: "service-client" }),
        ),
      );
      expect(serviceCompletion.status).toBe(403);

      const mismatchedCompletion = yield* Effect.promise(() =>
        memberWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "org",
              integration: INTEGRATION,
              name: pending.connectionName,
            }),
          }),
          handlerContextFor(member, { kind: "user", id: "test-subject" }),
        ),
      );
      expect(mismatchedCompletion.status).toBe(409);

      const complete = () =>
        memberWeb.handler(
          new Request(`http://localhost/connection-handoffs/${pending.handoffId}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "user",
              integration: INTEGRATION,
              name: pending.connectionName,
            }),
          }),
          handlerContextFor(member, { kind: "user", id: "test-subject" }),
        );
      const completedResponse = yield* Effect.promise(complete);
      expect(completedResponse.status).toBe(200);
      const completedBody = yield* Effect.promise(() => completedResponse.json());
      expect(completedBody).toMatchObject({
        status: "completed",
        receipt: {
          schema: "executor.connection-handoff.receipt.v1",
          tenant: "test-tenant",
          memberId: "test-subject",
          readback: { connectionPresent: true },
        },
      });

      const duplicateResponse = yield* Effect.promise(complete);
      expect(duplicateResponse.status).toBe(200);
      expect(yield* Effect.promise(() => duplicateResponse.json())).toEqual(completedBody);
    }),
  );
});
