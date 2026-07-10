import { Effect, Layer, Result } from "effect";

import {
  authenticated,
  forbidden,
  McpAuthProvider,
  unauthorized,
  unavailable,
  type AuthOutcome,
  type McpDiscoveryRoute,
  type Principal,
} from "@executor-js/host-mcp";

import type { WorkOSIdentityDeps } from "../auth/identity";
import { cachedRemoteJwks, verifyWorkOSAccessToken } from "../auth/jwt";
import {
  authorizeServiceOrganization,
  authorizeUserOrganization,
  ORG_SELECTOR_HEADER,
  organizationIdFromSelector,
  resolveOrganization,
} from "../auth/organization";
import { MCP_ORIGINAL_PATH_HEADER, mcpResourcePathFromOriginalPath } from "./org-path";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp/toolkits/:toolkitSlug`;
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });

const originalResourcePath = (request: Request): string | null => {
  const original = request.headers.get(MCP_ORIGINAL_PATH_HEADER);
  return original ? mcpResourcePathFromOriginalPath(original) : null;
};

const toolkitSlug = (request: Request): string | null => {
  const pathname = originalResourcePath(request) ?? new URL(request.url).pathname;
  const marker = "/mcp/toolkits/";
  const index = pathname.indexOf(marker);
  if (index < 0) return null;
  return pathname.slice(index + marker.length).split("/", 1)[0] || null;
};

const resourcePath = (request: Request): string => {
  const original = originalResourcePath(request);
  if (original) return original;
  const toolkit = toolkitSlug(request);
  return toolkit ? `/mcp/toolkits/${toolkit}` : "/mcp";
};

const resourceUrl = (deps: WorkOSIdentityDeps, request: Request): string =>
  new URL(resourcePath(request), deps.config.redirectUri).toString();

const metadataUrl = (deps: WorkOSIdentityDeps, request: Request): string => {
  const path = originalResourcePath(request);
  const toolkit = toolkitSlug(request);
  const suffix = path ? path : toolkit ? `/mcp/toolkits/${toolkit}` : "";
  return new URL(
    `${PROTECTED_RESOURCE_METADATA_PATH}${suffix}`,
    deps.config.redirectUri,
  ).toString();
};

const organizationSelector = (request: Request): string | null => {
  const path = originalResourcePath(request);
  const [firstSegment] = path?.split("/").filter(Boolean) ?? [];
  const pathSelector = firstSegment && firstSegment !== "mcp" ? firstSegment : null;
  return pathSelector ?? request.headers.get(ORG_SELECTOR_HEADER)?.trim() ?? null;
};

const hasAudience = (audience: string | readonly string[] | undefined, expected: string): boolean =>
  typeof audience === "string" ? audience === expected : (audience?.includes(expected) ?? false);

const challenge = (deps: WorkOSIdentityDeps, request: Request, invalid = false): string =>
  [
    "Bearer",
    ...(invalid ? ['error="invalid_token"'] : []),
    `resource_metadata="${metadataUrl(deps, request)}"`,
  ].join(" ");

const principal = (
  accountId: string,
  organization: { readonly id: string; readonly name: string; readonly slug: string },
  roles: readonly string[],
): Principal => ({
  accountId,
  organizationId: organization.id,
  organizationName: organization.name,
  email: "",
  name: null,
  avatarUrl: null,
  roles,
});

const authorizeJwt = (
  deps: WorkOSIdentityDeps,
  request: Request,
  token: string,
): Effect.Effect<AuthOutcome> =>
  Effect.gen(function* () {
    const verified = yield* verifyWorkOSAccessToken(
      token,
      cachedRemoteJwks(`${deps.config.authkitDomain}/oauth2/jwks`),
      {
        issuer: deps.config.authkitDomain,
        audience: [resourceUrl(deps, request), deps.config.connectAudience],
      },
    ).pipe(Effect.result);
    if (Result.isFailure(verified)) {
      return verified.failure.reason === "system"
        ? unavailable("Authentication temporarily unavailable")
        : unauthorized(challenge(deps, request, true));
    }
    if (!verified.success?.organizationId) {
      return forbidden("No organization in WorkOS token", -32001);
    }

    if (verified.success.subject.startsWith("client_")) {
      if (
        verified.success.organizationId !== deps.config.serviceOrganizationId ||
        !hasAudience(verified.success.payload.aud, deps.config.connectAudience)
      ) {
        return unauthorized(challenge(deps, request, true));
      }
      const selected = organizationSelector(request);
      if (!selected) return forbidden("A target organization is required", -32001);
      const organizationId = yield* organizationIdFromSelector(deps, selected).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (!organizationId) return forbidden("Organization is not authorized", -32001);
      const authorized = yield* authorizeServiceOrganization(
        deps,
        verified.success.subject,
        organizationId,
      ).pipe(Effect.result);
      if (Result.isFailure(authorized)) return unavailable("Organization lookup unavailable");
      return authorized.success
        ? authenticated(principal(verified.success.subject, authorized.success, ["service"]))
        : forbidden("Organization is not authorized", -32001);
    }

    if (!hasAudience(verified.success.payload.aud, resourceUrl(deps, request))) {
      return unauthorized(challenge(deps, request, true));
    }
    const selected = organizationSelector(request);
    const organizationId = selected
      ? yield* organizationIdFromSelector(deps, selected).pipe(Effect.orElseSucceed(() => null))
      : verified.success.organizationId;
    if (!organizationId || organizationId !== verified.success.organizationId) {
      return forbidden("Organization is not authorized", -32001);
    }

    const authorized = yield* authorizeUserOrganization(
      deps,
      verified.success.subject,
      organizationId,
    ).pipe(Effect.result);
    if (Result.isFailure(authorized)) return unavailable("Organization lookup unavailable");
    return authorized.success
      ? authenticated(
          principal(verified.success.subject, authorized.success, authorized.success.roles),
        )
      : forbidden("Organization is not authorized", -32001);
  });

const authorizeApiKey = (
  deps: WorkOSIdentityDeps,
  request: Request,
  token: string,
): Effect.Effect<AuthOutcome> =>
  Effect.gen(function* () {
    const key = yield* deps.apiKeys.validate(token).pipe(Effect.result);
    if (Result.isFailure(key)) return unavailable("API key validation unavailable");
    if (!key.success) return unauthorized(challenge(deps, request, true));

    const selected = organizationSelector(request);
    const selectedId = selected
      ? yield* organizationIdFromSelector(deps, selected).pipe(Effect.orElseSucceed(() => null))
      : key.success.organizationId;
    if (!selectedId || selectedId !== key.success.organizationId) {
      return forbidden("Organization is not authorized", -32001);
    }

    if (key.success.accountId.startsWith("api-key:")) {
      const organization = yield* resolveOrganization(deps, selectedId).pipe(Effect.result);
      if (Result.isFailure(organization)) return unavailable("Organization lookup unavailable");
      return organization.success
        ? authenticated(principal(key.success.accountId, organization.success, ["service"]))
        : forbidden("Organization is not authorized", -32001);
    }

    const organization = yield* authorizeUserOrganization(
      deps,
      key.success.accountId,
      selectedId,
    ).pipe(Effect.result);
    if (Result.isFailure(organization)) return unavailable("Organization lookup unavailable");
    return organization.success
      ? authenticated(
          principal(key.success.accountId, organization.success, organization.success.roles),
        )
      : forbidden("Organization is not authorized", -32001);
  });

export const makeSelfHostMcpAuth = (deps: WorkOSIdentityDeps): Layer.Layer<McpAuthProvider> =>
  Layer.succeed(McpAuthProvider)({
    discoveryRoutes: [
      {
        path: PROTECTED_RESOURCE_METADATA_PATH,
        handler: (request) =>
          Effect.succeed(
            json({
              resource: resourceUrl(deps, request),
              authorization_servers: [deps.config.authkitDomain],
              bearer_methods_supported: ["header"],
              scopes_supported: deps.config.mcpScopes,
            }),
          ),
      },
      {
        path: TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH,
        handler: (request) =>
          Effect.succeed(
            json({
              resource: resourceUrl(deps, request),
              authorization_servers: [deps.config.authkitDomain],
              bearer_methods_supported: ["header"],
              scopes_supported: deps.config.mcpScopes,
            }),
          ),
      },
      {
        path: AUTHORIZATION_SERVER_METADATA_PATH,
        handler: () =>
          Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `${deps.config.authkitDomain}/.well-known/oauth-authorization-server`,
              );
              return response.ok
                ? json(await response.json())
                : json({ error: "upstream_error" }, 502);
            },
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(json({ error: "upstream_error" }, 502)))),
      },
    ] satisfies ReadonlyArray<McpDiscoveryRoute>,
    resourceMetadataUrl: (request) => metadataUrl(deps, request),
    authenticate: (request) => {
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        return Effect.succeed(unauthorized(challenge(deps, request)));
      }
      const token = authorization.slice(7).trim();
      if (!token) return Effect.succeed(unauthorized(challenge(deps, request, true)));
      return token.split(".").length === 3
        ? authorizeJwt(deps, request, token)
        : authorizeApiKey(deps, request, token);
    },
  });
