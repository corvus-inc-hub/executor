import { Effect, Layer, Predicate } from "effect";

import {
  IdentityProvider,
  NoOrganization,
  Unauthorized,
  Unavailable,
  type Principal,
} from "@executor-js/api/server";

import type { WorkOSConfig } from "../config";
import type { ApiKeyService } from "./api-keys";
import { parseCookie } from "./cookies";
import {
  cachedRemoteJwks,
  verifyWorkOSAccessToken,
  type VerifiedWorkOSToken,
  type WorkOSJwtError,
} from "./jwt";
import {
  authorizeServiceOrganization,
  authorizeUserOrganizationSelector,
  resolveOrganization,
  selectedOrganization,
  type OrganizationAuthDeps,
} from "./organization";
import type { OrganizationStore } from "./organization-store";
import {
  WORKOS_SESSION_COOKIE,
  type WorkOSBrowserSession,
  type WorkOSClient,
  type WorkOSRequestError,
} from "./workos";

const INVALID_AUTHORIZATION_HEADER = {
  code: "invalid_authorization_header",
  message: "Authorization header must use Bearer authentication",
};
const INVALID_CREDENTIAL = { code: "invalid_credential", message: "Invalid credential" };
const NO_ORGANIZATION = { code: "no_organization", message: "No authorized organization" };
const IDENTITY_UNAVAILABLE = {
  code: "identity_unavailable",
  message: "Identity validation is temporarily unavailable",
};

export interface WorkOSIdentityDeps extends OrganizationAuthDeps {
  readonly apiKeys: ApiKeyService;
  readonly workos: WorkOSClient;
  readonly organizations: OrganizationStore;
  readonly config: WorkOSConfig;
}

const authorizationFailure = (error: unknown): NoOrganization | Unavailable =>
  Predicate.isTagged("WorkOSRequestError")(error) &&
  "status" in error &&
  (error.status === 401 || error.status === 403 || error.status === 404)
    ? new NoOrganization(NO_ORGANIZATION)
    : new Unavailable(IDENTITY_UNAVAILABLE);

const jwtFailure = (error: WorkOSJwtError): Unauthorized | Unavailable =>
  error.reason === "system"
    ? new Unavailable(IDENTITY_UNAVAILABLE)
    : new Unauthorized(INVALID_CREDENTIAL);

const userDisplayName = (user: {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
}): string | null => [user.firstName, user.lastName].filter(Boolean).join(" ") || null;

const userPrincipal = (deps: WorkOSIdentityDeps, accountId: string, organizationSelector: string) =>
  Effect.gen(function* () {
    const authorized = yield* authorizeUserOrganizationSelector(
      deps,
      accountId,
      organizationSelector,
    ).pipe(Effect.mapError(authorizationFailure));
    if (!authorized) return yield* new NoOrganization(NO_ORGANIZATION);
    const user = yield* deps.workos.getUser(accountId).pipe(Effect.mapError(authorizationFailure));
    return {
      accountId,
      organizationId: authorized.id,
      organizationName: authorized.name,
      organizationSlug: authorized.slug,
      email: user.email,
      name: userDisplayName(user),
      avatarUrl: user.profilePictureUrl ?? null,
      roles: authorized.roles,
    } satisfies Principal;
  });

const servicePrincipal = (deps: WorkOSIdentityDeps, clientId: string, organizationId: string) =>
  Effect.gen(function* () {
    const authorized = yield* authorizeServiceOrganization(deps, clientId, organizationId).pipe(
      Effect.mapError(authorizationFailure),
    );
    if (!authorized) return yield* new NoOrganization(NO_ORGANIZATION);
    return {
      accountId: clientId,
      organizationId: authorized.id,
      organizationName: authorized.name,
      organizationSlug: authorized.slug,
      email: "",
      name: clientId,
      avatarUrl: null,
      roles: ["service"],
    } satisfies Principal;
  });

const principalFromJwt = (
  deps: WorkOSIdentityDeps,
  verified: VerifiedWorkOSToken | null,
  request: Request,
) =>
  Effect.gen(function* () {
    if (!verified || !verified.organizationId) {
      return yield* new NoOrganization(NO_ORGANIZATION);
    }
    const selector = selectedOrganization(request, verified.organizationId);
    if (!selector) return yield* new NoOrganization(NO_ORGANIZATION);
    if (verified.subject.startsWith("client_")) {
      if (verified.organizationId !== deps.config.serviceOrganizationId) {
        return yield* new NoOrganization(NO_ORGANIZATION);
      }
      return yield* servicePrincipal(deps, verified.subject, selector);
    }
    if (selector !== verified.organizationId) return yield* new NoOrganization(NO_ORGANIZATION);
    return yield* userPrincipal(deps, verified.subject, selector);
  });

const resolveJwtPrincipal = (deps: WorkOSIdentityDeps, token: string, request: Request) =>
  verifyWorkOSAccessToken(token, cachedRemoteJwks(`${deps.config.authkitDomain}/oauth2/jwks`), {
    issuer: deps.config.authkitDomain,
    audience: deps.config.connectAudience,
  }).pipe(
    Effect.mapError(jwtFailure),
    Effect.flatMap((verified) => principalFromJwt(deps, verified, request)),
  );

const resolveApiKeyPrincipal = (deps: WorkOSIdentityDeps, token: string, request: Request) =>
  Effect.gen(function* () {
    const owner = yield* deps.apiKeys
      .validate(token)
      .pipe(
        Effect.catchTag("ApiKeyValidationError", () =>
          Effect.fail(new Unavailable(IDENTITY_UNAVAILABLE)),
        ),
      );
    if (!owner) return yield* new Unauthorized(INVALID_CREDENTIAL);
    const selector = selectedOrganization(request, owner.organizationId);
    if (!selector) return yield* new NoOrganization(NO_ORGANIZATION);

    if (owner.accountId.startsWith("api-key:")) {
      if (selector !== owner.organizationId) return yield* new NoOrganization(NO_ORGANIZATION);
      const organization = yield* resolveOrganization(deps, owner.organizationId).pipe(
        Effect.mapError(authorizationFailure),
      );
      if (!organization) return yield* new NoOrganization(NO_ORGANIZATION);
      return {
        accountId: owner.accountId,
        organizationId: organization.id,
        organizationName: organization.name,
        organizationSlug: organization.slug,
        email: "",
        name: "Organization API key",
        avatarUrl: null,
        roles: owner.roles,
      } satisfies Principal;
    }
    return yield* userPrincipal(deps, owner.accountId, selector);
  });

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  if (!authorization.startsWith("Bearer ")) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: helper reports malformed authorization through the caller's typed path
    throw new Unauthorized(INVALID_AUTHORIZATION_HEADER);
  }
  return authorization.slice(7).trim();
};

export const resolveBrowserPrincipal = (deps: WorkOSIdentityDeps, request: Request) =>
  Effect.gen(function* () {
    const sessionData = parseCookie(request.headers.get("cookie"), WORKOS_SESSION_COOKIE);
    if (!sessionData) return null;
    const session = yield* deps.workos
      .authenticateSealedSession(sessionData)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!session) return null;
    const selector = selectedOrganization(request, session.organizationId);
    if (!selector) return null;
    return yield* userPrincipal(deps, session.accountId, selector).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
  });

export const makeWorkOSIdentityLayer = (deps: WorkOSIdentityDeps): Layer.Layer<IdentityProvider> =>
  Layer.succeed(IdentityProvider)({
    authenticate: (request) =>
      Effect.gen(function* () {
        const token = yield* Effect.try({
          try: () => bearerToken(request),
          catch: () => new Unauthorized(INVALID_AUTHORIZATION_HEADER),
        });
        if (token !== null) {
          if (!token) return yield* new Unauthorized(INVALID_CREDENTIAL);
          return yield* token.split(".").length === 3
            ? resolveJwtPrincipal(deps, token, request)
            : resolveApiKeyPrincipal(deps, token, request);
        }

        const browser = yield* resolveBrowserPrincipal(deps, request);
        if (!browser) return yield* new Unauthorized(INVALID_CREDENTIAL);
        return browser;
      }),
  });

export const sessionForRequest = (
  workos: WorkOSClient,
  request: Request,
): Effect.Effect<WorkOSBrowserSession | null, WorkOSRequestError> => {
  const sessionData = parseCookie(request.headers.get("cookie"), WORKOS_SESSION_COOKIE);
  return sessionData ? workos.authenticateSealedSession(sessionData) : Effect.succeed(null);
};
