import { createHash } from "node:crypto";

import { createClient } from "@libsql/client";
import { expect } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import {
  M2M_CLIENT_ID,
  M2M_CLIENT_SECRET,
  M2M_SCOPE,
  WORKOS_CUSTOMER_ORG_ID,
  WORKOS_FORBIDDEN_ORG_ID,
  WORKOS_USER_ID,
} from "../targets/selfhost-workos";

const api = composePluginApi([openApiHttpPlugin()] as const);
const integration = IntegrationSlug.make("credential_lease_e2e");
const connectionName = ConnectionName.make("manifest_delivery");
const forbiddenIntegration = IntegrationSlug.make("m2m_control_plane_forbidden");
const forbiddenConnectionName = ConnectionName.make("m2m_control_plane_forbidden");
const template = AuthTemplateSlug.make("apiKey");
const secret = "provider-secret-from-executor";

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Credential lease E2E", version: "1.0.0" },
  paths: {
    "/health": { get: { operationId: "health", responses: { "200": { description: "ok" } } } },
  },
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const leaseBody = (organizationId: string) => ({
  organizationId,
  workspaceId: "workspace_manifest_e2e",
  runId: "run_manifest_delivery_e2e",
  credential: { integration, name: connectionName },
  purpose: "Manifest delivery",
  scopes: ["provider:read"],
  ttlSeconds: 900,
  delivery: { environment: { PROVIDER_TOKEN: "token" } },
});

const postLease = (baseUrl: string, headers: Readonly<Record<string, string>>, body: unknown) =>
  fetch(new URL("/api/credential-leases", baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const attemptControlPlaneMutations = async (
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
) => {
  const requestHeaders = { ...headers, "content-type": "application/json" };
  const addSpec = await fetch(new URL("/api/openapi/specs", baseUrl), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      spec: { kind: "blob", value: spec },
      slug: forbiddenIntegration,
      baseUrl: "https://forbidden.example.test",
    }),
  });
  const removeSpec = await fetch(new URL(`/api/openapi/integrations/${integration}`, baseUrl), {
    method: "DELETE",
    headers,
  });
  const createConnection = await fetch(new URL("/api/connections", baseUrl), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      owner: "org",
      integration,
      name: forbiddenConnectionName,
      template,
      value: "must-never-be-written",
    }),
  });
  return [addSpec.status, removeSpec.status, createConnection.status];
};

scenario(
  "Credential leases · WorkOS M2M proves ownership, scope, isolation, material hash, and durability",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    if (!target.newServiceIdentity) return yield* Effect.die("target has no WorkOS M2M identity");

    const service = yield* target.newServiceIdentity({ scopes: [M2M_SCOPE] });
    const setupUser = yield* target.newIdentity();
    const setupClient = yield* makeApiClient(api, setupUser);
    const token = service.headers?.authorization?.replace(/^Bearer /, "");
    expect(token, "the service identity carries a client_credentials JWT").toBeTruthy();

    const authUrl = process.env.E2E_SELFHOST_WORKOS_AUTH_URL!;
    const apiKey = process.env.E2E_SELFHOST_WORKOS_API_KEY!;
    const applicationResponse = yield* Effect.promise(() =>
      fetch(`${authUrl}/connect/applications/${M2M_CLIENT_ID}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(
      applicationResponse.status,
      "the provider resolves the application by live client id",
    ).toBe(200);
    const application = (yield* Effect.promise(() => applicationResponse.json())) as {
      client_id: string;
      organization_id: string;
      application_type: string;
      scopes: string[];
    };
    expect(application).toMatchObject({
      client_id: M2M_CLIENT_ID,
      organization_id: "org_platform",
      application_type: "m2m",
      scopes: expect.arrayContaining([M2M_SCOPE]),
    });

    const verified = yield* Effect.promise(() =>
      jwtVerify(token!, createRemoteJWKSet(new URL(`${authUrl}/oauth2/jwks`)), {
        issuer: authUrl,
        audience: "client_executor_selfhost",
      }),
    );
    expect(verified.payload).toMatchObject({
      sub: M2M_CLIENT_ID,
      org_id: "org_platform",
      scope: M2M_SCOPE,
    });
    expect(verified.payload.jti, "the provider JWT has a replay-unique id").toBeTruthy();

    const rejectedToken = yield* Effect.exit(
      target.newServiceIdentity({ scopes: ["not:granted"] }),
    );
    expect(rejectedToken._tag, "the provider refuses an ungranted M2M scope").toBe("Failure");
    const diagnostic =
      rejectedToken._tag === "Failure" ? Cause.pretty(rejectedToken.cause) : "unexpected success";
    expect(diagnostic).toContain("WorkOS client_credentials failed (400)");
    expect(diagnostic).not.toContain(M2M_CLIENT_SECRET);
    expect(diagnostic).not.toContain("invalid_scope");

    const settlement = { spec: false, connection: false };
    yield* Effect.gen(function* () {
      yield* setupClient.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: spec },
          slug: integration,
          baseUrl: "https://provider.example.test",
          authenticationTemplate: [
            {
              slug: template,
              type: "apiKey",
              headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });
      settlement.spec = true;
      yield* setupClient.connections.create({
        payload: {
          owner: "org",
          name: connectionName,
          integration,
          template,
          value: secret,
        },
      });
      settlement.connection = true;

      const leaseControlPlaneStatuses = yield* Effect.promise(() =>
        attemptControlPlaneMutations(target.baseUrl, service.headers!),
      );
      expect(
        leaseControlPlaneStatuses,
        "a credentials:lease JWT is denied by default on generic control-plane routes",
      ).toEqual([403, 403, 403]);

      const handoffResponse = yield* Effect.promise(() =>
        fetch(new URL("/api/connection-handoffs", target.baseUrl), {
          method: "POST",
          headers: { ...service.headers!, "content-type": "application/json" },
          body: JSON.stringify({
            memberId: WORKOS_USER_ID,
            integration,
            label: "Rejected lease identity",
            returnTo: new URL("/manifest-delivery-e2e/integrations", target.baseUrl).toString(),
          }),
        }),
      );
      expect(
        handoffResponse.status,
        "a credentials:lease JWT cannot create a connection handoff",
      ).toBe(403);

      const response = yield* Effect.promise(() =>
        postLease(target.baseUrl, service.headers!, leaseBody(WORKOS_CUSTOMER_ORG_ID)),
      );
      expect(response.status, "the production handler accepts the M2M lease").toBe(201);
      const leased = (yield* Effect.promise(() => response.json())) as {
        lease: { id: string; serviceAccountId: string; organizationId: string };
        material: { environment: Record<string, string>; secretFiles: unknown[] };
        receipt: {
          materialHash: string;
          entries: Array<{ kind: string; name: string; sha256: string }>;
        };
      };
      expect(leased.lease).toMatchObject({
        serviceAccountId: M2M_CLIENT_ID,
        organizationId: WORKOS_CUSTOMER_ORG_ID,
      });
      expect(leased.material).toEqual({
        environment: { PROVIDER_TOKEN: secret },
        secretFiles: [],
      });
      const entries = [{ kind: "environment", name: "PROVIDER_TOKEN", sha256: sha256(secret) }];
      expect(leased.receipt).toEqual({ materialHash: sha256(JSON.stringify(entries)), entries });

      const limited = yield* target.newServiceIdentity({ scopes: ["connections:handoff"] });
      const handoffControlPlaneStatuses = yield* Effect.promise(() =>
        attemptControlPlaneMutations(target.baseUrl, limited.headers!),
      );
      expect(
        handoffControlPlaneStatuses,
        "a connections:handoff JWT is denied by default on generic control-plane routes",
      ).toEqual([403, 403, 403]);
      const limitedResponse = yield* Effect.promise(() =>
        postLease(target.baseUrl, limited.headers!, leaseBody(WORKOS_CUSTOMER_ORG_ID)),
      );
      expect(limitedResponse.status, "a JWT without credentials:lease is refused").toBe(403);
      const limitedBody = yield* Effect.promise(() => limitedResponse.json());
      expect(limitedBody).toMatchObject({ code: "forbidden" });

      const crossOrgResponse = yield* Effect.promise(() =>
        postLease(target.baseUrl, service.headers!, leaseBody(WORKOS_FORBIDDEN_ORG_ID)),
      );
      expect(crossOrgResponse.status, "an unallowlisted customer organization is refused").toBe(
        403,
      );
      const crossOrgBody = yield* Effect.promise(() => crossOrgResponse.json());
      expect(crossOrgBody).toMatchObject({ code: "forbidden" });

      const receiptRows = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          createClient({ url: `file:${process.env.E2E_SELFHOST_WORKOS_DB_PATH!}` }),
        ),
        (db) =>
          Effect.promise(() =>
            db.execute({
              sql: "SELECT * FROM credential_lease_receipt WHERE id = ? LIMIT 1",
              args: [leased.lease.id],
            }),
          ),
        (db) => Effect.sync(() => db.close()),
      );
      expect(receiptRows.rows).toHaveLength(1);
      expect(receiptRows.rows[0]).toMatchObject({
        organization_id: WORKOS_CUSTOMER_ORG_ID,
        service_account_id: M2M_CLIENT_ID,
        material_hash: leased.receipt.materialHash,
      });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (settlement.connection) {
            yield* setupClient.connections
              .remove({ params: { integration, name: connectionName } })
              .pipe(Effect.ignore);
          }
          yield* setupClient.connections
            .remove({ params: { integration, name: forbiddenConnectionName } })
            .pipe(Effect.ignore);
          yield* setupClient.openapi
            .removeSpec({ params: { slug: forbiddenIntegration } })
            .pipe(Effect.ignore);
          if (settlement.spec) {
            yield* setupClient.openapi
              .removeSpec({ params: { slug: integration } })
              .pipe(Effect.ignore);
          }
        }).pipe(Effect.ignore),
      ),
    );
  }),
);
