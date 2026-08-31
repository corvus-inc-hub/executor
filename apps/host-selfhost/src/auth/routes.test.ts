import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { SelfHostConfig, WorkOSConfig } from "../config";
import type { OrganizationStore } from "./organization-store";
import { makeWorkOSAuthHandler } from "./routes";
import type { WorkOSClient } from "./workos";

const selfHost: SelfHostConfig = {
  host: "127.0.0.1",
  port: 4788,
  dbPath: ":memory:",
  webBaseUrl: "https://executor.example.com",
  allowLocalNetwork: false,
  connectionReturnOrigins: [],
};

const config: WorkOSConfig = {
  apiKey: "sk_test",
  clientId: "client_executor",
  cookiePassword: "test-cookie-password-at-least-32-characters",
  apiUrl: undefined,
  authkitDomain: "https://example.authkit.app",
  redirectUri: "https://executor.example.com/api/auth/callback",
  serviceOrganizationId: "org_platform",
  allowedOrganizationIds: new Set(),
  cliClientId: "client_cli",
  connectAudience: "client_executor",
  m2mAllowedClientIds: new Set(),
  leaseRequiredScope: "credentials:lease",
  leaseDefaultTtlSeconds: 300,
  leaseMaxTtlSeconds: 900,
  mcpScopes: ["openid"],
};

const unavailable = <A>(): Effect.Effect<A> => Effect.die("unused WorkOS test method");

const organizations: OrganizationStore = {
  getById: unavailable,
  getBySlug: unavailable,
  upsert: unavailable,
};

const workosClient = (exchangeAttempted: () => void): WorkOSClient => ({
  userJwksUrl: "https://example.authkit.app/sso/jwks/client_executor",
  getAuthorizationUrl: (state) =>
    `https://example.authkit.app/oauth2/authorize?state=${encodeURIComponent(state)}`,
  authenticateWithCode: () => {
    exchangeAttempted();
    return unavailable();
  },
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
  getConnectApplication: unavailable,
});

describe("WorkOS auth routes", () => {
  it.effect("starts login with a state cookie and the same authorization state", () =>
    Effect.promise(async () => {
      const handler = makeWorkOSAuthHandler({
        selfHost,
        config,
        workos: workosClient(() => undefined),
        organizations,
      });
      const response = await handler(
        new Request("https://executor.example.com/api/auth/login?returnTo=%2Fmanifest%2Ftools"),
      );
      const location = response.headers.get("location");
      const cookie = response.headers.get("set-cookie");
      expect(response.status).toBe(302);
      expect(location).toContain("https://example.authkit.app/oauth2/authorize?state=");
      expect(cookie).toContain("wos-login-state=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
    }),
  );

  it.effect("rejects a callback without matching state before code exchange", () =>
    Effect.promise(async () => {
      let exchanged = false;
      const handler = makeWorkOSAuthHandler({
        selfHost,
        config,
        workos: workosClient(() => {
          exchanged = true;
        }),
        organizations,
      });
      const response = await handler(
        new Request("https://executor.example.com/api/auth/callback?code=code_123"),
      );
      expect(response.status).toBe(400);
      expect(exchanged).toBe(false);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    }),
  );

  it.effect("publishes WorkOS Connect device endpoints for the CLI", () =>
    Effect.promise(async () => {
      const handler = makeWorkOSAuthHandler({
        selfHost,
        config,
        workos: workosClient(() => undefined),
        organizations,
      });
      const response = await handler(
        new Request("https://executor.example.com/api/auth/cli-login"),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        provider: "workos",
        deviceAuthorizationEndpoint: "https://example.authkit.app/oauth2/device_authorization",
        tokenEndpoint: "https://example.authkit.app/oauth2/token",
        clientId: "client_cli",
        scope: "openid",
        requestFormat: "form",
      });
    }),
  );
});
