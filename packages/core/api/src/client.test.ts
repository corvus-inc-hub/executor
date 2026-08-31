import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  makeExecutorApiClient,
  type CompleteConnectionHandoffRequest,
  type CompleteConnectionHandoffResult,
  type CreateConnectionHandoffRequest,
  type CreateConnectionHandoffResult,
  type GetConnectionHandoffRequest,
  type GetConnectionHandoffResult,
} from "@executor-js/api/client";
import { ConnectionHandoffId, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

const pendingHandoff = {
  handoffId: "handoff_123",
  memberId: "member_123",
  integration: "github",
  owner: "user",
  connectionName: "manifest-github",
  label: "Manifest GitHub",
  returnTo: "https://manifest.example/connections",
  url: "https://executor.example/acme/connect/handoff_123",
  createdAt: 1_000,
  expiresAt: 2_000,
  status: "pending",
} as const;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("makeExecutorApiClient", () => {
  it.effect("calls the typed Executor API at the configured remote with explicit headers", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (captured) => [...captured, request]);
          return HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson(pendingHandoff), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      const client = yield* makeExecutorApiClient({
        baseUrl: "https://executor.example/api",
        headers: { authorization: "Bearer service-token" },
        transformClient: HttpClient.mapRequest((request) =>
          HttpClientRequest.setHeader(request, "x-executor-org", "acme"),
        ),
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(httpClient)));
      const request: CreateConnectionHandoffRequest = {
        payload: {
          memberId: "member_123",
          integration: IntegrationSlug.make("github"),
          label: "Manifest GitHub",
          returnTo: "https://manifest.example/connections",
        },
      };

      const handoff: CreateConnectionHandoffResult =
        yield* client.connections.createHandoff(request);
      const [captured] = yield* Ref.get(requests);

      expect(handoff).toMatchObject({ handoffId: "handoff_123", status: "pending" });
      expect(captured).toMatchObject({
        method: "POST",
        url: "https://executor.example/api/connection-handoffs",
        headers: {
          authorization: "Bearer service-token",
          "x-executor-org": "acme",
        },
      });
    }),
  );

  it.effect("keeps handoff get and completion requests and results endpoint-derived", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make((request) => {
        const body = request.url.endsWith("/complete")
          ? {
              ...pendingHandoff,
              status: "completed",
              receipt: {
                schema: "executor.connection-handoff.receipt.v1",
                receiptId: "receipt_123",
                handoffId: pendingHandoff.handoffId,
                tenant: "tenant_123",
                memberId: pendingHandoff.memberId,
                completedAt: 1_500,
                connection: {
                  owner: "user",
                  integration: pendingHandoff.integration,
                  name: pendingHandoff.connectionName,
                },
                readback: { connectionPresent: true },
              },
            }
          : pendingHandoff;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });
      const client = yield* makeExecutorApiClient({
        baseUrl: "https://executor.example/api",
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(httpClient)));
      const handoffId = ConnectionHandoffId.make("handoff_123");
      const getRequest: GetConnectionHandoffRequest = { params: { handoffId } };
      const completeRequest: CompleteConnectionHandoffRequest = {
        params: { handoffId },
        payload: {
          owner: "user",
          integration: IntegrationSlug.make("github"),
          name: ConnectionName.make("manifest-github"),
        },
      };

      const observed: GetConnectionHandoffResult = yield* client.connections.getHandoff(getRequest);
      const completed: CompleteConnectionHandoffResult =
        yield* client.connections.completeHandoff(completeRequest);

      expect(observed.status).toBe("pending");
      expect(completed).toMatchObject({
        status: "completed",
        receipt: { schema: "executor.connection-handoff.receipt.v1" },
      });
    }),
  );

  it.effect("ships the remote client at its exact public package subpath", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        readFile(new URL("../package.json", import.meta.url), "utf8"),
      );
      const manifest = decodeJson(source) as {
        readonly private?: boolean;
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly files?: ReadonlyArray<string>;
        readonly scripts?: Readonly<Record<string, string>>;
        readonly publishConfig?: {
          readonly access?: string;
          readonly exports?: Readonly<Record<string, unknown>>;
        };
      };

      expect(manifest.private).not.toBe(true);
      // The source package still owns server entrypoints used by the self-host
      // image, so their runtime edge must remain installable in the workspace.
      // The packed public manifest is narrowed to the client surface by the
      // repository packer and is verified by scripts/smoke-test-packed.ts.
      expect(manifest.dependencies).toHaveProperty("@executor-js/host-mcp", "workspace:*");
      expect(manifest.files).toContain("dist");
      expect(manifest.scripts?.build).toBeDefined();
      expect(manifest.publishConfig).toMatchObject({
        access: "public",
        exports: {
          "./client": {
            import: {
              types: "./dist/client.d.ts",
              default: "./dist/client.js",
            },
          },
        },
      });
    }),
  );
});
