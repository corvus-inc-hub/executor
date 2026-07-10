import { randomBytes, timingSafeEqual } from "node:crypto";
import { Effect, Result } from "effect";

import type { SelfHostConfig, WorkOSConfig } from "../config";
import { parseCookie, serializeCookie } from "./cookies";
import { decodeLoginState, encodeLoginState } from "./login-state";
import type { OrganizationStore } from "./organization-store";
import { safeReturnTo } from "./return-to";
import {
  isAllowedOrganization,
  WORKOS_SESSION_COOKIE,
  type WorkOSClient,
  type WorkOSBrowserSession,
} from "./workos";

const LOGIN_STATE_COOKIE = "wos-login-state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const STATE_MAX_AGE_SECONDS = 60 * 10;

export interface WorkOSAuthRouteDeps {
  readonly selfHost: SelfHostConfig;
  readonly config: WorkOSConfig;
  readonly workos: WorkOSClient;
  readonly organizations: OrganizationStore;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const readJson = (request: Request): Promise<unknown | null> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => request.json(),
      catch: () => "invalid_json" as const,
    }).pipe(Effect.orElseSucceed(() => null)),
  );

const withCookie = (response: Response, cookie: string): Response => {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
};

const secureCookies = (deps: WorkOSAuthRouteDeps): boolean =>
  new URL(deps.selfHost.webBaseUrl).protocol === "https:";

const sessionCookie = (
  deps: WorkOSAuthRouteDeps,
  value: string,
  maxAge = SESSION_MAX_AGE_SECONDS,
) =>
  serializeCookie(WORKOS_SESSION_COOKIE, value, {
    maxAge,
    secure: secureCookies(deps),
  });

const stateCookie = (deps: WorkOSAuthRouteDeps, value: string, maxAge = STATE_MAX_AGE_SECONDS) =>
  serializeCookie(LOGIN_STATE_COOKIE, value, {
    maxAge,
    secure: secureCookies(deps),
  });

const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location, "cache-control": "no-store" } });

const sameState = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const requestSession = (deps: WorkOSAuthRouteDeps, request: Request) => {
  const sealed = parseCookie(request.headers.get("cookie"), WORKOS_SESSION_COOKIE);
  return sealed ? deps.workos.authenticateSealedSession(sealed) : Effect.succeed(null);
};

const requireSession = async (
  deps: WorkOSAuthRouteDeps,
  request: Request,
): Promise<WorkOSBrowserSession | null> =>
  Effect.runPromise(requestSession(deps, request).pipe(Effect.orElseSucceed(() => null)));

const handleLogin = (deps: WorkOSAuthRouteDeps, request: Request): Response => {
  const url = new URL(request.url);
  const state = encodeLoginState({
    nonce: randomBytes(32).toString("hex"),
    ...(safeReturnTo(url.searchParams.get("returnTo"))
      ? { returnTo: safeReturnTo(url.searchParams.get("returnTo"))! }
      : {}),
  });
  return withCookie(redirect(deps.workos.getAuthorizationUrl(state)), stateCookie(deps, state));
};

const handleCallback = async (deps: WorkOSAuthRouteDeps, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return json({ error: "Missing authorization code" }, 400);

  const cookieState = parseCookie(request.headers.get("cookie"), LOGIN_STATE_COOKIE);
  if (!state || !cookieState || !sameState(cookieState, state)) {
    return withCookie(json({ error: "Invalid login state" }, 400), stateCookie(deps, "", 0));
  }

  const result = await Effect.runPromise(
    deps.workos.authenticateWithCode(code).pipe(Effect.result),
  );
  if (Result.isFailure(result) || !result.success.sealedSession) {
    return withCookie(
      json({ error: "WorkOS authentication failed" }, 401),
      stateCookie(deps, "", 0),
    );
  }

  const memberships = await Effect.runPromise(
    deps.workos.listUserMemberships(result.success.user.id).pipe(Effect.orElseSucceed(() => [])),
  );
  const organizationId =
    (result.success.organizationId &&
    isAllowedOrganization(deps.config, result.success.organizationId)
      ? result.success.organizationId
      : null) ??
    memberships.find(
      (membership) =>
        membership.status === "active" &&
        isAllowedOrganization(deps.config, membership.organizationId),
    )?.organizationId ??
    null;

  let sealedSession = result.success.sealedSession;
  if (organizationId && organizationId !== result.success.organizationId) {
    const refreshed = await Effect.runPromise(
      deps.workos
        .refreshSession(sealedSession, organizationId)
        .pipe(Effect.orElseSucceed(() => null)),
    );
    if (refreshed) sealedSession = refreshed;
  }

  if (organizationId) {
    const remote = await Effect.runPromise(
      deps.workos.getOrganization(organizationId).pipe(Effect.result),
    );
    if (Result.isFailure(remote)) return json({ error: "Organization lookup failed" }, 503);
    const mirrored = await Effect.runPromise(
      deps.organizations
        .upsert({ id: remote.success.id, name: remote.success.name })
        .pipe(Effect.result),
    );
    if (Result.isFailure(mirrored)) return json({ error: "Organization setup failed" }, 503);
  }

  const returnTo = safeReturnTo(decodeLoginState(state)?.returnTo) ?? "/";
  return withCookie(
    withCookie(redirect(returnTo), sessionCookie(deps, sealedSession)),
    stateCookie(deps, "", 0),
  );
};

const handleLogout = async (deps: WorkOSAuthRouteDeps, request: Request): Promise<Response> => {
  const sealed = parseCookie(request.headers.get("cookie"), WORKOS_SESSION_COOKIE);
  const logoutUrl = sealed
    ? await Effect.runPromise(
        deps.workos
          .getLogoutUrl(sealed, deps.selfHost.webBaseUrl)
          .pipe(Effect.orElseSucceed(() => deps.selfHost.webBaseUrl)),
      )
    : deps.selfHost.webBaseUrl;
  return withCookie(redirect(logoutUrl), sessionCookie(deps, "", 0));
};

const handleCliLogin = (deps: WorkOSAuthRouteDeps): Response =>
  deps.config.cliClientId
    ? json({
        provider: "workos",
        deviceAuthorizationEndpoint: `${deps.config.authkitDomain}/oauth2/device_authorization`,
        tokenEndpoint: `${deps.config.authkitDomain}/oauth2/token`,
        clientId: deps.config.cliClientId,
        scope: deps.config.mcpScopes.join(" "),
        requestFormat: "form",
      })
    : json({ error: "WORKOS_CLI_CLIENT_ID is not configured" }, 503);

const handleOrganizations = async (
  deps: WorkOSAuthRouteDeps,
  request: Request,
): Promise<Response> => {
  const session = await requireSession(deps, request);
  if (!session) return json({ error: "Unauthorized" }, 401);
  const memberships = await Effect.runPromise(
    deps.workos.listUserMemberships(session.accountId).pipe(Effect.result),
  );
  if (Result.isFailure(memberships)) return json({ error: "Organization lookup failed" }, 503);
  const organizations = await Effect.runPromise(
    Effect.all(
      memberships.success
        .filter(
          (membership) =>
            membership.status === "active" &&
            isAllowedOrganization(deps.config, membership.organizationId),
        )
        .map((membership) =>
          deps.workos
            .getOrganization(membership.organizationId)
            .pipe(
              Effect.flatMap((organization) =>
                deps.organizations.upsert({ id: organization.id, name: organization.name }),
              ),
            ),
        ),
      { concurrency: 5 },
    ).pipe(Effect.result),
  );
  if (Result.isFailure(organizations)) return json({ error: "Organization lookup failed" }, 503);
  return json({
    organizations: organizations.success,
    activeOrganizationId: session.organizationId,
  });
};

const handleCreateOrganization = async (
  deps: WorkOSAuthRouteDeps,
  request: Request,
): Promise<Response> => {
  const session = await requireSession(deps, request);
  if (!session) return json({ error: "Unauthorized" }, 401);
  const payload = await readJson(request);
  const name =
    payload && typeof payload === "object" && "name" in payload && typeof payload.name === "string"
      ? payload.name.trim()
      : "";
  if (!name || name.length > 100) return json({ error: "Invalid organization name" }, 400);
  if (deps.config.allowedOrganizationIds.size > 0) {
    return json({ error: "Organization creation is disabled for this deployment" }, 403);
  }

  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const organization = yield* deps.workos.createOrganization(name);
      yield* deps.workos.createMembership(organization.id, session.accountId, "admin");
      const mirrored = yield* deps.organizations.upsert({
        id: organization.id,
        name: organization.name,
      });
      const refreshed = yield* deps.workos.refreshSession(session.sealedSession, organization.id);
      if (!refreshed) return yield* Effect.fail("session_refresh_failed");
      return { organization: mirrored, sealedSession: refreshed };
    }).pipe(Effect.result),
  );
  if (Result.isFailure(created)) return json({ error: "Organization creation failed" }, 503);
  return withCookie(
    json(created.success.organization, 201),
    sessionCookie(deps, created.success.sealedSession),
  );
};

export const makeWorkOSAuthHandler =
  (deps: WorkOSAuthRouteDeps) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method.toUpperCase()} ${url.pathname}`;
    if (route === "GET /api/auth/login") return handleLogin(deps, request);
    if (route === "GET /api/auth/callback") return handleCallback(deps, request);
    if (route === "GET /api/auth/logout" || route === "POST /api/auth/logout") {
      return handleLogout(deps, request);
    }
    if (route === "GET /api/auth/cli-login") return handleCliLogin(deps);
    if (route === "GET /api/auth/organizations") return handleOrganizations(deps, request);
    if (route === "POST /api/auth/create-organization") {
      return handleCreateOrganization(deps, request);
    }
    return json({ error: "Not found" }, 404);
  };
