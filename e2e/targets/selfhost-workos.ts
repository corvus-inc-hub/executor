import { Effect } from "effect";

import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import type { Identity, Target } from "../src/target";

export const WORKOS_PLATFORM_ORG_ID = "org_platform";
export const WORKOS_CUSTOMER_ORG_ID = "org_manifest_delivery_e2e";
export const WORKOS_FORBIDDEN_ORG_ID = "org_unrelated_customer";
export const WORKOS_USER_ID = "user_manifest_delivery_e2e";
export const WORKOS_USER_EMAIL = "delivery-user@manifest.e2e";
export const M2M_CLIENT_ID = "client_manifest_trigger";
export const M2M_CLIENT_SECRET = "secret_manifest_trigger_e2e";
export const M2M_SCOPE = "credentials:lease";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the selfhost-workos target`);
  return value;
};

const cookiePair = (response: Response, name: string): string | undefined => {
  const combined = (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""])
    .filter(Boolean)
    .join(", ");
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`).exec(combined);
  return match?.[1] ? `${name}=${match[1]}` : undefined;
};

const signIn = async (baseUrl: string): Promise<string> => {
  const login = await fetch(new URL("/api/auth/login", baseUrl), { redirect: "manual" });
  const stateCookie = cookiePair(login, "wos-login-state");
  const location = login.headers.get("location");
  if (!stateCookie || !location) throw new Error(`WorkOS login did not redirect (${login.status})`);
  const authorizeUrl = new URL(location);
  authorizeUrl.searchParams.set("login_hint", WORKOS_USER_EMAIL);
  const authorization = await fetch(authorizeUrl, { redirect: "manual" });
  const callbackUrl = authorization.headers.get("location");
  if (!callbackUrl) throw new Error(`WorkOS authorize did not redirect (${authorization.status})`);
  const callback = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { cookie: stateCookie },
  });
  const session = cookiePair(callback, "wos-session");
  if (!session) {
    const cookieNames = (callback.headers.getSetCookie?.() ?? []).map((value) =>
      value.slice(0, value.indexOf("=")),
    );
    const redactedSetCookie = callback.headers
      .get("set-cookie")
      ?.replace(/=([^;,]+)/g, "=<redacted>");
    throw new Error(
      `WorkOS callback set no session (${callback.status}); cookies=${cookieNames.join(",") || "none"}; set-cookie=${redactedSetCookie ?? "none"}`,
    );
  }
  return session;
};

const mintServiceToken = async (scopes: readonly string[]): Promise<string> => {
  const response = await fetch(new URL("/oauth2/token", required("E2E_SELFHOST_WORKOS_AUTH_URL")), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: M2M_CLIENT_ID,
      client_secret: M2M_CLIENT_SECRET,
      scope: scopes.join(" "),
    }),
  });
  if (!response.ok) throw new Error(`WorkOS client_credentials failed (${response.status})`);
  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  if (typeof body?.access_token !== "string") {
    throw new Error("WorkOS client_credentials returned no access token");
  }
  return body.access_token;
};

export const selfhostWorkosTarget = (): Target => {
  const baseUrl = required("E2E_SELFHOST_WORKOS_URL");
  return {
    name: "selfhost-workos",
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    capabilities: new Set(["api", "browser"]),
    newIdentity: () =>
      Effect.promise(async (): Promise<Identity> => {
        const session = await signIn(baseUrl);
        const [name, value] = session.split(/=(.*)/s);
        return {
          label: WORKOS_USER_EMAIL,
          subject: WORKOS_USER_ID,
          headers: { cookie: session },
          cookies: [{ name: name!, value: value! }],
          credentials: { email: WORKOS_USER_EMAIL, password: "manifest-e2e-password" },
        };
      }),
    newServiceIdentity: ({ scopes = [M2M_SCOPE] } = {}) =>
      Effect.promise(async (): Promise<Identity> => {
        const token = await mintServiceToken(scopes);
        return {
          label: M2M_CLIENT_ID,
          subject: M2M_CLIENT_ID,
          headers: {
            authorization: `Bearer ${token}`,
            [EXECUTOR_ORG_SELECTOR_HEADER]: WORKOS_CUSTOMER_ORG_ID,
          },
        };
      }),
  };
};
