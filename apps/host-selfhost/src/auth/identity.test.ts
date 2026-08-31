import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import type { Organization, OrganizationMembership, User } from "@workos-inc/node";

import { AccountProvider, IdentityProvider } from "@executor-js/api/server";
import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import type { WorkOSConfig } from "../config";
import { makeWorkOSAccountProvider } from "../account/workos-account-provider";
import type { ApiKeyService } from "./api-keys";
import {
  authorizeWorkOSServiceRequest,
  makeWorkOSIdentityLayer,
  principalFromVerifiedWorkOSToken,
} from "./identity";
import type { OrganizationStore, StoredOrganization } from "./organization-store";
import type { WorkOSClient } from "./workos";

const now = "2026-07-10T12:00:00.000Z";
const organization: Organization = {
  object: "organization",
  id: "org_allowed",
  name: "Manifest",
  allowProfilesOutsideOrganization: false,
  domains: [],
  createdAt: now,
  updatedAt: now,
  externalId: null,
  metadata: {},
};
const storedOrganization: StoredOrganization = {
  id: organization.id,
  name: organization.name,
  slug: "manifest",
};
const user: User = {
  object: "user",
  id: "user_123",
  email: "operator@example.com",
  emailVerified: true,
  profilePictureUrl: null,
  firstName: "Manifest",
  lastName: "Operator",
  lastSignInAt: now,
  locale: null,
  createdAt: now,
  updatedAt: now,
  externalId: null,
  metadata: {},
};
const membership: OrganizationMembership = {
  object: "organization_membership",
  id: "om_123",
  organizationId: organization.id,
  organizationName: organization.name,
  status: "active",
  userId: user.id,
  directoryManaged: false,
  createdAt: now,
  updatedAt: now,
  customAttributes: {},
  role: { slug: "admin" },
};

const config: WorkOSConfig = {
  apiKey: "sk_test",
  clientId: "client_executor",
  cookiePassword: "test-cookie-password-at-least-32-characters",
  apiUrl: undefined,
  authkitDomain: "https://example.authkit.app",
  redirectUri: "https://executor.example.com/api/auth/callback",
  serviceOrganizationId: "org_platform",
  allowedOrganizationIds: new Set([organization.id]),
  cliClientId: "client_cli",
  connectAudience: "client_executor",
  m2mAllowedClientIds: new Set(["client_trigger"]),
  leaseRequiredScope: "credentials:lease",
  leaseDefaultTtlSeconds: 300,
  leaseMaxTtlSeconds: 900,
  mcpScopes: ["openid"],
};

const unavailable = <A>(): Effect.Effect<A> => Effect.die("unused WorkOS test method");

const workos: WorkOSClient = {
  userJwksUrl: "https://example.authkit.app/sso/jwks/client_executor",
  getAuthorizationUrl: () => "https://example.authkit.app/login",
  authenticateWithCode: unavailable,
  authenticateSealedSession: (sealedSession) =>
    Effect.succeed(
      sealedSession === "valid-session"
        ? {
            accountId: user.id,
            email: user.email,
            name: "Manifest Operator",
            avatarUrl: null,
            organizationId: organization.id,
            sessionId: "session_123",
            roles: ["admin"],
            permissions: ["members:manage"],
            sealedSession,
            refreshedSession: null,
          }
        : null,
    ),
  refreshSession: unavailable,
  getLogoutUrl: unavailable,
  createOrganization: unavailable,
  updateOrganization: unavailable,
  getOrganization: (organizationId) =>
    organizationId === organization.id ? Effect.succeed(organization) : Effect.die("missing org"),
  createMembership: unavailable,
  listUserMemberships: () => Effect.succeed([membership]),
  listOrgMembers: () => Effect.succeed([membership]),
  getUserOrgMembership: (organizationId, userId) =>
    Effect.succeed(organizationId === organization.id && userId === user.id ? membership : null),
  getOrgMembership: () => Effect.succeed(membership),
  getUser: () => Effect.succeed(user),
  sendInvitation: unavailable,
  deleteOrgMembership: unavailable,
  updateOrgMembershipRole: unavailable,
  listOrgRoles: () => Effect.succeed([]),
  validateApiKey: unavailable,
  listUserApiKeys: unavailable,
  createUserApiKey: unavailable,
  deleteApiKey: unavailable,
  getConnectApplication: (clientId) =>
    Effect.succeed(
      clientId === "client_trigger"
        ? {
            id: "connect_trigger",
            clientId,
            organizationId: config.serviceOrganizationId,
            applicationType: "m2m",
            scopes: ["credentials:lease"],
          }
        : null,
    ),
};

const organizations: OrganizationStore = {
  getById: (id) => Effect.succeed(id === organization.id ? storedOrganization : null),
  getBySlug: (slug) => Effect.succeed(slug === storedOrganization.slug ? storedOrganization : null),
  upsert: () => Effect.succeed(storedOrganization),
};

const apiKeys: ApiKeyService = {
  validate: (value) =>
    Effect.succeed(
      value === "workos-api-key"
        ? {
            accountId: user.id,
            organizationId: organization.id,
            keyId: "api_key_123",
            roles: [],
            permissions: [],
          }
        : null,
    ),
  listUserKeys: unavailable,
  createUserKey: unavailable,
  revokeUserKey: unavailable,
};

const authenticateWith = (
  request: Request,
  overrides: Partial<{
    workos: WorkOSClient;
    apiKeys: ApiKeyService;
  }> = {},
) =>
  Effect.gen(function* () {
    const provider = yield* IdentityProvider;
    return yield* provider.authenticate(request);
  }).pipe(
    Effect.provide(
      makeWorkOSIdentityLayer({
        config,
        workos: overrides.workos ?? workos,
        organizations,
        apiKeys: overrides.apiKeys ?? apiKeys,
      }),
    ),
  );

const authenticate = (request: Request) => authenticateWith(request);

describe("WorkOS identity provider", () => {
  it.effect("denies machine identities outside their exact scoped service routes", () =>
    Effect.gen(function* () {
      const servicePrincipal = {
        kind: "service" as const,
        accountId: "client_trigger",
        organizationId: organization.id,
        organizationName: organization.name,
        email: "",
        name: "client_trigger",
        avatarUrl: null,
        roles: ["service"],
        scopes: ["connections:handoff"],
      };
      const admitted = yield* authorizeWorkOSServiceRequest(
        servicePrincipal,
        new Request("https://executor.example.com/api/connection-handoffs", { method: "POST" }),
      );
      const generic = yield* authorizeWorkOSServiceRequest(
        servicePrincipal,
        new Request("https://executor.example.com/api/openapi/specs", { method: "POST" }),
      ).pipe(Effect.result);
      const leaseOnlyHandoff = yield* authorizeWorkOSServiceRequest(
        { ...servicePrincipal, scopes: ["credentials:lease"] },
        new Request("https://executor.example.com/api/connection-handoffs", { method: "POST" }),
      ).pipe(Effect.result);

      expect(admitted).toBe(servicePrincipal);
      expect(generic).toMatchObject({ _tag: "Failure", failure: { _tag: "NoOrganization" } });
      expect(leaseOnlyHandoff).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "NoOrganization" },
      });
    }),
  );

  it.effect(
    "marks only a verified M2M application as service in the selected target organization",
    () =>
      Effect.gen(function* () {
        const principal = yield* principalFromVerifiedWorkOSToken(
          { config, workos, organizations, apiKeys },
          {
            subject: "client_trigger",
            organizationId: config.serviceOrganizationId,
            scopes: ["credentials:lease"],
            payload: { sub: "client_trigger", org_id: config.serviceOrganizationId },
          },
          new Request("https://executor.example.com/graphql/managed-oauth/profiles/github/ensure", {
            headers: { [EXECUTOR_ORG_SELECTOR_HEADER]: organization.id },
          }),
        );

        expect(principal).toMatchObject({
          kind: "service",
          accountId: "client_trigger",
          organizationId: organization.id,
          roles: ["service"],
          scopes: ["credentials:lease"],
        });
      }),
  );

  it.effect("resolves a browser sealed session into the live organization and role", () =>
    Effect.gen(function* () {
      const principal = yield* authenticate(
        new Request("https://executor.example.com/api/integrations", {
          headers: { cookie: "wos-session=valid-session" },
        }),
      );
      expect(principal).toMatchObject({
        kind: "user",
        accountId: user.id,
        organizationId: organization.id,
        organizationSlug: "manifest",
        roles: ["admin"],
      });
    }),
  );

  const accountMe = (headers: Record<string, string>) =>
    Effect.gen(function* () {
      const provider = yield* AccountProvider;
      return yield* provider.me(headers);
    }).pipe(Effect.provide(makeWorkOSAccountProvider({ config, workos, organizations, apiKeys })));

  it.effect("accepts a WorkOS user API key in the same organization scope", () =>
    Effect.gen(function* () {
      const principal = yield* authenticate(
        new Request("https://executor.example.com/api/connections", {
          headers: { authorization: "Bearer workos-api-key" },
        }),
      );
      expect(principal.organizationId).toBe(organization.id);
      expect(principal.accountId).toBe(user.id);
      expect(principal.kind).toBe("user");
    }),
  );

  it.effect("keeps a human membership role named service classified as a user", () =>
    Effect.gen(function* () {
      const roleCollisionWorkos: WorkOSClient = {
        ...workos,
        getUserOrgMembership: (organizationId, userId) =>
          Effect.succeed(
            organizationId === organization.id && userId === user.id
              ? { ...membership, role: { slug: "service" } }
              : null,
          ),
      };
      const principal = yield* authenticateWith(
        new Request("https://executor.example.com/api/integrations", {
          headers: { cookie: "wos-session=valid-session" },
        }),
        { workos: roleCollisionWorkos },
      );

      expect(principal).toMatchObject({
        kind: "user",
        accountId: user.id,
        roles: ["service"],
      });
    }),
  );

  it.effect("keeps an organization API key classified as a user despite its service role", () =>
    Effect.gen(function* () {
      const organizationApiKeys: ApiKeyService = {
        ...apiKeys,
        validate: (value) =>
          Effect.succeed(
            value === "organization-api-key"
              ? {
                  accountId: "api-key:organization",
                  organizationId: organization.id,
                  keyId: "api_key_organization",
                  roles: ["service"],
                  permissions: [],
                }
              : null,
          ),
      };
      const principal = yield* authenticateWith(
        new Request("https://executor.example.com/api/integrations", {
          headers: { authorization: "Bearer organization-api-key" },
        }),
        { apiKeys: organizationApiKeys },
      );

      expect(principal).toMatchObject({
        kind: "user",
        accountId: "api-key:organization",
        roles: ["service"],
      });
    }),
  );

  it.effect("returns the same WorkOS user and organization through the account seam", () =>
    Effect.gen(function* () {
      const account = yield* accountMe({
        cookie: "wos-session=valid-session",
        [EXECUTOR_ORG_SELECTOR_HEADER]: storedOrganization.slug,
      });
      expect(account).toEqual({
        user: {
          id: user.id,
          email: user.email,
          name: "Manifest Operator",
          avatarUrl: null,
        },
        organization: storedOrganization,
      });
    }),
  );

  it.effect("rejects a forged organization selector", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        authenticate(
          new Request("https://executor.example.com/api/connections", {
            headers: {
              authorization: "Bearer workos-api-key",
              [EXECUTOR_ORG_SELECTOR_HEADER]: "org_other",
            },
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("NoOrganization")(result.failure)).toBe(true);
    }),
  );

  it.effect("fails unauthenticated requests closed", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        authenticate(new Request("https://executor.example.com/api/connections")),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("Unauthorized")(result.failure)).toBe(true);
    }),
  );
});
