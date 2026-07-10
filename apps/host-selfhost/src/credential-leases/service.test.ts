import { createClient } from "@libsql/client";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  ProviderKey,
  type Connection,
} from "@executor-js/sdk";

import type { WorkOSConfig } from "../config";
import { ensureWorkOSIdentityTables } from "../auth/organization-store";
import type { WorkOSClient } from "../auth/workos";
import type { AwsRoleAssumer, AwsRoleAssumptionInput } from "./aws-role-assumer";
import { makeCredentialLeaseService, type CredentialLeaseRequest } from "./service";

const config: WorkOSConfig = {
  apiKey: "sk_test",
  clientId: "client_executor",
  cookiePassword: "test-cookie-password-at-least-32-characters",
  apiUrl: undefined,
  authkitDomain: "https://example.authkit.app",
  redirectUri: "https://executor.example.com/api/auth/callback",
  serviceOrganizationId: "org_platform",
  allowedOrganizationIds: new Set(["org_allowed"]),
  cliClientId: "client_cli",
  connectAudience: "client_executor",
  m2mAllowedClientIds: new Set(["client_trigger"]),
  leaseRequiredScope: "credentials:lease",
  leaseDefaultTtlSeconds: 300,
  leaseMaxTtlSeconds: 900,
  mcpScopes: ["openid"],
};

const unavailable = <A>(): Effect.Effect<A> => Effect.die("unused WorkOS test method");
const assumeAwsRoleUnused: AwsRoleAssumer = () => Effect.die("unused AWS test method");

const workos: WorkOSClient = {
  userJwksUrl: "https://example.authkit.app/sso/jwks/client_executor",
  getAuthorizationUrl: () => "https://example.authkit.app/login",
  authenticateWithCode: unavailable,
  authenticateSealedSession: unavailable,
  refreshSession: unavailable,
  getLogoutUrl: unavailable,
  createOrganization: unavailable,
  updateOrganization: unavailable,
  getOrganization: unavailable,
  createMembership: unavailable,
  listUserMemberships: unavailable,
  listOrgMembers: unavailable,
  getUserOrgMembership: unavailable,
  getOrgMembership: unavailable,
  getUser: unavailable,
  sendInvitation: unavailable,
  deleteOrgMembership: unavailable,
  updateOrgMembershipRole: unavailable,
  listOrgRoles: unavailable,
  validateApiKey: unavailable,
  listUserApiKeys: unavailable,
  createUserApiKey: unavailable,
  deleteApiKey: unavailable,
  getConnectApplication: (clientId) =>
    Effect.succeed(
      clientId === "client_trigger"
        ? {
            id: "app_trigger",
            clientId,
            organizationId: "org_platform",
            applicationType: "m2m",
            scopes: ["credentials:lease"],
          }
        : null,
    ),
};

const connection: Connection = {
  owner: "org",
  name: ConnectionName.make("github-prod"),
  integration: IntegrationSlug.make("github"),
  template: AuthTemplateSlug.make("oauth"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("tools.github.org.github-prod"),
  oauthScope: "github:read",
};

const input: CredentialLeaseRequest = {
  organizationId: "org_allowed",
  workspaceId: "workspace_manifest",
  runId: "run_123",
  credential: { integration: "github", name: "github-prod" },
  purpose: "Run approved GitHub release workflow",
  scopes: ["github:read"],
  ttlSeconds: 120,
  delivery: {
    environment: { GITHUB_TOKEN: "token" },
    secretFiles: [{ name: "github.pem", variable: "certificate" }],
  },
};

const awsConnection: Connection = {
  owner: "org",
  name: ConnectionName.make("bedrock-production"),
  integration: IntegrationSlug.make("amazonaws.com"),
  template: AuthTemplateSlug.make("role"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("tools.amazonaws.com.bedrock-production"),
  oauthScope: "inference",
};

const awsInput: CredentialLeaseRequest = {
  organizationId: "org_allowed",
  workspaceId: "workspace_manifest",
  runId: "run_bedrock_123",
  credential: { integration: "amazonaws.com", name: "bedrock-production" },
  purpose: "Run approved Bedrock inference",
  scopes: ["inference"],
  ttlSeconds: 120,
  delivery: {
    environment: {
      AWS_ACCESS_KEY_ID: "AWS_ACCESS_KEY_ID",
      AWS_SECRET_ACCESS_KEY: "AWS_SECRET_ACCESS_KEY",
      AWS_SESSION_TOKEN: "AWS_SESSION_TOKEN",
      AWS_REGION: "AWS_REGION",
    },
  },
};

const request = new Request("https://executor.example.com/api/credential-leases", {
  method: "POST",
  headers: { authorization: "Bearer header.payload.signature" },
});

const verified =
  (organizationId = "org_platform", scopes: readonly string[] = ["credentials:lease"]) =>
  () =>
    Effect.succeed({
      subject: "client_trigger",
      organizationId,
      scopes,
      payload: {},
    });

describe("credential lease service", () => {
  it.effect("returns real material and persists only metadata and hashes", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const db = createClient({ url: ":memory:" });
        await Effect.runPromise(ensureWorkOSIdentityTables(db));
        return db;
      }),
      (db) =>
        Effect.gen(function* () {
          const service = makeCredentialLeaseService({
            config,
            workos,
            db,
            assumeAwsRole: assumeAwsRoleUnused,
            verifyM2mToken: verified(),
            now: () => new Date("2026-07-10T12:00:00.000Z"),
            uuid: () => "lease_123",
            resolveCredential: () =>
              Effect.succeed({
                connection,
                values: { token: "secret-token", certificate: "secret-certificate" },
              }),
          });

          const response = yield* service.lease(request, input);
          expect(response.material).toEqual({
            environment: { GITHUB_TOKEN: "secret-token" },
            secretFiles: [{ name: "github.pem", content: "secret-certificate", mode: "0600" }],
          });
          expect(response.lease).toMatchObject({
            disposeAfter: "2026-07-10T12:02:00.000Z",
            enforcement: "sandbox_cleanup",
            sourceCredentialExpiresAt: null,
          });

          const receipt = yield* Effect.promise(() =>
            db.execute("SELECT * FROM credential_lease_receipt WHERE id = 'lease_123'"),
          );
          const serialized = JSON.stringify(receipt.rows[0]);
          expect(serialized).not.toContain("secret-token");
          expect(serialized).not.toContain("secret-certificate");
          expect(serialized).toContain(response.receipt.materialHash);
        }),
      (db) => Effect.sync(() => db.close()),
    ),
  );

  it.effect("fails closed when the credential cannot be resolved", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const db = createClient({ url: ":memory:" });
        await Effect.runPromise(ensureWorkOSIdentityTables(db));
        return db;
      }),
      (db) =>
        Effect.gen(function* () {
          const service = makeCredentialLeaseService({
            config,
            workos,
            db,
            assumeAwsRole: assumeAwsRoleUnused,
            verifyM2mToken: verified(),
            resolveCredential: () => Effect.succeed(null),
          });
          const result = yield* Effect.result(service.lease(request, input));
          expect(Result.isFailure(result)).toBe(true);
          if (!Result.isFailure(result)) return;
          expect(result.failure).toMatchObject({
            code: "credential_unavailable",
            status: 409,
          });
          const receipts = yield* Effect.promise(() =>
            db.execute("SELECT id FROM credential_lease_receipt"),
          );
          expect(receipts.rows).toHaveLength(0);
        }),
      (db) => Effect.sync(() => db.close()),
    ),
  );

  it.effect("rejects an M2M token from a different organization", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const db = createClient({ url: ":memory:" });
        await Effect.runPromise(ensureWorkOSIdentityTables(db));
        return db;
      }),
      (db) =>
        Effect.gen(function* () {
          let resolved = false;
          const service = makeCredentialLeaseService({
            config,
            workos,
            db,
            assumeAwsRole: assumeAwsRoleUnused,
            verifyM2mToken: verified("org_other"),
            resolveCredential: () => {
              resolved = true;
              return Effect.succeed({ connection, values: { token: "should-not-resolve" } });
            },
          });
          const result = yield* Effect.result(service.lease(request, input));
          expect(Result.isFailure(result)).toBe(true);
          if (!Result.isFailure(result)) return;
          expect(result.failure).toMatchObject({ code: "forbidden", status: 403 });
          expect(resolved).toBe(false);
        }),
      (db) => Effect.sync(() => db.close()),
    ),
  );

  it.effect("rejects a token without the credential lease permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const db = createClient({ url: ":memory:" });
        await Effect.runPromise(ensureWorkOSIdentityTables(db));
        return db;
      }),
      (db) =>
        Effect.gen(function* () {
          let resolved = false;
          const service = makeCredentialLeaseService({
            config,
            workos,
            db,
            assumeAwsRole: assumeAwsRoleUnused,
            verifyM2mToken: verified("org_allowed", ["github:read"]),
            resolveCredential: () => {
              resolved = true;
              return Effect.succeed({ connection, values: { token: "should-not-resolve" } });
            },
          });
          const result = yield* Effect.result(service.lease(request, input));
          expect(Result.isFailure(result)).toBe(true);
          if (!Result.isFailure(result)) return;
          expect(result.failure).toMatchObject({ code: "forbidden", status: 403 });
          expect(resolved).toBe(false);
        }),
      (db) => Effect.sync(() => db.close()),
    ),
  );

  it.effect("materializes an AWS role into an expiring STS session", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const db = createClient({ url: ":memory:" });
        await Effect.runPromise(ensureWorkOSIdentityTables(db));
        return db;
      }),
      (db) =>
        Effect.gen(function* () {
          let assumption: AwsRoleAssumptionInput | undefined;
          const service = makeCredentialLeaseService({
            config,
            workos,
            db,
            assumeAwsRole: (input) => {
              assumption = input;
              return Effect.succeed({
                accessKeyId: "ASIA_TEMPORARY",
                secretAccessKey: "temporary-secret",
                sessionToken: "temporary-session",
                expiresAt: Date.parse("2026-07-10T12:15:00.000Z"),
              });
            },
            verifyM2mToken: verified(),
            now: () => new Date("2026-07-10T12:00:00.000Z"),
            uuid: () => "lease_aws_123",
            resolveCredential: () =>
              Effect.succeed({
                connection: awsConnection,
                values: {
                  AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/executor-bedrock",
                  AWS_REGION: "us-east-1",
                  AWS_EXTERNAL_ID: "manifest-production",
                },
              }),
          });

          const response = yield* service.lease(request, awsInput);
          expect(assumption).toMatchObject({
            roleArn: "arn:aws:iam::123456789012:role/executor-bedrock",
            region: "us-east-1",
            externalId: "manifest-production",
            durationSeconds: 900,
          });
          expect(assumption?.roleSessionName).toMatch(/^executor-[a-f0-9]{32}$/);
          expect(response.material).toEqual({
            environment: {
              AWS_ACCESS_KEY_ID: "ASIA_TEMPORARY",
              AWS_SECRET_ACCESS_KEY: "temporary-secret",
              AWS_SESSION_TOKEN: "temporary-session",
              AWS_REGION: "us-east-1",
            },
            secretFiles: [],
          });
          expect(response.lease).toMatchObject({
            disposeAfter: "2026-07-10T12:02:00.000Z",
            sourceCredentialExpiresAt: "2026-07-10T12:15:00.000Z",
          });

          const receipt = yield* Effect.promise(() =>
            db.execute("SELECT * FROM credential_lease_receipt WHERE id = 'lease_aws_123'"),
          );
          const serialized = JSON.stringify(receipt.rows[0]);
          expect(serialized).not.toContain("ASIA_TEMPORARY");
          expect(serialized).not.toContain("temporary-secret");
          expect(serialized).not.toContain("temporary-session");
        }),
      (db) => Effect.sync(() => db.close()),
    ),
  );

  it.effect("rejects static AWS access keys without calling STS", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const db = createClient({ url: ":memory:" });
        await Effect.runPromise(ensureWorkOSIdentityTables(db));
        return db;
      }),
      (db) =>
        Effect.gen(function* () {
          let assumed = false;
          const service = makeCredentialLeaseService({
            config,
            workos,
            db,
            assumeAwsRole: () => {
              assumed = true;
              return Effect.die("STS must not be called for static AWS credentials");
            },
            verifyM2mToken: verified(),
            resolveCredential: () =>
              Effect.succeed({
                connection: awsConnection,
                values: {
                  AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/executor-bedrock",
                  AWS_REGION: "us-east-1",
                  AWS_ACCESS_KEY_ID: "AKIA_STATIC",
                  AWS_SECRET_ACCESS_KEY: "static-secret",
                },
              }),
          });

          const result = yield* Effect.result(service.lease(request, awsInput));
          expect(Result.isFailure(result)).toBe(true);
          if (!Result.isFailure(result)) return;
          expect(result.failure).toMatchObject({
            code: "credential_unavailable",
            status: 409,
          });
          expect(assumed).toBe(false);
          const receipts = yield* Effect.promise(() =>
            db.execute("SELECT id FROM credential_lease_receipt"),
          );
          expect(receipts.rows).toHaveLength(0);
        }),
      (db) => Effect.sync(() => db.close()),
    ),
  );
});
