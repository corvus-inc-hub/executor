// ---------------------------------------------------------------------------
// OAuth service implementation — the runtime behind `executor.oauth` and
// `ctx.oauth`.
//
// v2 model: a client is a registered app carrying its own endpoints; running
// its flow mints a Connection. The client + in-flight session rows are
// owner-scoped core tables; minted access tokens persist through the default
// writable credential provider; tools are produced by `mintOAuthConnection`
// (which the executor wires to the connection-create + tool-production path).
//
// Milestone 2: `start` / `complete` are wired. `start` generates PKCE + a
// branded state, persists an `oauth_session`, and returns the authorize URL
// (authorization_code) or exchanges client credentials immediately. `complete`
// redeems the session, exchanges the code, and mints the connection.
// ---------------------------------------------------------------------------

import { Duration, Effect, Layer, Option, Predicate, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import type { Connection, ConnectionRef } from "./connection";
import { sha256Hex } from "./blob";
import type { IFumaClient, StorageFailure } from "./fuma-runtime";
import { StorageError } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  Owner,
  ProviderItemId,
} from "./ids";
import {
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  OAUTH_COMPLETION_RECEIPT_SCHEMA_VERSION,
  OAUTH_CORRELATION_SCHEMA_VERSION,
  OAuthCompletionReceipt,
  OAuthCorrelationBinding,
  OAuthCorrelationEnvelope,
  canonicalOAuthCorrelationBinding,
  type ConnectResult,
  type CreateOAuthClientInput,
  type OAuthClientOrigin,
  type OAuthClientSummary,
  type OAuthCompleteInput,
  type OAuthCompletionReceiptLookupInput,
  type OAuthCompletionReceipt as OAuthCompletionReceiptType,
  type OAuthCorrelationBinding as OAuthCorrelationBindingType,
  type OAuthCorrelationEnvelope as OAuthCorrelationEnvelopeType,
  type OAuthCorrelationVerifier,
  type OAuthGrant,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthService,
  type OAuthStartInput,
  type RegisterDynamicClientInput,
} from "./oauth-client";
import type { OwnerBinding } from "./plugin";
import type { CredentialProvider } from "./provider";
import {
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  OAuthDiscoveryError,
  registerDynamicClient as registerDynamicClientDcr,
} from "./oauth-discovery";
import {
  assertSupportedOAuthEndpointUrl,
  buildAuthorizationUrl,
  providerAuthorizeExtras,
  createOAuthState,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  isLoopbackHttpUrl,
  rebindTokenEndpointHostToCallbackDomain,
  sanitizeOAuthBoundaryText,
  type OAuth2TokenResponse,
  type OAuthEndpointUrlPolicy,
} from "./oauth-helpers";
import { OAUTH2_SESSION_TTL_MS, encodeOAuthCallbackState } from "./oauth";
import { canonicalIssuerUrl, hostOfUrl, isDcrClassifiedRow, parseUrl } from "./oauth-gc";

/** Connection-minting input for the OAuth flow — extends a connection create
 *  with the OAuth lifecycle fields (client slug, refresh material, expiry,
 *  granted scope). The executor's `mintOAuthConnection` writes these onto the
 *  `connection` row and produces the connection's tools. */
export interface MintOAuthConnectionInput {
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
  readonly template: AuthTemplateSlug;
  readonly identityLabel?: string | null;
  /** Credential provider key + item id the access token is stored under. */
  readonly provider: string;
  readonly itemId: string;
  readonly oauthClient: OAuthClientSlug;
  /** The owner of `oauthClient` (persisted so refresh loads it by explicit owner). */
  readonly oauthClientOwner: Owner;
  readonly refreshItemId: string | null;
  readonly expiresAt: number | null;
  readonly oauthScope: string | null;
  readonly missingOAuthScopes?: readonly string[];
  /** Per-connection override for the token endpoint, persisted only when the
   *  code was redeemed at a region other than the client's configured token
   *  host (Datadog multi-site). Null means refresh uses the client's token URL. */
  readonly oauthTokenUrl?: string | null;
}

/** The OAuth scope policy for a `(integration, template)`. Either the
 *  integration declares the scopes to request (`scopes`, possibly empty — an
 *  empty set requests no scopes), or it declares none and the request scopes
 *  are discovered from the server's metadata at connect (`discover`, used by
 *  MCP). The two are mutually exclusive by construction. */
export type OAuthScopePolicy =
  | { readonly kind: "scopes"; readonly scopes: readonly string[] }
  | { readonly kind: "discover" };

/** Everything the OAuth service needs from the executor: fuma access for the
 *  owned `oauth_client` / `oauth_session` tables, the default credential
 *  provider for minted tokens, a `mintOAuthConnection` callback (writes the
 *  connection row + produces tools), the owner binding, and the redirect base. */
export interface OAuthServiceDeps {
  readonly fuma: IFumaClient;
  readonly owner: OwnerBinding;
  readonly tenant: string;
  readonly subject: string | null;
  readonly ownedKeys: (owner: Owner) => {
    readonly tenant: string;
    readonly owner: Owner;
    readonly subject: string;
  };
  readonly defaultWritableProvider: () => CredentialProvider | null;
  /** Write the connection row with OAuth lifecycle fields + produce its tools. */
  readonly mintOAuthConnection: (
    input: MintOAuthConnectionInput,
  ) => Effect.Effect<Connection, StorageFailure>;
  /** Load a connection for an idempotent completion replay. */
  readonly getConnection: (ref: ConnectionRef) => Effect.Effect<Connection | null, StorageFailure>;
  /** Host-authenticated verifier for signed correlation envelopes. Correlated
   * flows fail closed when this authority is not configured. */
  readonly verifyCorrelationEnvelope?: OAuthCorrelationVerifier;
  /** Hosted UI surfaces set this true until their signed correlation verifier
   *  is wired. It fail-closes legacy authorization-code starts rather than
   *  silently making receipt guarantees optional. */
  readonly requireOAuthCorrelation?: boolean;
  /** Test-only timing overrides for lease/recovery boundary tests. */
  readonly oauthAttemptLeaseMs?: number;
  readonly oauthAttemptHeartbeatMs?: number;
  /**
   * Resolve the OAuth scope policy for a `(integration, template)`:
   *  - `{ kind: "scopes", scopes }`: the scopes the integration's auth template
   *    DECLARES (e.g. an OpenAPI bundle's authentication-template scope union),
   *    NOT the scopes frozen on a specific `oauth_client` row. These are
   *    requested verbatim at connect (`start`); an empty set requests none.
   *  - `{ kind: "discover" }`: the integration declares no scopes, so `start`
   *    discovers the request scopes from the server's RFC 9728 / RFC 8414
   *    metadata. Used by server-targeting integrations (MCP) whose scopes live
   *    on the server rather than in a template.
   */
  readonly resolveOAuthScopePolicy: (
    integration: IntegrationSlug,
    template: AuthTemplateSlug,
  ) => Effect.Effect<OAuthScopePolicy, StorageFailure>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  /**
   * The OAuth callback URL (`${webBaseUrl}${mountPrefix}/oauth/callback`) the host
   * serves and sends to providers on every authorization request + DCR registration.
   * The path carries the host's API mount prefix (cloud: `/api`; root-mounted
   * hosts like local: none), so it matches the route that serves the callback.
   *
   * REQUIRED and EXPLICIT — there is no localhost default. Pass `null` only when
   * the host genuinely has no redirect callback (e.g. a pure client-credentials
   * or non-HTTP context); the redirect-requiring flows (`start` for
   * `authorization_code`, `registerDynamicClient`) then fail loudly instead of
   * silently handing the provider a wrong `http://127.0.0.1/callback`. Hosts
   * that serve OAuth MUST derive this from the request origin / web base URL.
   */
  readonly redirectUri: string | null;
  /** URL selected organization slug to round-trip through OAuth `state`. */
  readonly callbackStateOrgSlug?: string | null;
}

type LooseDb = {
  readonly create: (name: string, value: Record<string, unknown>) => Promise<unknown>;
  readonly deleteMany: (name: string, options: unknown) => Promise<void>;
  readonly findFirst: (name: string, options: unknown) => Promise<Record<string, unknown> | null>;
  readonly findMany: (
    name: string,
    options: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly updateMany: (name: string, options: unknown) => Promise<void>;
};
const looseDb = (db: unknown): LooseDb => db as LooseDb;

/** Where an OAuth-minted access token is stored in the default provider. The
 *  refresh token lives at the same id with a `:refresh` suffix. */
const accessItemId = (
  owner: Owner,
  integration: IntegrationSlug,
  name: ConnectionName,
  attemptKey?: string,
): string =>
  attemptKey
    ? `oauth:${owner}:${integration}:${name}:attempt:${shortStableHash(attemptKey)}`
    : `oauth:${owner}:${integration}:${name}`;
const refreshItemIdFor = (accessId: string): string => `${accessId}:refresh`;

/** Order-preserving de-duplication of a scope list. */
const dedupeScopes = (scopes: readonly string[]): readonly string[] => [...new Set(scopes)];

const intersectScopes = (
  requested: readonly string[],
  supported: readonly string[] | undefined,
): readonly string[] => {
  if (!supported || supported.length === 0) return requested;
  const supportedSet = new Set(supported);
  return requested.filter((scope) => supportedSet.has(scope));
};

const recordedOAuthScope = (
  token: OAuth2TokenResponse,
  requestedScopes: readonly string[],
): string | null => {
  if (token.scope == null) return requestedScopes.join(" ") || null;

  const granted = token.scope.split(/\s+/).filter(Boolean);
  const coveredByRefreshToken =
    token.refresh_token && requestedScopes.includes("offline_access") ? ["offline_access"] : [];
  const recorded = dedupeScopes([...granted, ...coveredByRefreshToken]);
  return recorded.join(" ") || null;
};

const OAUTH_SCOPE_ALIASES: Readonly<Record<string, string>> = {
  "https://www.googleapis.com/auth/userinfo.email": "email",
  "https://www.googleapis.com/auth/userinfo.profile": "profile",
};

const informationalOAuthScopes = new Set(["openid", "email", "profile", "offline_access"]);

/** Canonicalize a scope for granted-vs-requested comparison. Microsoft's token
 *  endpoint returns Graph scopes fully qualified
 *  (`https://graph.microsoft.com/Mail.ReadWrite`) even when the request used
 *  the short form, so resource-URI prefixes are stripped down to the scope's
 *  final path segment before comparing. */
const canonicalOAuthScope = (scope: string): string => {
  const aliased = OAUTH_SCOPE_ALIASES[scope];
  if (aliased) return aliased;
  if (/^https?:\/\/graph\.microsoft\.(com|us|de)\//i.test(scope)) {
    return scope.slice(scope.lastIndexOf("/") + 1);
  }
  return scope;
};

/** `.default` is a request-time meta-scope (Microsoft expands it server-side
 *  and never echoes it in the granted scope), so it can never be "missing". */
const isMetaOAuthScope = (scope: string): boolean => scope.toLowerCase().endsWith("/.default");

const normalizedOAuthScopeSet = (scopes: readonly string[]): ReadonlySet<string> =>
  new Set(scopes.map((scope) => canonicalOAuthScope(scope.trim())).filter(Boolean));

export const missingGrantedOAuthScopes = (
  requestedScopes: readonly string[],
  recordedScope: string | null,
): readonly string[] => {
  const granted = normalizedOAuthScopeSet(recordedScope?.split(/\s+/).filter(Boolean) ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of requestedScopes) {
    const trimmed = raw.trim();
    if (isMetaOAuthScope(trimmed)) continue;
    const scope = canonicalOAuthScope(trimmed);
    if (scope.length === 0 || informationalOAuthScopes.has(scope) || seen.has(scope)) continue;
    seen.add(scope);
    if (!granted.has(scope)) out.push(scope);
  }
  return out;
};

const decodeJsonPayload = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const decodeOAuthCorrelation = Schema.decodeUnknownOption(OAuthCorrelationBinding);
const decodeOAuthCorrelationEnvelope = Schema.decodeUnknownOption(OAuthCorrelationEnvelope);
const decodeOAuthCompletionReceipt = Schema.decodeUnknownOption(OAuthCompletionReceipt);

const OAUTH_ATTEMPT_LEASE_MS = 30_000;
const OAUTH_ATTEMPT_WAIT_MS = 30_000;
const OAUTH_ATTEMPT_POLL_MS = 100;
const OAUTH_ATTEMPT_HEARTBEAT_MS = 5_000;
const OAUTH_CORRELATION_CLOCK_SKEW_MS = 60_000;

type OAuthAttemptStatus = "pending" | "exchanging" | "completed" | "failed";

type OAuthAttemptClaim = {
  readonly attemptKey: string;
  readonly token: string;
  readonly generation: number;
};

/** Extract the persisted `requestedScopes` from an `oauth_session.payload`. The
 *  jsonColumn may surface as a parsed object (in-memory backends) or a JSON
 *  string (serialized backends); decode strings before reading. Returns `null`
 *  for legacy sessions written before `requestedScopes` was persisted, so
 *  `complete` can fall back to the client's scopes. */
const requestedScopesFromPayload = (payload: unknown): readonly string[] | null => {
  const decoded =
    typeof payload === "string"
      ? decodeJsonPayload(payload).pipe(Option.getOrElse(() => payload))
      : payload;
  if (decoded === null || typeof decoded !== "object") return null;
  const value = (decoded as Record<string, unknown>).requestedScopes;
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : null;
};

/** Read the app owner `start` recorded on the session payload. Null when absent
 *  (same-owner connects, or sessions written before this field), so `complete`
 *  falls back to the session owner. */
const clientOwnerFromPayload = (payload: unknown): Owner | null => {
  const decoded =
    typeof payload === "string"
      ? decodeJsonPayload(payload).pipe(Option.getOrElse(() => payload))
      : payload;
  if (decoded === null || typeof decoded !== "object") return null;
  const value = (decoded as Record<string, unknown>).clientOwner;
  return value === "user" || value === "org" ? value : null;
};

const correlationFromPayload = (payload: unknown): OAuthCorrelationBindingType | null => {
  const decoded =
    typeof payload === "string"
      ? decodeJsonPayload(payload).pipe(Option.getOrElse(() => payload))
      : payload;
  if (decoded === null || typeof decoded !== "object") return null;
  const value = (decoded as Record<string, unknown>).correlation;
  return Option.getOrNull(decodeOAuthCorrelation(value));
};

const envelopeFromStored = (value: unknown): OAuthCorrelationEnvelopeType | null => {
  const decoded =
    typeof value === "string"
      ? decodeJsonPayload(value).pipe(Option.getOrElse(() => value))
      : value;
  return decoded == null ? null : Option.getOrNull(decodeOAuthCorrelationEnvelope(decoded));
};

const correlationFieldIsSafe = (value: string): boolean => {
  if (value.length === 0 || value.length > 255) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return true;
};

const normalizeCorrelation = (
  input: OAuthCorrelationBindingType,
): OAuthCorrelationBindingType | null => {
  if (input.schemaVersion !== "executor.oauth-correlation.v2") return null;
  const normalized = {
    schemaVersion: input.schemaVersion,
    attemptKey: input.attemptKey.trim(),
    actorUserId: input.actorUserId.trim(),
    authenticatedSubjectId: input.authenticatedSubjectId.trim(),
    organizationId: input.organizationId.trim(),
    workspaceId: input.workspaceId.trim(),
    provider: input.provider.trim(),
  } satisfies OAuthCorrelationBindingType;
  return Object.values(normalized).every(
    (value) => typeof value === "string" && correlationFieldIsSafe(value),
  )
    ? normalized
    : null;
};

const normalizeCorrelationEnvelope = (
  input: OAuthCorrelationEnvelopeType,
): OAuthCorrelationEnvelopeType | null => {
  if (input.schemaVersion !== "executor.oauth-correlation.v2") return null;
  const normalized = {
    schemaVersion: input.schemaVersion,
    attemptKey: input.attemptKey.trim(),
    actorUserId: input.actorUserId.trim(),
    authenticatedSubjectId: input.authenticatedSubjectId.trim(),
    organizationId: input.organizationId.trim(),
    workspaceId: input.workspaceId.trim(),
    provider: input.provider.trim(),
    keyId: input.keyId.trim(),
    issuedAt: input.issuedAt.trim(),
    expiresAt: input.expiresAt.trim(),
    signature: input.signature.trim(),
  } satisfies OAuthCorrelationEnvelopeType;
  return Object.values(normalized).every(
    (value) => typeof value === "string" && correlationFieldIsSafe(value),
  )
    ? normalized
    : null;
};

const bindingFromEnvelope = (
  envelope: OAuthCorrelationEnvelopeType,
): OAuthCorrelationBindingType => ({
  schemaVersion: envelope.schemaVersion,
  attemptKey: envelope.attemptKey,
  actorUserId: envelope.actorUserId,
  authenticatedSubjectId: envelope.authenticatedSubjectId,
  organizationId: envelope.organizationId,
  workspaceId: envelope.workspaceId,
  provider: envelope.provider,
});

const dateFromStored = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
};

const receiptFromRow = (row: Record<string, unknown>): OAuthCompletionReceiptType | null => {
  const startedAt = dateFromStored(row.started_at);
  const completedAt = dateFromStored(row.completed_at);
  const durationMs = Number(row.duration_ms);
  if (!startedAt || !completedAt || !Number.isFinite(durationMs)) return null;
  return Option.getOrNull(
    decodeOAuthCompletionReceipt({
      schemaVersion: OAUTH_COMPLETION_RECEIPT_SCHEMA_VERSION,
      receiptKind: "executor.oauth.completion",
      attemptKey: String(row.attempt_key ?? ""),
      actorUserId: String(row.actor_user_id ?? ""),
      authenticatedSubjectId: String(row.authenticated_subject_id ?? ""),
      organizationId: String(row.organization_id ?? ""),
      workspaceId: String(row.workspace_id ?? ""),
      executionId: String(row.execution_id ?? ""),
      status: String(row.status ?? ""),
      resultReference: String(row.result_reference ?? ""),
      provider: String(row.provider ?? ""),
      connection: {
        owner: row.connection_owner,
        integration: String(row.connection_integration ?? ""),
        name: String(row.connection_name ?? ""),
        address: String(row.connection_address ?? ""),
      },
      requestHash: String(row.request_hash ?? ""),
      descriptorHash: String(row.descriptor_hash ?? ""),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
    }),
  );
};

const connectionRefFromReceipt = (receipt: OAuthCompletionReceiptType): ConnectionRef => ({
  owner: receipt.connection.owner,
  integration: IntegrationSlug.make(receipt.connection.integration),
  name: ConnectionName.make(receipt.connection.name),
});

const requestHashForCompletion = (
  state: OAuthState,
  code: string,
  callbackDomain: string | null,
  descriptorHash: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    // The raw authorization code is request material, not receipt material.
    // Bind replays to the same callback without persisting or returning it.
    const codeHash = yield* sha256Hex(code);
    return yield* sha256Hex(
      JSON.stringify({
        schemaVersion: "executor.oauth-complete.v1",
        state: String(state),
        callbackDomain,
        descriptorHash,
        codeHash,
      }),
    );
  });

/** Narrow a stored `grant` string to the `OAuthGrant` union, or `null` when the
 *  value is neither known grant. EXPLICIT — there is no silent fallback to
 *  `authorization_code`; an unknown grant means a corrupt row and callers that
 *  drive token exchange (`loadClient`) must fail loudly rather than guessing. */
const parseGrant = (grant: unknown): OAuthGrant | null =>
  grant === "client_credentials" || grant === "authorization_code" ? grant : null;

const canonicalDcrIssuer = (
  issuer: string | null | undefined,
  registrationEndpoint: string,
): string | null => {
  const discovered = canonicalIssuerUrl(issuer);
  if (discovered !== null) return discovered;
  const endpoint = parseUrl(registrationEndpoint);
  return endpoint === null ? null : endpoint.origin;
};

const issuerOrigin = (issuer: string): string | null => parseUrl(issuer)?.origin ?? null;

const issuerIsOriginOnly = (issuer: string): boolean => issuerOrigin(issuer) === issuer;

const dcrIssuerMatches = (rowIssuer: string, inputIssuer: string | null): boolean =>
  inputIssuer !== null &&
  (rowIssuer === inputIssuer ||
    (issuerIsOriginOnly(inputIssuer) && issuerOrigin(rowIssuer) === inputIssuer));

const slugifyOAuthKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const shortStableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const dcrClientSlug = (
  issuer: string | null,
  resource: string | null,
  fallback: OAuthClientSlug,
): OAuthClientSlug => {
  if (issuer === null) return fallback;
  const issuerHost = hostOfUrl(issuer);
  if (issuerHost === null) return fallback;
  const base = `dcr-${slugifyOAuthKey(issuerHost) || "authorization-server"}`;
  if (resource === null) return OAuthClientSlug.make(base);
  const resourceUrl = parseUrl(resource);
  const resourceSource =
    resourceUrl === null ? resource : `${resourceUrl.host}${resourceUrl.pathname}`;
  const resourcePart = slugifyOAuthKey(resourceSource).slice(0, 60) || "resource";
  return OAuthClientSlug.make(`${base}-${resourcePart}-${shortStableHash(resource)}`.slice(0, 240));
};

/** Dedupe a freshly-minted DCR slug against slugs already held by an owner's
 *  DCR candidates, appending `-2`, `-3`, … so a new client never collides with
 *  (and clobbers, via createClient's delete-then-create) an existing one. */
const uniqueDcrSlug = (slug: OAuthClientSlug, taken: ReadonlySet<string>): OAuthClientSlug => {
  const base = String(slug);
  if (!taken.has(base)) return slug;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return OAuthClientSlug.make(`${base}-${suffix}`);
};

const parseOAuthClientOrigin = (row: {
  readonly slug?: unknown;
  readonly grant?: unknown;
  readonly resource?: unknown;
  readonly origin_kind?: unknown;
  readonly origin_integration?: unknown;
}): OAuthClientOrigin => {
  // Shared DCR classification (explicit origin_kind OR the legacy MCP-shaped
  // heuristic) lives in `oauth-gc` so the runtime and the GC/backfill
  // migrations agree exactly on what counts as a DCR row.
  if (!isDcrClassifiedRow(row)) {
    return {
      kind: "manual",
      integration:
        row.origin_integration == null
          ? null
          : IntegrationSlug.make(String(row.origin_integration)),
    };
  }
  // An explicit-origin DCR row carries its requesting integration; a
  // heuristic-classified legacy row (null origin_kind) has none.
  return {
    kind: "dynamic_client_registration",
    integration:
      row.origin_kind === "dynamic_client_registration" && row.origin_integration != null
        ? IntegrationSlug.make(String(row.origin_integration))
        : null,
  };
};

interface LoadedOAuthClient {
  readonly slug: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly grant: OAuthGrant;
  readonly clientId: string;
  /** Resolved literal secret (read from the provider via the stored item id). */
  readonly clientSecret: string;
  readonly resource: string | null;
}

/** Where an OAuth app's client secret is stored in the default writable
 *  provider — derived solely from the app's (owner, slug) identity. */
const clientSecretItemId = (owner: Owner, slug: OAuthClientSlug): string =>
  `oauth-client:${owner}:${slug}:secret`;

const expiresAtFrom = (token: OAuth2TokenResponse): number | null =>
  typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : null;

/** Error message surfaced when a redirect-requiring OAuth flow runs on an
 *  executor that was constructed without a `redirectUri`. Previously this path
 *  silently used `http://127.0.0.1/callback`, which providers stored as the
 *  client's callback and then rejected (or worse, accepted, handing tokens to
 *  localhost). Fail loudly so the misconfiguration is caught at the call site. */
const REDIRECT_URI_REQUIRED_MESSAGE =
  "OAuth redirect flow requires a configured redirectUri, but none was provided " +
  "to the executor. Pass `redirectUri` to createExecutor (hosts derive it from " +
  "the web base URL / request origin as `${webBaseUrl}${mountPrefix}/oauth/callback`).";

const canonicalUrlString = (value: string): string => {
  const url = new URL(value.trim());
  url.hash = "";
  return url.toString();
};

const isWellKnownOAuthMetadataUrl = (value: string): boolean => {
  const path = new URL(value.trim()).pathname.toLowerCase();
  return (
    path.includes("/.well-known/oauth-authorization-server") ||
    path.includes("/.well-known/openid-configuration") ||
    path.includes("/.well-known/oauth-protected-resource")
  );
};

const validateSupportedEndpoint = (
  value: string,
  label: string,
  endpointUrlPolicy: OAuthEndpointUrlPolicy | undefined,
): Effect.Effect<void, StorageFailure> =>
  Effect.try({
    try: () => assertSupportedOAuthEndpointUrl(value, label, endpointUrlPolicy),
    catch: (cause) =>
      new StorageError({
        message: `Invalid OAuth client endpoint configuration: ${label} must use https: or loopback http:.`,
        cause,
      }),
  }).pipe(Effect.asVoid);

const validateClientEndpoints = (
  input: CreateOAuthClientInput,
  endpointUrlPolicy: OAuthEndpointUrlPolicy | undefined,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* validateSupportedEndpoint(input.tokenUrl, "token_url", endpointUrlPolicy);
    if (input.resource != null && input.resource.trim().length > 0) {
      yield* validateSupportedEndpoint(input.resource, "resource", endpointUrlPolicy);
    }
    if (input.grant !== "authorization_code") return;
    yield* validateSupportedEndpoint(
      input.authorizationUrl,
      "authorization_url",
      endpointUrlPolicy,
    );
    if (isWellKnownOAuthMetadataUrl(input.authorizationUrl)) {
      return yield* new StorageError({
        message:
          "Invalid OAuth client endpoint configuration: authorization_url must be the OAuth authorization endpoint, not a .well-known metadata URL.",
        cause: undefined,
      });
    }
    if (canonicalUrlString(input.authorizationUrl) === canonicalUrlString(input.tokenUrl)) {
      return yield* new StorageError({
        message:
          "Invalid OAuth client endpoint configuration: authorization_url must not equal token_url.",
        cause: undefined,
      });
    }
  });

export const makeOAuthService = (deps: OAuthServiceDeps): OAuthService => {
  const httpClientLayer = deps.httpClientLayer ?? FetchHttpClient.layer;
  const fetch = deps.fetch;
  const attemptLeaseMs = Math.max(100, deps.oauthAttemptLeaseMs ?? OAUTH_ATTEMPT_LEASE_MS);
  const attemptHeartbeatMs = Math.min(
    Math.max(25, deps.oauthAttemptHeartbeatMs ?? OAUTH_ATTEMPT_HEARTBEAT_MS),
    Math.max(25, Math.floor(attemptLeaseMs / 3)),
  );
  // EXPLICIT — no localhost default. `null` means this executor has no OAuth
  // callback; redirect-requiring flows fail loudly via `requireRedirectUri`.
  const redirectUri = deps.redirectUri;
  const discoveryOptions = { endpointUrlPolicy: deps.endpointUrlPolicy };

  const filterAuthorizationCodeScopes = (
    client: LoadedOAuthClient,
    requestedScopes: readonly string[],
  ): Effect.Effect<readonly string[], never> =>
    Effect.gen(function* () {
      if (requestedScopes.length === 0) return requestedScopes;
      const resource = client.resource
        ? yield* discoverProtectedResourceMetadata(client.resource, discoveryOptions).pipe(
            Effect.catch(() => Effect.succeed(null)),
            Effect.provide(httpClientLayer),
          )
        : null;
      const issuer =
        resource?.metadata.authorization_servers?.[0] ?? new URL(client.authorizationUrl).origin;
      const as = yield* discoverAuthorizationServerMetadata(issuer, discoveryOptions).pipe(
        Effect.catch(() => Effect.succeed(null)),
        Effect.provide(httpClientLayer),
      );
      return intersectScopes(requestedScopes, as?.metadata.scopes_supported);
    }).pipe(Effect.catch(() => Effect.succeed(requestedScopes)));

  // Caps on server-controlled discovery input — a hostile or buggy server must
  // not be able to hang `oauth.start` or overflow the authorize URL.
  const MAX_DISCOVERY_AUTH_SERVERS = 3; // AS-failover lists are tiny in practice
  const MAX_DISCOVERED_SCOPES = 100; // far beyond any realistic authorization template
  const capScopes = (scopes: readonly string[]): readonly string[] =>
    dedupeScopes(scopes).slice(0, MAX_DISCOVERED_SCOPES);

  // Discover the scopes to request when the integration declares none — only
  // reached for integrations that opt in (MCP-style). The resource's own RFC
  // 9728 `scopes_supported` is authoritative when present, even when empty (§2
  // defines the field; §7.2 cautions against requesting more than it lists).
  // Only when the resource is SILENT do we read the scopes advertised by the
  // authorization servers it NAMES (RFC 8414) — we never probe arbitrary URLs.
  const discoverScopesForResource = (
    resource: string | null,
  ): Effect.Effect<readonly string[], OAuthDiscoveryError> =>
    Effect.gen(function* () {
      if (resource == null) {
        return yield* new OAuthDiscoveryError({
          message: "Cannot discover OAuth scopes: the client has no resource configured",
        });
      }
      // `httpClientLayer` flows through `options` so discovery uses the host's
      // configured client (discovery self-provides from `options.httpClientLayer`).
      const discoveryOptions = { endpointUrlPolicy: deps.endpointUrlPolicy, httpClientLayer };

      const protectedResource = yield* discoverProtectedResourceMetadata(
        resource,
        discoveryOptions,
      );
      const resourceScopes = protectedResource?.metadata.scopes_supported;
      if (resourceScopes !== undefined) return capScopes(resourceScopes);

      // The resource is silent on scopes — read them from the authorization
      // servers it names, in order. An advertised list is authoritative even
      // when empty. Any AS we cannot read clean RFC 8414 metadata from —
      // unreachable, 404, malformed, or issuer-mismatched — contributes nothing
      // and we move on (mirroring the dynamic-registration discovery path); if
      // none advertise scopes we request none and let the AS apply its defaults
      // (RFC 8414 metadata is optional, so its absence is not a failure). The
      // list is server-controlled, so cap how many of its hosts we probe.
      for (const issuer of (protectedResource?.metadata.authorization_servers ?? []).slice(
        0,
        MAX_DISCOVERY_AUTH_SERVERS,
      )) {
        const authServer = yield* discoverAuthorizationServerMetadata(
          issuer,
          discoveryOptions,
        ).pipe(Effect.catchTag("OAuthDiscoveryError", () => Effect.succeed(null)));
        const scopes = authServer?.metadata.scopes_supported;
        if (scopes !== undefined) return capScopes(scopes);
      }

      return [];
    }).pipe(
      // Bound the whole sequence (PRM + up to MAX_DISCOVERY_AUTH_SERVERS AS
      // fetches, each with its own request timeout). 30s is larger than a single
      // request timeout so it bounds the sequence, not a slow-but-valid request.
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () =>
          Effect.fail(
            new OAuthDiscoveryError({
              message: "OAuth scope discovery timed out",
              cause: "timeout",
            }),
          ),
      }),
    );

  const verifySignedCorrelation = (
    input: OAuthCorrelationEnvelopeType,
  ): Effect.Effect<OAuthCorrelationBindingType, StorageFailure> => {
    const envelope = normalizeCorrelationEnvelope(input);
    if (!envelope) {
      return Effect.fail(
        new StorageError({
          message: "OAuth correlation envelope is invalid or oversized.",
          cause: undefined,
        }),
      );
    }
    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    const now = Date.now();
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > OAUTH2_SESSION_TTL_MS ||
      issuedAt > now + OAUTH_CORRELATION_CLOCK_SKEW_MS ||
      expiresAt <= now
    ) {
      return Effect.fail(
        new StorageError({
          message: "OAuth correlation envelope lifetime is invalid or expired.",
          cause: undefined,
        }),
      );
    }
    if (!deps.verifyCorrelationEnvelope) {
      return Effect.fail(
        new StorageError({
          message: "OAuth correlation verification authority is not configured.",
          cause: undefined,
        }),
      );
    }
    return deps.verifyCorrelationEnvelope(envelope).pipe(
      Effect.flatMap((binding) => {
        const normalized = normalizeCorrelation(binding);
        const envelopeBinding = bindingFromEnvelope(envelope);
        if (
          !normalized ||
          normalized.attemptKey !== envelopeBinding.attemptKey ||
          normalized.actorUserId !== envelopeBinding.actorUserId ||
          normalized.authenticatedSubjectId !== envelopeBinding.authenticatedSubjectId ||
          normalized.organizationId !== envelopeBinding.organizationId ||
          normalized.workspaceId !== envelopeBinding.workspaceId ||
          normalized.provider !== envelopeBinding.provider
        ) {
          return Effect.fail(
            new StorageError({
              message: "OAuth correlation verifier returned a mismatched binding.",
              cause: undefined,
            }),
          );
        }
        return Effect.succeed(normalized);
      }),
    );
  };

  const trustedCorrelationForStart = (
    envelope: OAuthCorrelationEnvelopeType,
    provider: string,
  ): Effect.Effect<OAuthCorrelationBindingType, OAuthStartError | StorageFailure> =>
    verifySignedCorrelation(envelope).pipe(
      Effect.mapError(
        (cause) =>
          new OAuthStartError({
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: the verifier exposes a typed StorageFailure message
            message: sanitizeOAuthBoundaryText(cause.message),
          }),
      ),
      Effect.flatMap((binding) => {
        if (binding.organizationId !== deps.tenant) {
          return Effect.fail(
            new OAuthStartError({
              message:
                "OAuth correlation binding organization does not match the authenticated organization.",
            }),
          );
        }
        if (deps.subject === null || binding.authenticatedSubjectId !== deps.subject) {
          return Effect.fail(
            new OAuthStartError({
              message: "Correlated OAuth requires the bound authenticated subject.",
            }),
          );
        }
        if (binding.provider !== provider) {
          return Effect.fail(
            new OAuthStartError({
              message: "OAuth correlation provider does not match the selected integration.",
            }),
          );
        }
        return Effect.succeed(binding);
      }),
    );

  const loadAttemptByKey = (
    attemptKey: string,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    deps.fuma.use("oauth_attempt.findFirst", (db) =>
      looseDb(db).findFirst("oauth_attempt", {
        where: (b: any) => b("attempt_key", "=", attemptKey),
      }),
    );

  const attemptBindingFromRow = (
    row: Record<string, unknown>,
  ): OAuthCorrelationBindingType | null => {
    const binding = {
      schemaVersion: OAUTH_CORRELATION_SCHEMA_VERSION,
      attemptKey: String(row.attempt_key ?? ""),
      actorUserId: String(row.actor_user_id ?? ""),
      authenticatedSubjectId: String(row.authenticated_subject_id ?? ""),
      organizationId: String(row.organization_id ?? ""),
      workspaceId: String(row.workspace_id ?? ""),
      provider: String(row.provider ?? ""),
    } satisfies OAuthCorrelationBindingType;
    return normalizeCorrelation(binding);
  };

  const reserveAttemptAndSession = (input: {
    readonly keys: { readonly tenant: string; readonly owner: Owner; readonly subject: string };
    readonly state: OAuthState;
    readonly authorizationUrl: string;
    readonly flowRedirectUri: string;
    readonly verifier: string;
    readonly now: Date;
    readonly expiresAt: number;
    readonly client: OAuthClientSlug;
    readonly clientOwner: Owner;
    readonly owner: Owner;
    readonly integration: IntegrationSlug;
    readonly name: ConnectionName;
    readonly template: AuthTemplateSlug;
    readonly identityLabel: string | null | undefined;
    readonly requestedScopes: readonly string[];
    readonly correlation: OAuthCorrelationBindingType;
    readonly envelope: OAuthCorrelationEnvelopeType;
    readonly descriptorHash: string;
    readonly executionId: string;
  }): Effect.Effect<boolean, StorageFailure> =>
    deps.fuma
      .transaction(
        Effect.gen(function* () {
          yield* deps.fuma.use("oauth_attempt.create", (db) =>
            looseDb(db).create("oauth_attempt", {
              tenant: input.keys.tenant,
              attempt_key: input.correlation.attemptKey,
              state: String(input.state),
              actor_user_id: input.correlation.actorUserId,
              authenticated_subject_id: input.correlation.authenticatedSubjectId,
              organization_id: input.correlation.organizationId,
              workspace_id: input.correlation.workspaceId,
              provider: input.correlation.provider,
              integration: String(input.integration),
              execution_id: input.executionId,
              descriptor_hash: input.descriptorHash,
              status: "pending",
              lease_token: null,
              lease_generation: 0,
              lease_expires_at: null,
              authorization_url: input.authorizationUrl,
              started_at: input.now,
              updated_at: input.now,
              completed_at: null,
            }),
          );
          yield* deps.fuma.use("oauth_session.create", (db) =>
            looseDb(db).create("oauth_session", {
              tenant: input.keys.tenant,
              owner: input.keys.owner,
              subject: input.keys.subject,
              state: String(input.state),
              client_slug: String(input.client),
              integration: String(input.integration),
              name: String(input.name),
              template: String(input.template),
              redirect_url: input.flowRedirectUri,
              pkce_verifier: input.verifier,
              identity_label: input.identityLabel ?? null,
              payload: {
                owner: input.owner,
                clientOwner: input.clientOwner,
                requestedScopes: input.requestedScopes,
              },
              attempt_key: input.correlation.attemptKey,
              actor_user_id: input.correlation.actorUserId,
              authenticated_subject_id: input.correlation.authenticatedSubjectId,
              workspace_id: input.correlation.workspaceId,
              provider: input.correlation.provider,
              descriptor_hash: input.descriptorHash,
              execution_id: input.executionId,
              correlation_envelope: input.envelope,
              expires_at: input.expiresAt,
              created_at: input.now,
            }),
          );
        }),
      )
      .pipe(
        Effect.as(true),
        Effect.catchTag("UniqueViolationError", () => Effect.succeed(false)),
      );

  const claimAttempt = (
    attemptKey: string,
  ): Effect.Effect<
    | { readonly kind: "claimed"; readonly claim: OAuthAttemptClaim }
    | { readonly kind: "completed" }
    | { readonly kind: "waiting" }
    | { readonly kind: "missing" }
    | { readonly kind: "failed" },
    StorageFailure
  > =>
    Effect.gen(function* () {
      const row = yield* loadAttemptByKey(attemptKey);
      if (!row) return { kind: "missing" } as const;
      const status = String(row.status) as OAuthAttemptStatus;
      if (status === "completed") return { kind: "completed" } as const;
      if (status === "failed") return { kind: "failed" } as const;
      const leaseExpiresAt = row.lease_expires_at == null ? 0 : Number(row.lease_expires_at);
      if (status === "exchanging" && leaseExpiresAt > Date.now()) {
        return { kind: "waiting" } as const;
      }
      const token = crypto.randomUUID();
      const generation = Number(row.lease_generation ?? 0) + 1;
      const now = Date.now();
      yield* deps.fuma.transaction(
        Effect.gen(function* () {
          yield* deps.fuma.use("oauth_attempt.claim", (db) =>
            looseDb(db).updateMany("oauth_attempt", {
              // The predicate is the claim. It makes pending -> exchanging
              // atomic and only lets a lease-expired owner take recovery; a
              // concurrent callback cannot silently replace a live owner.
              where: (b: any) =>
                b.and(
                  b("attempt_key", "=", attemptKey),
                  b.or(
                    b("status", "=", "pending"),
                    b.and(b("status", "=", "exchanging"), b("lease_expires_at", "<=", now)),
                  ),
                ),
              set: {
                status: "exchanging",
                lease_token: token,
                lease_generation: generation,
                lease_expires_at: now + attemptLeaseMs,
                updated_at: new Date(now),
              },
            }),
          );
        }),
      );
      const claimed = yield* loadAttemptByKey(attemptKey);
      if (
        claimed?.lease_token === token &&
        Number(claimed.lease_generation ?? 0) === generation &&
        String(claimed.status) === "exchanging"
      ) {
        return {
          kind: "claimed",
          claim: { attemptKey, token, generation },
        } as const;
      }
      return { kind: "waiting" } as const;
    });

  const renewAttemptLease = (claim: OAuthAttemptClaim): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      const now = Date.now();
      yield* deps.fuma.use("oauth_attempt.renew", (db) =>
        looseDb(db).updateMany("oauth_attempt", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", claim.attemptKey),
              b("status", "=", "exchanging"),
              b("lease_token", "=", claim.token),
              b("lease_generation", "=", claim.generation),
            ),
          set: {
            lease_expires_at: now + attemptLeaseMs,
            updated_at: new Date(now),
          },
        }),
      );
      const row = yield* loadAttemptByKey(claim.attemptKey);
      if (
        !row ||
        String(row.status) !== "exchanging" ||
        row.lease_token !== claim.token ||
        Number(row.lease_generation ?? 0) !== claim.generation ||
        Number(row.lease_expires_at ?? 0) <= now
      ) {
        return yield* new StorageError({
          message: "OAuth attempt lease was lost during completion.",
          cause: undefined,
        });
      }
    });

  const assertAttemptClaim = (claim: OAuthAttemptClaim): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      const row = yield* loadAttemptByKey(claim.attemptKey);
      const now = Date.now();
      if (
        !row ||
        String(row.status) !== "exchanging" ||
        row.lease_token !== claim.token ||
        Number(row.lease_generation ?? 0) !== claim.generation ||
        Number(row.lease_expires_at ?? 0) <= now
      ) {
        return yield* new StorageError({
          message: "OAuth attempt lease is no longer authoritative.",
          cause: undefined,
        });
      }
    });

  const withAttemptHeartbeat = <A, E>(
    claim: OAuthAttemptClaim,
    effect: Effect.Effect<A, E | StorageFailure>,
  ): Effect.Effect<A, E | StorageFailure> =>
    Effect.gen(function* () {
      yield* renewAttemptLease(claim);
      const heartbeat = Effect.gen(function* () {
        while (true) {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, attemptHeartbeatMs)),
          );
          yield* renewAttemptLease(claim);
        }
      }).pipe(Effect.catch(() => Effect.succeed<"lost">("lost")));
      // `race` waits for the heartbeat when the main effect fails.  That would
      // leave a failed callback hanging until the lease expires.  `raceFirst`
      // preserves the first success *or failure* and interrupts the heartbeat.
      const winner = yield* effect
        .pipe(Effect.map((value) => ({ kind: "effect" as const, value })))
        .pipe(Effect.raceFirst(heartbeat.pipe(Effect.map(() => ({ kind: "lost" as const })))));
      if (winner.kind === "lost") {
        return yield* new StorageError({
          message: "OAuth attempt lease heartbeat failed; completion stopped.",
          cause: undefined,
        });
      }
      return winner.value;
    });

  const waitForAttemptWinner = (
    attemptKey: string,
  ): Effect.Effect<"completed" | "retry" | "failed", StorageFailure> =>
    Effect.gen(function* () {
      const deadline = Date.now() + OAUTH_ATTEMPT_WAIT_MS;
      while (Date.now() < deadline) {
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setTimeout(resolve, OAUTH_ATTEMPT_POLL_MS)),
        );
        const row = yield* loadAttemptByKey(attemptKey);
        if (!row) return "retry" as const;
        const status = String(row.status) as OAuthAttemptStatus;
        if (status === "completed") {
          return "completed" as const;
        }
        if (status === "failed") return "failed" as const;
        if (status !== "exchanging" || Number(row.lease_expires_at ?? 0) <= Date.now()) {
          return "retry" as const;
        }
      }
      return "retry" as const;
    });

  // -----------------------------------------------------------------------
  // createClient — write the oauth_client row.
  // -----------------------------------------------------------------------
  const createClient = (
    input: CreateOAuthClientInput,
  ): Effect.Effect<OAuthClientSlug, StorageFailure> =>
    Effect.gen(function* () {
      yield* validateClientEndpoints(input, deps.endpointUrlPolicy);
      const keys = yield* Effect.try({
        try: () => deps.ownedKeys(input.owner),
        catch: (cause) =>
          new StorageError({
            message: "Cannot write oauth_client for owner without a subject",
            cause,
          }),
      });
      const now = new Date();

      // Store the secret out-of-band in the default writable provider; the row
      // keeps only its item id. A public/PKCE client (empty secret) stores null
      // — there is no plaintext column to fall back to (the schema dropped it).
      let clientSecretItemIdValue: string | null = null;
      if (input.clientSecret.length > 0) {
        const provider = deps.defaultWritableProvider();
        if (!provider || !provider.set) {
          return yield* new StorageError({
            message:
              "No default writable credential provider is registered to store the OAuth client secret.",
            cause: undefined,
          });
        }
        clientSecretItemIdValue = clientSecretItemId(input.owner, input.slug);
        yield* provider.set(ProviderItemId.make(clientSecretItemIdValue), input.clientSecret);
      }

      yield* deps.fuma
        .use("oauth_client.deleteExisting", (db) =>
          looseDb(db).deleteMany("oauth_client", {
            where: (b: any) =>
              b.and(b("owner", "=", input.owner), b("slug", "=", String(input.slug))),
          }),
        )
        .pipe(Effect.catch(() => Effect.void));
      yield* deps.fuma.use("oauth_client.create", (db) =>
        looseDb(db).create("oauth_client", {
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          slug: String(input.slug),
          authorization_url: input.authorizationUrl,
          token_url: input.tokenUrl,
          grant: input.grant,
          client_id: input.clientId,
          client_secret_item_id: clientSecretItemIdValue,
          resource: input.resource ?? null,
          origin_kind: input.origin?.kind ?? "manual",
          // Recorded intent, kept for BOTH origins: a manual app registered from
          // an integration's dialog stamps its integration so the picker can
          // match it exactly, the same way a DCR client records the integration
          // that requested it.
          origin_integration:
            input.origin?.integration == null ? null : String(input.origin.integration),
          origin_issuer:
            input.origin?.kind === "dynamic_client_registration"
              ? (canonicalIssuerUrl(input.originIssuer) ?? null)
              : null,
          created_at: now,
        }),
      );
      return input.slug;
    });

  // -----------------------------------------------------------------------
  // removeClient — permanently delete an owner-scoped oauth_client row.
  //
  // Mirrors createClient's deleteExisting filter (same (owner, slug) key) but
  // does NOT swallow storage errors: createClient pipes `.catch(() =>
  // Effect.void)` because a missing prior row is fine on upsert, whereas a real
  // removal must surface a storage failure loudly. The owner policy on
  // `oauth_client` narrows visibility, so a cross-subject user row cannot be
  // deleted. `deleteMany` is idempotent (no matching row -> no-op), so removing
  // an already-gone client returns success — acceptable for a delete. The
  // connection rows that referenced the slug keep their stored value and fail at
  // the next token refresh, prompting a reconnect (graceful degradation; this
  // op never cascades into connections).
  // -----------------------------------------------------------------------
  const removeClient = (owner: Owner, slug: OAuthClientSlug): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* deps.fuma
        .use("oauth_client.delete", (db) =>
          looseDb(db).deleteMany("oauth_client", {
            where: (b: any) => b.and(b("owner", "=", owner), b("slug", "=", String(slug))),
          }),
        )
        .pipe(Effect.asVoid);
      // Best-effort: drop the secret from the provider so it isn't orphaned.
      const provider = deps.defaultWritableProvider();
      if (provider?.delete) {
        yield* provider
          .delete(ProviderItemId.make(clientSecretItemId(owner, slug)))
          .pipe(Effect.catch(() => Effect.void));
      }
    });

  // -----------------------------------------------------------------------
  // registerDynamicClient — RFC 7591 Dynamic Client Registration.
  //
  // POSTs the server's registration_endpoint to mint a client_id (public,
  // PKCE-only, no secret when the server allows `none`; else
  // `client_secret_post`), then persists it through createClient's path. The
  // user pastes NO client id/secret — that is the point. The minted secret is
  // never returned over the read surface.
  // -----------------------------------------------------------------------
  // DCR auth-method negotiation. This is an EXPLICIT, documented choice (not a
  // silent guess): a Dynamic Client Registration ALWAYS mints a public PKCE
  // client — `none` when the server advertises nothing or lists `none`, and
  // `client_secret_post` only when the server's advertised methods exclude
  // `none` (so a confidential secret is mandatory). Static clients never reach
  // here; they require an explicit grant + secret in `createClient`.
  const pickDcrAuthMethod = (
    advertised: readonly string[] | undefined,
  ): "none" | "client_secret_post" =>
    !advertised || advertised.length === 0 || advertised.includes("none")
      ? "none"
      : "client_secret_post";

  type DcrReuseCandidate = {
    readonly slug: OAuthClientSlug;
    readonly resource: string | null;
  };

  // `oauth_client.created_at` is a date column that surfaces as a Date, an ISO
  // string, or an epoch number depending on the storage backend. Normalize to
  // epoch ms for deterministic oldest-first ordering; an unparseable/missing
  // value sorts as 0 (oldest), so slug then breaks the tie stably.
  const candidateCreatedAt = (value: unknown): number => {
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : 0;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
  };

  const dcrCandidatesForIssuer = (
    owner: Owner,
    issuer: string | null,
  ): Effect.Effect<readonly DcrReuseCandidate[], StorageFailure> =>
    deps.fuma
      .use("oauth_client.findMany", (db) =>
        looseDb(db).findMany("oauth_client", {
          where: (b: any) => b("owner", "=", owner),
        }),
      )
      .pipe(
        Effect.map((rows) => {
          const matches = rows.flatMap(
            (row): readonly (DcrReuseCandidate & { readonly createdAt: number })[] => {
              if (parseOAuthClientOrigin(row).kind !== "dynamic_client_registration") return [];
              // A candidate matches only via a non-null, canonicalized stored
              // issuer. The GC migration backfills origin_issuer on every
              // surviving DCR row, so post-migration a null-issuer row is a
              // transient (unmigrated) row; skipping it just mints one duplicate
              // the migration then GCs, rather than reusing on a fuzzy token-host
              // guess.
              const rowIssuer =
                row.origin_issuer == null ? null : canonicalIssuerUrl(String(row.origin_issuer));
              const issuerMatches = rowIssuer !== null && dcrIssuerMatches(rowIssuer, issuer);
              if (!issuerMatches) return [];
              return [
                {
                  slug: OAuthClientSlug.make(String(row.slug)),
                  resource: row.resource == null ? null : String(row.resource),
                  createdAt: candidateCreatedAt(row.created_at),
                },
              ];
            },
          );
          // Deterministic reuse order: oldest first, slug as a stable tiebreak
          // when timestamps collide or are missing. Without this, which of
          // several live duplicates sharing an (owner, issuer) gets reused is
          // whatever order the storage backend returned rows in — the reuse
          // pick must be stable across boots and backends.
          return [...matches]
            .sort(
              (a, b) =>
                a.createdAt - b.createdAt || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
            )
            .map(({ slug, resource }): DcrReuseCandidate => ({ slug, resource }));
        }),
      );

  const decideDcrClientReuse = (
    input: RegisterDynamicClientInput,
    issuer: string | null,
  ): Effect.Effect<
    {
      readonly existingSlug: OAuthClientSlug | null;
      readonly registrationSlug: OAuthClientSlug;
    },
    StorageFailure
  > =>
    Effect.gen(function* () {
      const candidates = yield* dcrCandidatesForIssuer(input.owner, issuer);
      const resource = input.resource ?? null;
      if (resource !== null) {
        const matchingResource = candidates.find((client) => client.resource === resource);
        if (matchingResource) {
          return { existingSlug: matchingResource.slug, registrationSlug: matchingResource.slug };
        }
        const slug = dcrClientSlug(issuer, candidates.length > 0 ? resource : null, input.slug);
        return {
          existingSlug: null,
          registrationSlug: slug,
        };
      }

      // Resource-less request: only reuse a resource-LESS candidate. A client
      // minted for a specific RFC 8707 resource must NOT be reused for a
      // resource-less flow (its tokens are bound to that resource), so when only
      // resource-scoped candidates exist we register a fresh resource-less client
      // rather than silently borrowing one (the old `?? candidates[0]` bug).
      const reusable = candidates.find((client) => client.resource === null);
      if (reusable) return { existingSlug: reusable.slug, registrationSlug: reusable.slug };
      // Fresh resource-less client. Its slug is the bare `dcr-<host>` base, but
      // the FIRST resource-scoped registration for an issuer also takes that base
      // (dcrClientSlug only suffixes once candidates exist). `createClient`
      // deletes any row with a colliding (owner, slug) first, so reusing the base
      // here would silently clobber that resource-scoped client. Dedupe against
      // the existing candidate slugs so the resource-less client keeps its own row.
      const takenSlugs = new Set(candidates.map((client) => String(client.slug)));
      const slug = uniqueDcrSlug(dcrClientSlug(issuer, null, input.slug), takenSlugs);
      return { existingSlug: null, registrationSlug: slug };
    });

  const registerDynamicClient = (
    input: RegisterDynamicClientInput,
  ): Effect.Effect<OAuthClientSlug, OAuthRegisterDynamicError | StorageFailure> =>
    Effect.gen(function* () {
      const issuer = canonicalDcrIssuer(input.issuer, input.registrationEndpoint);
      const reuse = yield* decideDcrClientReuse(input, issuer);
      if (reuse.existingSlug !== null) return reuse.existingSlug;

      const slug = reuse.registrationSlug;
      const flowRedirectUri = input.redirectUri ?? redirectUri;
      // DCR registers our callback as the client's redirect_uri — fail loudly
      // if the executor has none rather than registering a localhost URL.
      if (flowRedirectUri == null) {
        return yield* new OAuthRegisterDynamicError({
          message: REDIRECT_URI_REQUIRED_MESSAGE,
        });
      }
      const authMethod = pickDcrAuthMethod(input.tokenEndpointAuthMethodsSupported);
      const information = yield* registerDynamicClientDcr(
        {
          registrationEndpoint: input.registrationEndpoint,
          metadata: {
            client_name: input.clientName,
            redirect_uris: [flowRedirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: authMethod,
            scope: input.scopes.length > 0 ? input.scopes.join(" ") : undefined,
          },
        },
        { httpClientLayer, endpointUrlPolicy: deps.endpointUrlPolicy },
      ).pipe(
        Effect.mapError((cause) => {
          // Some authorization servers (Vercel, and others that follow RFC 8252
          // strictly) reject anonymous Dynamic Client Registration unless the
          // redirect URI is loopback (http://localhost or http://127.0.0.1).
          // Executor registers its browser origin, so any hosted, tailnet, or
          // LAN origin trips `invalid_redirect_uri`. Turn that opaque RFC code
          // into guidance the user can act on instead of the raw error.
          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message`
          const rawMessage = sanitizeOAuthBoundaryText(cause.message);
          const message =
            cause.error === "invalid_redirect_uri" && !isLoopbackHttpUrl(flowRedirectUri)
              ? `Automatic OAuth setup failed: this server only approves loopback redirect ` +
                `URLs (http://localhost or http://127.0.0.1) for automatic registration, but ` +
                `Executor is using ${flowRedirectUri}. Register an OAuth app manually with that ` +
                `redirect URL approved by the server, or run Executor on http://localhost.`
              : `Dynamic Client Registration failed: ${rawMessage}`;
          return new OAuthRegisterDynamicError({ message });
        }),
      );

      // Persist the minted client. DCR-minted public clients have no secret; we
      // store "" so the PKCE-only token exchange omits `client_secret`.
      // Confidential DCR clients keep the returned secret in the credential
      // provider. The persisted grant is interactive authorization_code.
      // `input.scopes` was already sent to the AS at registration above; the
      // stored client carries no scope set (the integration drives requests).
      yield* createClient({
        owner: input.owner,
        slug,
        authorizationUrl: input.authorizationUrl,
        tokenUrl: input.tokenUrl,
        resource: input.resource ?? null,
        grant: "authorization_code",
        clientId: information.client_id,
        clientSecret: information.client_secret ?? "",
        origin: {
          kind: "dynamic_client_registration",
          integration: input.originIntegration ?? null,
        },
        originIssuer: issuer,
      });
      return slug;
    });

  // -----------------------------------------------------------------------
  // listClients — metadata-only summaries of every client the caller can see.
  // The owner policy on `oauth_client` already narrows `findMany` to the
  // tenant's org rows + this subject's own user rows, so no explicit filter is
  // needed. The `client_secret` column is deliberately never projected.
  // -----------------------------------------------------------------------
  const listClients = (): Effect.Effect<readonly OAuthClientSummary[], StorageFailure> =>
    deps.fuma
      .use("oauth_client.findMany", (db) => looseDb(db).findMany("oauth_client", {}))
      .pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => {
            const grant = parseGrant(row.grant);
            // EXPLICIT — a row with an unknown grant is corrupt; surface it
            // loudly rather than silently displaying it as authorization_code.
            if (grant === null) {
              return Effect.fail(
                new StorageError({
                  message: `oauth_client ${String(row.slug)} has an unknown grant: ${String(row.grant)}`,
                  cause: undefined,
                }),
              );
            }
            return Effect.succeed({
              owner: String(row.owner) as Owner,
              slug: OAuthClientSlug.make(String(row.slug)),
              grant,
              authorizationUrl: String(row.authorization_url),
              tokenUrl: String(row.token_url),
              resource: row.resource == null ? null : String(row.resource),
              clientId: String(row.client_id),
              origin: parseOAuthClientOrigin(row),
            } satisfies OAuthClientSummary);
          }),
        ),
      );

  // -----------------------------------------------------------------------
  // Load an oauth_client row by (owner, slug).
  // -----------------------------------------------------------------------
  const loadClient = (
    owner: Owner,
    slug: OAuthClientSlug,
  ): Effect.Effect<LoadedOAuthClient | null, StorageFailure> =>
    deps.fuma
      .use("oauth_client.findFirst", (db) =>
        looseDb(db).findFirst("oauth_client", {
          where: (b: any) => b.and(b("owner", "=", owner), b("slug", "=", String(slug))),
        }),
      )
      .pipe(
        Effect.flatMap((row) => {
          if (!row) return Effect.succeed(null);
          const grant = parseGrant(row.grant);
          // EXPLICIT — this row drives the token exchange. An unknown grant is a
          // corrupt row; fail loudly rather than guessing authorization_code and
          // running the wrong flow.
          if (grant === null) {
            return Effect.fail(
              new StorageError({
                message: `oauth_client ${String(slug)} has an unknown grant: ${String(row.grant)}`,
                cause: undefined,
              }),
            );
          }
          // `client_secret_item_id` is null for DCR-minted / public PKCE clients;
          // the token exchange treats a missing secret as "public client, omit
          // client_secret" (see pickClientAuth). A confidential client persisted
          // its secret to the provider in createClient; resolve it back here.
          return Effect.gen(function* () {
            let clientSecret = "";
            if (row.client_secret_item_id != null) {
              const provider = deps.defaultWritableProvider();
              if (provider) {
                clientSecret =
                  (yield* provider.get(ProviderItemId.make(String(row.client_secret_item_id)))) ??
                  "";
              }
            }
            return {
              slug: String(row.slug),
              authorizationUrl: String(row.authorization_url),
              tokenUrl: String(row.token_url),
              grant,
              clientId: String(row.client_id),
              clientSecret,
              resource: row.resource == null ? null : String(row.resource),
            } satisfies LoadedOAuthClient;
          });
        }),
      );

  // -----------------------------------------------------------------------
  // start — begin a flow through a client to mint a connection.
  // -----------------------------------------------------------------------
  const start = (
    input: OAuthStartInput,
  ): Effect.Effect<ConnectResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const keys = yield* Effect.try({
        try: () => deps.ownedKeys(input.owner),
        catch: (cause) =>
          new StorageError({
            message: "Cannot start OAuth flow for owner without a subject",
            cause,
          }),
      });
      // Sharing is one-directional (org → members): a Workspace (org) connection
      // cannot be backed by a member's private (user) app. The connection owner
      // and the app owner are otherwise independent — a Personal connection
      // through a shared Workspace app is the supported cross-owner case.
      if (input.owner === "org" && input.clientOwner === "user") {
        return yield* new OAuthStartError({
          message: "A Workspace connection must use a Workspace app.",
        });
      }
      // Load the app by its EXPLICIT owner (the caller knows it — no derivation).
      // The connection is still minted under `input.owner`. Storage visibility
      // policy hides apps the actor cannot see, so a wrong owner yields null.
      const client = yield* loadClient(input.clientOwner, input.client);
      if (!client) {
        return yield* new OAuthStartError({
          message: `OAuth client not found: ${input.client}`,
        });
      }

      // Declared scopes win (driven by the selected auth template). MCP-style
      // integrations declare none and discover them from the client's protected
      // resource / authorization server metadata at connect.
      const scopePolicy = yield* deps
        .resolveOAuthScopePolicy(input.integration, input.template)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OAuthStartError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                message: `Failed to resolve OAuth scope policy: ${sanitizeOAuthBoundaryText(cause.message)}`,
              }),
          ),
        );
      const requestedScopes =
        scopePolicy.kind === "discover"
          ? yield* discoverScopesForResource(client.resource).pipe(
              Effect.mapError(
                (cause) =>
                  new OAuthStartError({
                    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message` field
                    message: `Failed to discover OAuth scopes: ${sanitizeOAuthBoundaryText(cause.message)}`,
                  }),
              ),
            )
          : dedupeScopes(scopePolicy.scopes);

      // client_credentials: exchange immediately and mint the connection.
      if (client.grant === "client_credentials") {
        if (input.correlation) {
          return yield* new OAuthStartError({
            message: "Durable OAuth completion correlation requires authorization_code.",
          });
        }
        const token = yield* exchangeClientCredentials({
          tokenUrl: client.tokenUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          scopes: requestedScopes,
          resource: client.resource ?? undefined,
          endpointUrlPolicy: deps.endpointUrlPolicy,
          fetch,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthStartError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message` field
                message: `OAuth client-credentials exchange failed: ${sanitizeOAuthBoundaryText(cause.message)}`,
              }),
          ),
        );
        const connection = yield* mintFromToken(
          input,
          client,
          token,
          requestedScopes,
          input.clientOwner,
          // client_credentials has no callback, so no regional rebind applies.
          null,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthStartError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                message: `Failed to mint OAuth connection: ${sanitizeOAuthBoundaryText(cause.message)}`,
              }),
          ),
        );
        return { status: "connected", connection } as const;
      }

      if (deps.requireOAuthCorrelation && !input.correlation) {
        return yield* new OAuthStartError({
          message:
            "OAuth completion correlation is required for the hosted authorization-code flow.",
        });
      }

      // authorization_code requires our callback to receive the code — fail
      // loudly if the executor was constructed without a redirectUri rather
      // than persisting a session pointed at a wrong localhost callback.
      const flowRedirectUri = input.redirectUri ?? redirectUri;
      if (flowRedirectUri == null) {
        return yield* new OAuthStartError({
          message: REDIRECT_URI_REQUIRED_MESSAGE,
        });
      }
      // Prune stale DECLARED scopes against the AS's advertised set, but leave
      // resource-discovered scopes untouched: an RFC 9728 `scopes_supported`
      // list is already authoritative (§7.2) and must not be re-narrowed by a
      // divergent authorization server.
      const authorizationRequestedScopes =
        scopePolicy.kind === "discover"
          ? requestedScopes
          : yield* filterAuthorizationCodeScopes(client, requestedScopes);

      // Correlated authorization-code flows are host-authorized. The selected
      // integration is the authoritative provider identity; unsigned caller
      // JSON cannot relabel the attempt.
      const provider = String(input.integration);
      const envelope = input.correlation ? normalizeCorrelationEnvelope(input.correlation) : null;
      if (input.correlation && envelope === null) {
        return yield* new OAuthStartError({
          message: "OAuth correlation envelope is invalid or oversized.",
        });
      }
      const correlation = envelope ? yield* trustedCorrelationForStart(envelope, provider) : null;
      const descriptorHash = correlation
        ? yield* sha256Hex(canonicalOAuthCorrelationBinding(correlation))
        : null;
      const executionId = correlation ? crypto.randomUUID() : null;

      // authorization_code: build the authorize URL and reserve the durable
      // attempt/session together before returning a browser redirect.
      const verifier = createPkceCodeVerifier();
      const challenge = yield* Effect.promise(() => createPkceCodeChallenge(verifier));
      const state = OAuthState.make(createOAuthState());
      const providerState = encodeOAuthCallbackState({
        state: String(state),
        orgSlug: deps.callbackStateOrgSlug,
        correlation: envelope,
      });

      const authorizationUrl = yield* Effect.try({
        try: () =>
          buildAuthorizationUrl({
            authorizationUrl: client.authorizationUrl,
            clientId: client.clientId,
            redirectUrl: flowRedirectUri,
            scopes: authorizationRequestedScopes,
            state: providerState,
            codeChallenge: challenge,
            resource: client.resource ?? undefined,
            // Provider quirks (Google: access_type=offline + prompt=consent) —
            // without these Google returns no refresh token and won't re-consent
            // to widen scopes on reconnect.
            extraParams: providerAuthorizeExtras(client.authorizationUrl),
            endpointUrlPolicy: deps.endpointUrlPolicy,
          }),
        catch: (cause) =>
          new OAuthStartError({
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: surface the URL-construction failure
            message: `Failed to build authorization URL: ${sanitizeOAuthBoundaryText(String(cause))}`,
          }),
      });

      if (!correlation || !descriptorHash || !executionId || !envelope) {
        const now = new Date();
        const expiresAt = Date.now() + OAUTH2_SESSION_TTL_MS;
        yield* deps.fuma.use("oauth_session.create", (db) =>
          looseDb(db).create("oauth_session", {
            tenant: keys.tenant,
            owner: keys.owner,
            subject: keys.subject,
            state: String(state),
            client_slug: String(input.client),
            integration: String(input.integration),
            name: String(input.name),
            template: String(input.template),
            redirect_url: flowRedirectUri,
            pkce_verifier: verifier,
            identity_label: input.identityLabel ?? null,
            payload: {
              owner: input.owner,
              clientOwner: input.clientOwner,
              requestedScopes: authorizationRequestedScopes,
            },
            attempt_key: null,
            actor_user_id: null,
            authenticated_subject_id: null,
            workspace_id: null,
            provider: null,
            descriptor_hash: null,
            execution_id: null,
            correlation_envelope: null,
            expires_at: expiresAt,
            created_at: now,
          }),
        );
        return { status: "redirect", authorizationUrl, state } as const;
      }

      const now = new Date();
      const expiresAt = Date.now() + OAUTH2_SESSION_TTL_MS;
      const reserved = yield* reserveAttemptAndSession({
        keys,
        state,
        authorizationUrl,
        flowRedirectUri,
        verifier,
        now,
        expiresAt,
        client: input.client,
        clientOwner: input.clientOwner,
        owner: input.owner,
        integration: input.integration,
        name: input.name,
        template: input.template,
        identityLabel: input.identityLabel,
        requestedScopes: authorizationRequestedScopes,
        correlation,
        envelope,
        descriptorHash,
        executionId,
      });
      if (reserved) return { status: "redirect", authorizationUrl, state } as const;

      // Same attempt key is idempotent. A conflicting binding is rejected;
      // otherwise return the original redirect or the durable winner.
      const existing = yield* loadAttemptByKey(correlation.attemptKey);
      const existingBinding = existing ? attemptBindingFromRow(existing) : null;
      if (!existing || !existingBinding || !sameCorrelation(existingBinding, correlation)) {
        return yield* new OAuthStartError({
          message: "OAuth attempt key is already reserved for a different binding.",
        });
      }
      if (String(existing.status) === "completed") {
        const connection = yield* loadValidatedCompletionConnection({
          correlation,
          descriptorHash,
        }).pipe(
          Effect.mapError(
            () =>
              new OAuthStartError({
                message: "Completed OAuth attempt receipt validation failed.",
              }),
          ),
        );
        if (connection) return { status: "connected", connection } as const;
        return yield* new OAuthStartError({
          message: "Completed OAuth attempt is missing its connection receipt.",
        });
      }
      return {
        status: "redirect",
        authorizationUrl: String(existing.authorization_url),
        state: OAuthState.make(String(existing.state)),
      } as const;
    });

  // -----------------------------------------------------------------------
  // complete — redeem the session, exchange the code, mint the connection.
  // -----------------------------------------------------------------------
  const loadCompletionReceiptRow = (
    attemptKey: string,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    deps.fuma.use("oauth_completion_receipt.findFirst", (db) =>
      looseDb(db).findFirst("oauth_completion_receipt", {
        where: (b: any) => b("attempt_key", "=", attemptKey),
      }),
    );

  const sameCorrelation = (
    left: Pick<
      OAuthCorrelationBindingType,
      | "attemptKey"
      | "actorUserId"
      | "authenticatedSubjectId"
      | "organizationId"
      | "workspaceId"
      | "provider"
    >,
    right: Pick<
      OAuthCorrelationBindingType,
      | "attemptKey"
      | "actorUserId"
      | "authenticatedSubjectId"
      | "organizationId"
      | "workspaceId"
      | "provider"
    >,
  ): boolean =>
    left.attemptKey === right.attemptKey &&
    left.actorUserId === right.actorUserId &&
    left.authenticatedSubjectId === right.authenticatedSubjectId &&
    left.organizationId === right.organizationId &&
    left.workspaceId === right.workspaceId &&
    left.provider === right.provider;

  const loadValidatedCompletionReceipt = (input: {
    readonly correlation: OAuthCorrelationBindingType;
    readonly descriptorHash: string;
    readonly requestHash?: string;
  }): Effect.Effect<OAuthCompletionReceiptType | null, OAuthCompleteError | StorageFailure> =>
    Effect.gen(function* () {
      const row = yield* loadCompletionReceiptRow(input.correlation.attemptKey);
      if (!row) return null;
      const receipt = receiptFromRow(row);
      if (!receipt) {
        return yield* new OAuthCompleteError({
          message: "OAuth completion receipt is invalid; operator recovery is required.",
          restartRequired: false,
        });
      }
      if (!sameCorrelation(input.correlation, receipt)) {
        return yield* new OAuthCompleteError({
          message: "OAuth completion receipt does not match the supplied correlation binding.",
          restartRequired: false,
        });
      }
      if (receipt.descriptorHash !== input.descriptorHash) {
        return yield* new OAuthCompleteError({
          message: "OAuth completion descriptor does not match the durable receipt.",
          restartRequired: false,
        });
      }
      if (input.requestHash !== undefined && receipt.requestHash !== input.requestHash) {
        return yield* new OAuthCompleteError({
          message: "OAuth completion request does not match the durable receipt.",
          restartRequired: false,
        });
      }
      return receipt;
    });

  const loadValidatedCompletionConnection = (input: {
    readonly correlation: OAuthCorrelationBindingType;
    readonly descriptorHash: string;
    readonly requestHash?: string;
  }): Effect.Effect<Connection | null, OAuthCompleteError | StorageFailure> =>
    Effect.gen(function* () {
      const receipt = yield* loadValidatedCompletionReceipt(input);
      if (!receipt) return null;
      const connection = yield* deps.getConnection(connectionRefFromReceipt(receipt));
      if (!connection) {
        return yield* new OAuthCompleteError({
          message:
            "OAuth completion receipt exists but its connection is unavailable; operator recovery is required.",
          restartRequired: false,
        });
      }
      return connection;
    });

  const validateCompletionCorrelation = (
    correlation: OAuthCorrelationBindingType,
    expectedProvider?: string,
  ): Effect.Effect<void, OAuthCompleteError> => {
    if (correlation.organizationId !== deps.tenant) {
      return Effect.fail(
        new OAuthCompleteError({
          message:
            "OAuth correlation binding organization does not match the authenticated organization.",
          restartRequired: false,
        }),
      );
    }
    if (deps.subject === null || correlation.authenticatedSubjectId !== deps.subject) {
      return Effect.fail(
        new OAuthCompleteError({
          message: "Correlated OAuth requires the bound authenticated subject.",
          restartRequired: false,
        }),
      );
    }
    if (expectedProvider !== undefined && correlation.provider !== expectedProvider) {
      return Effect.fail(
        new OAuthCompleteError({
          message: "OAuth correlation provider does not match the OAuth session.",
          restartRequired: false,
        }),
      );
    }
    return Effect.void;
  };

  const trustedCorrelationForComplete = (
    envelope: OAuthCorrelationEnvelopeType,
    expectedProvider?: string,
  ): Effect.Effect<OAuthCorrelationBindingType, OAuthCompleteError | StorageFailure> =>
    verifySignedCorrelation(envelope).pipe(
      Effect.mapError(
        (cause) =>
          new OAuthCompleteError({
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: the verifier exposes a typed StorageFailure message
            message: sanitizeOAuthBoundaryText(cause.message),
            restartRequired: false,
          }),
      ),
      Effect.tap((binding) => validateCompletionCorrelation(binding, expectedProvider)),
    );

  const complete = (
    input: OAuthCompleteInput,
  ): Effect.Effect<Connection, OAuthCompleteError | OAuthSessionNotFoundError | StorageFailure> =>
    Effect.gen(function* () {
      const callbackDomain = input.callbackDomain?.trim() || null;
      const suppliedEnvelope = input.correlation
        ? normalizeCorrelationEnvelope(input.correlation)
        : null;
      if (input.correlation && suppliedEnvelope === null) {
        return yield* new OAuthCompleteError({
          message: "OAuth correlation envelope is invalid or oversized.",
          restartRequired: false,
        });
      }
      const sessionRow = yield* deps.fuma.use("oauth_session.findFirst", (db) =>
        looseDb(db).findFirst("oauth_session", {
          where: (b: any) => b("state", "=", String(input.state)),
        }),
      );
      if (!sessionRow) {
        // The session is deleted after a successful completion. A caller that
        // lost the callback can replay the same request by supplying its
        // non-secret binding; recovery reads the durable receipt and never
        // invokes the provider a second time.
        if (suppliedEnvelope) {
          const suppliedCorrelation = yield* trustedCorrelationForComplete(suppliedEnvelope);
          const descriptorHash = yield* sha256Hex(
            canonicalOAuthCorrelationBinding(suppliedCorrelation),
          );
          const requestHash = yield* requestHashForCompletion(
            input.state,
            input.code,
            callbackDomain,
            descriptorHash,
          );
          const connection = yield* loadValidatedCompletionConnection({
            correlation: suppliedCorrelation,
            descriptorHash,
            requestHash,
          });
          if (connection) return connection;
        }
        return yield* new OAuthSessionNotFoundError({ state: input.state });
      }
      const session = {
        owner: String(sessionRow.owner) as Owner,
        clientSlug: OAuthClientSlug.make(String(sessionRow.client_slug)),
        integration: IntegrationSlug.make(String(sessionRow.integration)),
        name: ConnectionName.make(String(sessionRow.name)),
        template: AuthTemplateSlug.make(String(sessionRow.template)),
        redirectUrl: String(sessionRow.redirect_url),
        pkceVerifier: sessionRow.pkce_verifier == null ? null : String(sessionRow.pkce_verifier),
        identityLabel: sessionRow.identity_label == null ? null : String(sessionRow.identity_label),
        expiresAt: Number(sessionRow.expires_at),
        // The scope set `start` requested (the integration's declared or
        // discovered scopes), persisted on the session payload. Drives the
        // recorded-scope fallback when the AS omits `scope`. Missing/legacy
        // payloads fall back to the client's scopes below.
        requestedScopes: requestedScopesFromPayload(sessionRow.payload),
        // The app's owner, recorded by `start` — reload the SAME app at
        // completion by explicit owner (no derivation). Defaults to the session
        // owner for same-owner connects.
        clientOwner:
          clientOwnerFromPayload(sessionRow.payload) ?? (String(sessionRow.owner) as Owner),
        attemptKey: sessionRow.attempt_key == null ? null : String(sessionRow.attempt_key),
        actorUserId: sessionRow.actor_user_id == null ? null : String(sessionRow.actor_user_id),
        authenticatedSubjectId:
          sessionRow.authenticated_subject_id == null
            ? null
            : String(sessionRow.authenticated_subject_id),
        workspaceId: sessionRow.workspace_id == null ? null : String(sessionRow.workspace_id),
        provider: sessionRow.provider == null ? null : String(sessionRow.provider),
        descriptorHashStored:
          sessionRow.descriptor_hash == null ? null : String(sessionRow.descriptor_hash),
        executionIdStored: sessionRow.execution_id == null ? null : String(sessionRow.execution_id),
        correlationEnvelope: envelopeFromStored(sessionRow.correlation_envelope),
      };

      const firstClassStoredCorrelation =
        session.attemptKey &&
        session.actorUserId &&
        session.authenticatedSubjectId &&
        session.workspaceId &&
        session.provider
          ? normalizeCorrelation({
              schemaVersion: OAUTH_CORRELATION_SCHEMA_VERSION,
              attemptKey: session.attemptKey,
              actorUserId: session.actorUserId,
              authenticatedSubjectId: session.authenticatedSubjectId,
              organizationId: deps.tenant,
              workspaceId: session.workspaceId,
              provider: session.provider,
            })
          : null;
      const storedCorrelation =
        firstClassStoredCorrelation ??
        (session.correlationEnvelope
          ? normalizeCorrelation(bindingFromEnvelope(session.correlationEnvelope))
          : null) ??
        correlationFromPayload(sessionRow.payload);
      const suppliedCorrelation = suppliedEnvelope
        ? yield* trustedCorrelationForComplete(suppliedEnvelope, session.provider ?? undefined)
        : null;
      const correlation = suppliedCorrelation ?? storedCorrelation;
      if (deps.requireOAuthCorrelation && !suppliedEnvelope) {
        return yield* new OAuthCompleteError({
          message:
            "OAuth completion correlation envelope is required; legacy uncorrelated callbacks are not redeemable.",
          restartRequired: true,
        });
      }
      if (storedCorrelation && suppliedCorrelation === null && suppliedEnvelope) {
        return yield* new OAuthCompleteError({
          message: "OAuth session does not carry the supplied correlation binding.",
          restartRequired: false,
        });
      }
      if (
        suppliedCorrelation &&
        storedCorrelation &&
        !sameCorrelation(suppliedCorrelation, storedCorrelation)
      ) {
        return yield* new OAuthCompleteError({
          message: "OAuth correlation binding does not match the OAuth session.",
          restartRequired: false,
        });
      }
      if (correlation)
        yield* validateCompletionCorrelation(correlation, session.provider ?? undefined);
      const descriptorHash = correlation
        ? yield* sha256Hex(canonicalOAuthCorrelationBinding(correlation))
        : null;
      const persistedDescriptorHash = session.descriptorHashStored;
      if (descriptorHash && persistedDescriptorHash && descriptorHash !== persistedDescriptorHash) {
        return yield* new OAuthCompleteError({
          message: "OAuth session correlation descriptor is invalid; restart the flow.",
          restartRequired: true,
        });
      }
      const executionId = correlation ? session.executionIdStored : null;
      if (correlation && executionId === null) {
        return yield* new OAuthCompleteError({
          message: "OAuth session is missing its completion execution id; restart the flow.",
          restartRequired: true,
        });
      }

      // A receipt may coexist briefly with the session when process loss occurs
      // between the transaction commit and session deletion. Resolve it before
      // checking expiry or loading the provider client so replay never exchanges
      // the authorization code a second time.
      if (correlation && descriptorHash) {
        const requestHash = yield* requestHashForCompletion(
          input.state,
          input.code,
          callbackDomain,
          descriptorHash,
        );
        const connection = yield* loadValidatedCompletionConnection({
          correlation,
          descriptorHash,
          requestHash,
        });
        if (connection) return connection;
      }

      const correlatedAttemptKey = correlation?.attemptKey;
      let claim = correlatedAttemptKey ? yield* claimAttempt(correlatedAttemptKey) : null;
      while (claim && claim.kind === "waiting") {
        const winner = yield* waitForAttemptWinner(correlatedAttemptKey ?? "");
        if (winner === "completed") {
          if (!correlation || !descriptorHash) {
            return yield* new OAuthCompleteError({
              message: "OAuth attempt completed without its correlation binding.",
              restartRequired: false,
            });
          }
          const requestHash = yield* requestHashForCompletion(
            input.state,
            input.code,
            callbackDomain,
            descriptorHash,
          );
          const connection = yield* loadValidatedCompletionConnection({
            correlation,
            descriptorHash,
            requestHash,
          });
          if (connection) return connection;
          return yield* new OAuthCompleteError({
            message: "OAuth attempt completed without a recoverable connection receipt.",
            restartRequired: false,
          });
        }
        if (winner === "failed") {
          return yield* new OAuthCompleteError({
            message: "OAuth attempt failed; restart the flow.",
            restartRequired: true,
          });
        }
        claim = yield* claimAttempt(correlatedAttemptKey ?? "");
      }
      if (claim && claim.kind === "completed") {
        if (!correlation || !descriptorHash) {
          return yield* new OAuthCompleteError({
            message: "OAuth attempt completed without its correlation binding.",
            restartRequired: false,
          });
        }
        const requestHash = yield* requestHashForCompletion(
          input.state,
          input.code,
          callbackDomain,
          descriptorHash,
        );
        const connection = yield* loadValidatedCompletionConnection({
          correlation,
          descriptorHash,
          requestHash,
        });
        if (connection) return connection;
        return yield* new OAuthCompleteError({
          message: "OAuth attempt completed without a recoverable connection receipt.",
          restartRequired: false,
        });
      }
      if (claim && claim.kind === "failed") {
        return yield* new OAuthCompleteError({
          message: "OAuth attempt failed; restart the flow.",
          restartRequired: true,
        });
      }
      if (claim && claim.kind === "missing") {
        return yield* new OAuthCompleteError({
          message: "OAuth attempt reservation is missing; restart the flow.",
          restartRequired: true,
        });
      }
      const activeClaim = claim?.kind === "claimed" ? claim.claim : null;

      // Expired sessions are not redeemable — drop + treat as not found.
      if (Number.isFinite(session.expiresAt) && session.expiresAt <= Date.now()) {
        yield* deleteSession(input.state);
        return yield* new OAuthSessionNotFoundError({ state: input.state });
      }

      // Reload the SAME app `start` resolved, by its explicit recorded owner.
      const client = yield* loadClient(session.clientOwner, session.clientSlug);
      if (!client) {
        return yield* new OAuthCompleteError({
          message: `OAuth client not found: ${session.clientSlug}`,
          restartRequired: true,
        });
      }

      // The PKCE verifier is minted by `start` for every authorization_code
      // session. A null/missing one means a corrupt session row — exchanging
      // with an empty verifier would violate RFC 7636 and the AS would reject
      // it with an opaque error. Fail loudly + require a restart instead.
      if (session.pkceVerifier == null) {
        return yield* new OAuthCompleteError({
          message: `OAuth session ${input.state} is missing its PKCE code verifier; restart the flow.`,
          restartRequired: true,
        });
      }

      // Some authorization servers (Datadog) advertise one region's token
      // endpoint in static metadata but issue codes that only redeem at the
      // org's actual region, signalled back on the callback as `domain`/`site`.
      // Rebind the token host to that region when it is a sibling subdomain of
      // the configured host; otherwise this is a no-op.
      const tokenUrl = rebindTokenEndpointHostToCallbackDomain(client.tokenUrl, callbackDomain);

      if (correlation && !activeClaim) {
        return yield* new OAuthCompleteError({
          message: "OAuth attempt has no active lease; provider exchange is blocked.",
          restartRequired: false,
        });
      }

      const intent = correlation ? yield* loadCredentialIntent(correlation.attemptKey) : null;
      const exchangeIntent =
        correlation && activeClaim
          ? yield* ensureExchangeIntent({
              claim: activeClaim,
              state: input.state,
              provider: correlation.provider,
              client: OAuthClientSlug.make(client.slug),
              codeHash: yield* sha256Hex(input.code),
            })
          : null;
      let mint: Effect.Effect<Connection, OAuthCompleteError | StorageFailure>;
      let recoveredIntent: MintOAuthConnectionInput | null = null;
      if (intent && activeClaim) {
        const provider = deps.defaultWritableProvider();
        if (!provider) {
          return yield* new OAuthCompleteError({
            message: "Credential provider for OAuth recovery is unavailable.",
            restartRequired: false,
          });
        }
        const itemState = yield* verifyStoredCredentialItems({ claim: activeClaim, provider });
        if (itemState === "uncertain") {
          return yield* new OAuthCompleteError({
            message:
              "OAuth credential provider write outcome is unresolved; completion remains fenced for recovery.",
            restartRequired: false,
          });
        }
        if (itemState === "compensatable") {
          yield* rebindCredentialItems(activeClaim);
          yield* compensateCredentialItems({ claim: activeClaim, provider });
          return yield* new OAuthCompleteError({
            message:
              "OAuth credential recovery found a partial provider write; completion is blocked pending compensation.",
            restartRequired: false,
          });
        }
        if (itemState === "complete") {
          yield* rebindCredentialIntent(activeClaim);
          yield* rebindExchangeIntent(activeClaim);
          recoveredIntent = yield* mintFromStoredIntent(intent).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
        }
      }
      if (
        correlation &&
        activeClaim &&
        exchangeIntent &&
        (String(exchangeIntent.status) === "succeeded" ||
          (String(exchangeIntent.status) === "exchanging" &&
            (exchangeIntent.lease_token !== activeClaim.token ||
              Number(exchangeIntent.lease_generation ?? 0) !== activeClaim.generation))) &&
        !recoveredIntent
      ) {
        return yield* new OAuthCompleteError({
          message:
            "OAuth provider exchange has an unknown or already-owned outcome; re-exchange is blocked.",
          restartRequired: false,
        });
      }
      if (recoveredIntent) {
        mint = deps.mintOAuthConnection(recoveredIntent).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthCompleteError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: minting exposes a typed StorageFailure message
                message: `Failed to mint OAuth connection: ${sanitizeOAuthBoundaryText(cause.message)}`,
                restartRequired: false,
              }),
          ),
        );
      } else {
        const authorizationExchange = exchangeAuthorizationCode({
          tokenUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          redirectUrl: session.redirectUrl,
          codeVerifier: session.pkceVerifier,
          code: input.code,
          resource: client.resource ?? undefined,
          endpointUrlPolicy: deps.endpointUrlPolicy,
          fetch,
        });
        const token = yield* (
          activeClaim
            ? withAttemptHeartbeat(activeClaim, authorizationExchange)
            : authorizationExchange
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthCompleteError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message` field
                message: `OAuth code exchange failed: ${sanitizeOAuthBoundaryText(cause.message)}`,
                restartRequired:
                  Predicate.isTagged("OAuth2Error")(cause) && cause.error === "invalid_grant",
              }),
          ),
        );
        const target = {
          owner: session.owner,
          name: session.name,
          integration: session.integration,
          template: session.template,
          identityLabel: session.identityLabel ?? token.idTokenIdentityLabel ?? null,
        };
        if (correlation) {
          if (!activeClaim) {
            return yield* new StorageError({
              message: "OAuth attempt lease is missing before credential persistence.",
              cause: undefined,
            });
          }
          // Establish the durable intent before any provider write. The intent
          // must survive an external write that outlives a rolled-back DB txn.
          const stored = yield* withAttemptHeartbeat(
            activeClaim,
            persistCredentialIntent({
              claim: activeClaim,
              target,
              client,
              token,
              requestedScopes: session.requestedScopes ?? [],
              clientOwner: session.clientOwner,
              oauthTokenUrl: tokenUrl === client.tokenUrl ? null : tokenUrl,
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OAuthCompleteError({
                  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                  message: `Failed to persist OAuth credential intent: ${sanitizeOAuthBoundaryText(cause.message)}`,
                  restartRequired: false,
                }),
            ),
          );
          yield* withAttemptHeartbeat(
            activeClaim,
            markExchangeSucceeded({
              claim: activeClaim,
              accessTokenHash: yield* sha256Hex(token.access_token),
              refreshTokenHash: token.refresh_token ? yield* sha256Hex(token.refresh_token) : null,
            }),
          );
          mint = deps
            .mintOAuthConnection({
              owner: target.owner,
              name: target.name,
              integration: target.integration,
              template: target.template,
              identityLabel: target.identityLabel ?? null,
              provider: String(stored.provider.key),
              itemId: stored.itemId,
              oauthClient: OAuthClientSlug.make(client.slug),
              oauthClientOwner: session.clientOwner,
              refreshItemId: stored.refreshItemId,
              expiresAt: stored.expiresAt,
              oauthScope: stored.oauthScope,
              missingOAuthScopes: stored.missingOAuthScopes,
              oauthTokenUrl: tokenUrl === client.tokenUrl ? null : tokenUrl,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OAuthCompleteError({
                    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                    message: `Failed to mint OAuth connection: ${sanitizeOAuthBoundaryText(cause.message)}`,
                    restartRequired: false,
                  }),
              ),
            );
        } else {
          mint = mintFromToken(
            target,
            client,
            token,
            // The scopes `start` requested (the integration's declared set), persisted
            // on the session. Empty only for a corrupt/legacy session with no payload.
            session.requestedScopes ?? [],
            session.clientOwner,
            // Persist the regional token endpoint ONLY when it differs from the
            // client's configured one, so refresh redeems against the same region.
            tokenUrl === client.tokenUrl ? null : tokenUrl,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OAuthCompleteError({
                  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                  message: `Failed to mint OAuth connection: ${sanitizeOAuthBoundaryText(cause.message)}`,
                  restartRequired: false,
                }),
            ),
          );
        }
      }

      let connection: Connection;
      if (correlation && descriptorHash && executionId) {
        if (!activeClaim) {
          return yield* new StorageError({
            message: "OAuth completion lease is missing; durable receipt commit is blocked.",
            cause: undefined,
          });
        }
        const completedAt = new Date();
        const startedAt = dateFromStored(sessionRow.created_at) ?? completedAt;
        const durationMs = Math.min(
          15 * 60 * 1000,
          Math.max(0, completedAt.getTime() - startedAt.getTime()),
        );
        const requestHash = yield* requestHashForCompletion(
          input.state,
          input.code,
          callbackDomain,
          descriptorHash,
        );
        // Provider writes and connection minting are external to the receipt
        // transaction. The durable credential intent makes this recoverable if
        // the process dies after minting but before the metadata commit.
        connection = activeClaim ? yield* withAttemptHeartbeat(activeClaim, mint) : yield* mint;
        if (activeClaim) yield* assertAttemptClaim(activeClaim);
        yield* deps.fuma.transaction(
          Effect.gen(function* () {
            yield* deps.fuma.use("oauth_attempt.complete", (db) =>
              looseDb(db).updateMany("oauth_attempt", {
                where: (b: any) =>
                  b.and(
                    b("attempt_key", "=", correlation.attemptKey),
                    b("status", "=", "exchanging"),
                    b("lease_token", "=", activeClaim.token),
                    b("lease_generation", "=", activeClaim.generation),
                  ),
                set: {
                  status: "completed",
                  lease_expires_at: null,
                  updated_at: completedAt,
                  completed_at: completedAt,
                },
              }),
            );
            const completed = yield* deps.fuma.use("oauth_attempt.complete.verify", (db) =>
              looseDb(db).findFirst("oauth_attempt", {
                where: (b: any) =>
                  b.and(
                    b("attempt_key", "=", correlation.attemptKey),
                    b("status", "=", "completed"),
                    b("lease_token", "=", activeClaim.token),
                    b("lease_generation", "=", activeClaim.generation),
                  ),
              }),
            );
            if (!completed) {
              return yield* new StorageError({
                message: "OAuth completion lease CAS failed before receipt write.",
                cause: undefined,
              });
            }
            yield* deps.fuma.use("oauth_completion_receipt.create", (db) =>
              looseDb(db).create("oauth_completion_receipt", {
                tenant: deps.tenant,
                attempt_key: correlation.attemptKey,
                actor_user_id: correlation.actorUserId,
                authenticated_subject_id: correlation.authenticatedSubjectId,
                organization_id: correlation.organizationId,
                workspace_id: correlation.workspaceId,
                provider: correlation.provider,
                execution_id: executionId,
                status: "completed",
                result_reference: String(connection.address),
                connection_owner: connection.owner,
                connection_integration: String(connection.integration),
                connection_name: String(connection.name),
                connection_address: String(connection.address),
                request_hash: requestHash,
                descriptor_hash: descriptorHash,
                started_at: startedAt,
                completed_at: completedAt,
                duration_ms: durationMs,
                lease_token: activeClaim.token,
                lease_generation: activeClaim.generation,
                created_at: completedAt,
              }),
            );
            yield* markCredentialIntentCommitted(activeClaim, completedAt);
            const committedIntent = yield* deps.fuma.use(
              "oauth_credential_intent.commit.verify",
              (db) =>
                looseDb(db).findFirst("oauth_credential_intent", {
                  where: (b: any) =>
                    b.and(
                      b("attempt_key", "=", correlation.attemptKey),
                      b("status", "=", "committed"),
                      b("lease_token", "=", activeClaim.token),
                      b("lease_generation", "=", activeClaim.generation),
                    ),
                }),
            );
            if (!committedIntent) {
              return yield* new StorageError({
                message: "OAuth credential intent CAS failed before receipt commit.",
                cause: undefined,
              });
            }
          }),
        );
        const completedAttempt = yield* loadAttemptByKey(activeClaim.attemptKey);
        if (
          !completedAttempt ||
          String(completedAttempt.status) !== "completed" ||
          completedAttempt.lease_token !== activeClaim.token ||
          Number(completedAttempt.lease_generation ?? 0) !== activeClaim.generation
        ) {
          return yield* new StorageError({
            message: "OAuth completion lease was lost before durable receipt commit.",
            cause: undefined,
          });
        }
      } else {
        connection = yield* mint;
      }

      yield* deleteSession(input.state);
      return connection;
    });

  const getCompletionReceipt = (
    input: OAuthCompletionReceiptLookupInput,
  ): Effect.Effect<OAuthCompletionReceiptType | null, OAuthCompleteError | StorageFailure> =>
    Effect.gen(function* () {
      const envelope = normalizeCorrelationEnvelope(input.correlation);
      if (!envelope) {
        return yield* new OAuthCompleteError({
          message: "OAuth correlation envelope is invalid or oversized.",
          restartRequired: false,
        });
      }
      const correlation = yield* trustedCorrelationForComplete(envelope);
      const descriptorHash = yield* sha256Hex(canonicalOAuthCorrelationBinding(correlation));
      const row = yield* loadCompletionReceiptRow(correlation.attemptKey);
      if (!row) return null;
      const receipt = receiptFromRow(row);
      if (!receipt) {
        return yield* new OAuthCompleteError({
          message: "OAuth completion receipt is invalid; operator recovery is required.",
          restartRequired: false,
        });
      }
      if (!sameCorrelation(correlation, receipt)) {
        return yield* new OAuthCompleteError({
          message: "OAuth completion receipt does not match the supplied correlation binding.",
          restartRequired: false,
        });
      }
      if (receipt.descriptorHash !== descriptorHash) {
        return yield* new OAuthCompleteError({
          message: "OAuth completion descriptor does not match the durable receipt.",
          restartRequired: false,
        });
      }
      return receipt;
    });

  // -----------------------------------------------------------------------
  // Mint the connection from a freshly exchanged token: store the access
  // value (+ refresh) in the default writable provider, then write the
  // connection row with OAuth lifecycle fields + produce its tools.
  // -----------------------------------------------------------------------
  const loadCredentialIntent = (
    attemptKey: string,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    deps.fuma.use("oauth_credential_intent.findFirst", (db) =>
      looseDb(db).findFirst("oauth_credential_intent", {
        where: (b: any) => b("attempt_key", "=", attemptKey),
      }),
    );

  const loadExchangeIntent = (
    attemptKey: string,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    deps.fuma.use("oauth_exchange_intent.findFirst", (db) =>
      looseDb(db).findFirst("oauth_exchange_intent", {
        where: (b: any) => b("attempt_key", "=", attemptKey),
      }),
    );

  const ensureExchangeIntent = (input: {
    readonly claim: OAuthAttemptClaim;
    readonly state: OAuthState;
    readonly provider: string;
    readonly client: OAuthClientSlug;
    readonly codeHash: string;
  }): Effect.Effect<Record<string, unknown>, OAuthCompleteError | StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(input.claim);
      const now = new Date();
      const existing = yield* loadExchangeIntent(input.claim.attemptKey);
      if (!existing) {
        yield* deps.fuma
          .transaction(
            deps.fuma.use("oauth_exchange_intent.create", (db) =>
              looseDb(db).create("oauth_exchange_intent", {
                tenant: deps.tenant,
                attempt_key: input.claim.attemptKey,
                state: String(input.state),
                provider: input.provider,
                client_slug: String(input.client),
                code_hash: input.codeHash,
                // This is an Executor transaction key only. It is not provider
                // evidence; providers that lack idempotency/readback remain
                // fail-closed after an unknown exchange outcome.
                provider_transaction_key: `executor:${input.claim.attemptKey}`,
                status: "prepared",
                lease_token: input.claim.token,
                lease_generation: input.claim.generation,
                access_token_hash: null,
                refresh_token_hash: null,
                started_at: now,
                updated_at: now,
                completed_at: null,
                failure_code: null,
              }),
            ),
          )
          .pipe(Effect.catchTag("UniqueViolationError", () => Effect.void));
      }
      let row = yield* loadExchangeIntent(input.claim.attemptKey);
      if (!row) {
        return yield* new OAuthCompleteError({
          message: "OAuth exchange intent disappeared; operator recovery is required.",
          restartRequired: false,
        });
      }
      if (
        String(row.code_hash) !== input.codeHash ||
        String(row.provider) !== input.provider ||
        String(row.client_slug) !== String(input.client)
      ) {
        return yield* new OAuthCompleteError({
          message: "OAuth exchange intent does not match the reserved attempt.",
          restartRequired: false,
        });
      }
      const status = String(row.status);
      if (status === "succeeded") return row;
      if (status === "failed" || status === "unknown") {
        return yield* new OAuthCompleteError({
          message: "OAuth exchange outcome is terminal; restart the flow.",
          restartRequired: true,
        });
      }
      if (status === "exchanging") {
        // The caller decides whether this is recoverable from the durable
        // credential outbox.  Returning the row here is intentional: blindly
        // rejecting would strand a successful provider exchange after a
        // process crash, while blindly re-exchanging would consume a one-time
        // code twice.
        return row;
      }
      if (
        row.lease_token !== input.claim.token ||
        Number(row.lease_generation ?? 0) !== input.claim.generation
      ) {
        // `prepared` proves the provider exchange never started. A process may
        // die after committing that pre-exchange intent but before the guarded
        // transition to `exchanging`. The current authoritative attempt lease
        // can safely adopt only this untouched state; exchanging/succeeded
        // rows remain fenced from one-time code reuse.
        yield* deps.fuma.use("oauth_exchange_intent.rebindPrepared", (db) =>
          looseDb(db).updateMany("oauth_exchange_intent", {
            where: (b: any) =>
              b.and(b("attempt_key", "=", input.claim.attemptKey), b("status", "=", "prepared")),
            set: {
              lease_token: input.claim.token,
              lease_generation: input.claim.generation,
              updated_at: now,
            },
          }),
        );
        row = yield* loadExchangeIntent(input.claim.attemptKey);
        if (
          !row ||
          String(row.status) !== "prepared" ||
          row.lease_token !== input.claim.token ||
          Number(row.lease_generation ?? 0) !== input.claim.generation
        ) {
          return yield* new OAuthCompleteError({
            message: "OAuth exchange intent was reclaimed; provider outcome is serialized.",
            restartRequired: false,
          });
        }
      }
      yield* deps.fuma.use("oauth_exchange_intent.begin", (db) =>
        looseDb(db).updateMany("oauth_exchange_intent", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", input.claim.attemptKey),
              b("status", "=", "prepared"),
              b("lease_token", "=", input.claim.token),
              b("lease_generation", "=", input.claim.generation),
            ),
          set: { status: "exchanging", updated_at: now },
        }),
      );
      const claimed = yield* loadExchangeIntent(input.claim.attemptKey);
      if (
        !claimed ||
        String(claimed.status) !== "exchanging" ||
        claimed.lease_token !== input.claim.token ||
        Number(claimed.lease_generation ?? 0) !== input.claim.generation
      ) {
        return yield* new OAuthCompleteError({
          message: "OAuth exchange intent was reclaimed; provider outcome is serialized.",
          restartRequired: false,
        });
      }
      return claimed;
    });

  const markExchangeSucceeded = (input: {
    readonly claim: OAuthAttemptClaim;
    readonly accessTokenHash: string;
    readonly refreshTokenHash: string | null;
  }): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(input.claim);
      const now = new Date();
      yield* deps.fuma.use("oauth_exchange_intent.succeed", (db) =>
        looseDb(db).updateMany("oauth_exchange_intent", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", input.claim.attemptKey),
              b("status", "=", "exchanging"),
              b("lease_token", "=", input.claim.token),
              b("lease_generation", "=", input.claim.generation),
            ),
          set: {
            status: "succeeded",
            access_token_hash: input.accessTokenHash,
            refresh_token_hash: input.refreshTokenHash,
            completed_at: now,
            updated_at: now,
          },
        }),
      );
      const row = yield* loadExchangeIntent(input.claim.attemptKey);
      if (!row || String(row.status) !== "succeeded") {
        return yield* new StorageError({
          message: "OAuth exchange lifecycle commit was lost.",
          cause: undefined,
        });
      }
    });

  const rebindExchangeIntent = (
    claim: OAuthAttemptClaim,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(claim);
      yield* deps.fuma.use("oauth_exchange_intent.rebind", (db) =>
        looseDb(db).updateMany("oauth_exchange_intent", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", claim.attemptKey),
              b.or(b("status", "=", "exchanging"), b("status", "=", "succeeded")),
            ),
          set: {
            lease_token: claim.token,
            lease_generation: claim.generation,
            updated_at: new Date(),
          },
        }),
      );
      return yield* loadExchangeIntent(claim.attemptKey);
    });

  const rebindCredentialIntent = (
    claim: OAuthAttemptClaim,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(claim);
      yield* deps.fuma.use("oauth_credential_intent.rebind", (db) =>
        looseDb(db).updateMany("oauth_credential_intent", {
          where: (b: any) => b("attempt_key", "=", claim.attemptKey),
          set: {
            lease_token: claim.token,
            lease_generation: claim.generation,
            updated_at: new Date(),
          },
        }),
      );
      return yield* loadCredentialIntent(claim.attemptKey);
    });

  const rebindCredentialItems = (claim: OAuthAttemptClaim): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(claim);
      yield* deps.fuma.use("oauth_credential_item.rebind", (db) =>
        looseDb(db).updateMany("oauth_credential_item", {
          where: (b: any) => b("attempt_key", "=", claim.attemptKey),
          set: {
            lease_token: claim.token,
            lease_generation: claim.generation,
            updated_at: new Date(),
          },
        }),
      );
    });

  const decodeMissingScopes = (value: unknown): readonly string[] => {
    const decoded =
      typeof value === "string"
        ? decodeJsonPayload(value).pipe(Option.getOrElse(() => null))
        : value;
    return Array.isArray(decoded)
      ? decoded.filter((scope): scope is string => typeof scope === "string")
      : [];
  };

  type CredentialItemSpec = {
    readonly kind: "access" | "refresh";
    readonly itemId: string;
    readonly token: string;
    readonly tokenHash: string;
  };

  const loadCredentialItems = (
    attemptKey: string,
  ): Effect.Effect<readonly Record<string, unknown>[], StorageFailure> =>
    deps.fuma.use("oauth_credential_item.findMany", (db) =>
      looseDb(db).findMany("oauth_credential_item", {
        where: (b: any) => b("attempt_key", "=", attemptKey),
      }),
    );

  const ensureCredentialItems = (input: {
    readonly claim: OAuthAttemptClaim;
    readonly provider: CredentialProvider;
    readonly specs: readonly CredentialItemSpec[];
  }): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(input.claim);
      const now = new Date();
      for (const spec of input.specs) {
        const existing = yield* deps.fuma.use("oauth_credential_item.findFirst", (db) =>
          looseDb(db).findFirst("oauth_credential_item", {
            where: (b: any) =>
              b.and(b("attempt_key", "=", input.claim.attemptKey), b("item_kind", "=", spec.kind)),
          }),
        );
        if (!existing) {
          yield* deps.fuma
            .use("oauth_credential_item.create", (db) =>
              looseDb(db).create("oauth_credential_item", {
                tenant: deps.tenant,
                attempt_key: input.claim.attemptKey,
                item_kind: spec.kind,
                required: true,
                provider_key: String(input.provider.key),
                item_id: spec.itemId,
                token_hash: spec.tokenHash,
                status: "planned",
                lease_token: input.claim.token,
                lease_generation: input.claim.generation,
                created_at: now,
                updated_at: now,
                stored_at: null,
                compensated_at: null,
              }),
            )
            .pipe(Effect.catchTag("UniqueViolationError", () => Effect.void));
        }
        const row = yield* deps.fuma.use("oauth_credential_item.findFirst", (db) =>
          looseDb(db).findFirst("oauth_credential_item", {
            where: (b: any) =>
              b.and(b("attempt_key", "=", input.claim.attemptKey), b("item_kind", "=", spec.kind)),
          }),
        );
        if (
          !row ||
          String(row.item_id) !== spec.itemId ||
          String(row.token_hash) !== spec.tokenHash ||
          String(row.provider_key) !== String(input.provider.key)
        ) {
          return yield* new StorageError({
            message: "OAuth credential item intent does not match the reserved attempt.",
            cause: undefined,
          });
        }
      }
    });

  const writeCredentialItem = (input: {
    readonly claim: OAuthAttemptClaim;
    readonly provider: CredentialProvider;
    readonly spec: CredentialItemSpec;
  }): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(input.claim);
      const now = new Date();
      yield* deps.fuma.use("oauth_credential_item.claim", (db) =>
        looseDb(db).updateMany("oauth_credential_item", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", input.claim.attemptKey),
              b("item_kind", "=", input.spec.kind),
              b.or(
                b("status", "=", "planned"),
                b.and(
                  b("status", "=", "writing"),
                  b("lease_token", "=", input.claim.token),
                  b("lease_generation", "=", input.claim.generation),
                ),
              ),
            ),
          set: {
            status: "writing",
            lease_token: input.claim.token,
            lease_generation: input.claim.generation,
            updated_at: now,
          },
        }),
      );
      const current = yield* deps.fuma.use("oauth_credential_item.findFirst", (db) =>
        looseDb(db).findFirst("oauth_credential_item", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", input.claim.attemptKey),
              b("item_kind", "=", input.spec.kind),
            ),
        }),
      );
      if (!current || current.lease_token !== input.claim.token) {
        return yield* new StorageError({
          message: "OAuth credential item was reclaimed by another worker.",
          cause: undefined,
        });
      }
      const existing = yield* input.provider.get(ProviderItemId.make(input.spec.itemId));
      if (existing === null || (yield* sha256Hex(existing)) !== input.spec.tokenHash) {
        yield* assertAttemptClaim(input.claim);
        if (input.provider.set === undefined) {
          return yield* new StorageError({
            message: "OAuth credential provider is not writable.",
            cause: undefined,
          });
        }
        yield* input.provider.set(ProviderItemId.make(input.spec.itemId), input.spec.token);
      }
      yield* assertAttemptClaim(input.claim);
      yield* deps.fuma.use("oauth_credential_item.stored", (db) =>
        looseDb(db).updateMany("oauth_credential_item", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", input.claim.attemptKey),
              b("item_kind", "=", input.spec.kind),
              b("status", "=", "writing"),
              b("lease_token", "=", input.claim.token),
              b("lease_generation", "=", input.claim.generation),
            ),
          set: { status: "stored", stored_at: now, updated_at: now },
        }),
      );
    });

  const verifyStoredCredentialItems = (input: {
    readonly claim: OAuthAttemptClaim;
    readonly provider: CredentialProvider;
  }): Effect.Effect<"complete" | "compensatable" | "uncertain" | "missing", StorageFailure> =>
    Effect.gen(function* () {
      const rows = yield* loadCredentialItems(input.claim.attemptKey);
      if (rows.length === 0) return "missing" as const;
      let stored = 0;
      for (const row of rows) {
        const itemId = String(row.item_id ?? "");
        const tokenHash = String(row.token_hash ?? "");
        const value = yield* input.provider.get(ProviderItemId.make(itemId));
        if (String(row.status) === "stored" && value && (yield* sha256Hex(value)) === tokenHash) {
          stored += 1;
          continue;
        }
        if (value && (yield* sha256Hex(value)) === tokenHash) {
          stored += 1;
          continue;
        }
        if (String(row.status) === "writing" || String(row.status) === "stored") {
          // A `writing` row may still have an in-flight provider promise from
          // the prior process/fiber. Deleting another item here could let that
          // late write land after compensation and orphan a credential.
          return "uncertain" as const;
        }
      }
      if (stored === rows.length) return "complete";
      // A planned item alongside a stored item is still a partial external
      // effect. Recovery must compensate it instead of treating the exchange
      // as missing and risking an unauthorized re-exchange.
      return stored > 0 ? "compensatable" : "missing";
    });

  const compensateCredentialItems = (input: {
    readonly claim: OAuthAttemptClaim;
    readonly provider: CredentialProvider;
  }): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(input.claim);
      const rows = yield* loadCredentialItems(input.claim.attemptKey);
      if (rows.length === 0) return;
      if (!input.provider.delete) {
        return yield* new StorageError({
          message:
            "OAuth credential recovery found a partial provider write but the provider cannot compensate it.",
          cause: undefined,
        });
      }
      for (const row of rows) {
        const itemId = String(row.item_id ?? "");
        const tokenHash = String(row.token_hash ?? "");
        const value = yield* input.provider.get(ProviderItemId.make(itemId));
        if (value && (yield* sha256Hex(value)) === tokenHash) {
          yield* assertAttemptClaim(input.claim);
          yield* input.provider.delete(ProviderItemId.make(itemId));
        }
        yield* deps.fuma.use("oauth_credential_item.compensated", (db) =>
          looseDb(db).updateMany("oauth_credential_item", {
            where: (b: any) =>
              b.and(
                b("attempt_key", "=", input.claim.attemptKey),
                b("item_id", "=", itemId),
                b("lease_token", "=", input.claim.token),
                b("lease_generation", "=", input.claim.generation),
              ),
            set: {
              status: "compensated",
              compensated_at: new Date(),
              updated_at: new Date(),
            },
          }),
        );
      }
    });

  const persistCredentialIntent = (input: {
    readonly claim: OAuthAttemptClaim;
    readonly target: {
      readonly owner: Owner;
      readonly name: ConnectionName;
      readonly integration: IntegrationSlug;
      readonly template: AuthTemplateSlug;
      readonly identityLabel?: string | null;
    };
    readonly client: LoadedOAuthClient;
    readonly token: OAuth2TokenResponse;
    readonly requestedScopes: readonly string[];
    readonly clientOwner: Owner;
    readonly oauthTokenUrl: string | null;
  }): Effect.Effect<
    {
      readonly provider: CredentialProvider;
      readonly itemId: string;
      readonly refreshItemId: string | null;
      readonly oauthScope: string | null;
      readonly expiresAt: number | null;
      readonly missingOAuthScopes: readonly string[];
    },
    StorageFailure
  > =>
    Effect.gen(function* () {
      yield* assertAttemptClaim(input.claim);
      const provider = deps.defaultWritableProvider();
      if (!provider || !provider.set) {
        return yield* new StorageError({
          message:
            "No default writable credential provider is registered to store the OAuth access token.",
          cause: undefined,
        });
      }
      // A correlated connection gets an attempt-scoped item id.  This keeps a
      // reclaimed generation from overwriting a prior attempt's credential
      // while remaining deterministic for recovery and idempotent retries.
      const itemId = accessItemId(
        input.target.owner,
        input.target.integration,
        input.target.name,
        input.claim.attemptKey,
      );
      const refreshItemId = input.token.refresh_token ? refreshItemIdFor(itemId) : null;
      const oauthScope = recordedOAuthScope(input.token, input.requestedScopes);
      const missingOAuthScopes =
        input.client.grant === "authorization_code"
          ? missingGrantedOAuthScopes(input.requestedScopes, oauthScope)
          : [];
      const accessTokenHash = yield* sha256Hex(input.token.access_token);
      const refreshTokenHash = input.token.refresh_token
        ? yield* sha256Hex(input.token.refresh_token)
        : null;
      const now = new Date();
      const existing = yield* loadCredentialIntent(input.claim.attemptKey);
      if (!existing) {
        yield* deps.fuma.use("oauth_credential_intent.create", (db) =>
          looseDb(db).create("oauth_credential_intent", {
            tenant: deps.tenant,
            attempt_key: input.claim.attemptKey,
            owner: input.target.owner,
            integration: String(input.target.integration),
            name: String(input.target.name),
            template: String(input.target.template),
            provider_key: String(provider.key),
            item_id: itemId,
            refresh_item_id: refreshItemId,
            oauth_client: String(input.client.slug),
            oauth_client_owner: input.clientOwner,
            oauth_token_url: input.oauthTokenUrl,
            identity_label: input.target.identityLabel ?? null,
            expires_at: expiresAtFrom(input.token),
            oauth_scope: oauthScope,
            missing_oauth_scopes: missingOAuthScopes,
            access_token_hash: accessTokenHash,
            refresh_token_hash: refreshTokenHash,
            status: "pending",
            lease_token: input.claim.token,
            lease_generation: input.claim.generation,
            created_at: now,
            updated_at: now,
            stored_at: null,
            committed_at: null,
          }),
        );
      } else if (
        String(existing.item_id) !== itemId ||
        String(existing.refresh_item_id ?? "") !== String(refreshItemId ?? "") ||
        String(existing.access_token_hash) !== accessTokenHash ||
        String(existing.refresh_token_hash ?? "") !== String(refreshTokenHash ?? "") ||
        String(existing.provider_key) !== String(provider.key)
      ) {
        return yield* new StorageError({
          message: "OAuth credential intent does not match the reserved attempt.",
          cause: undefined,
        });
      }

      const specs: CredentialItemSpec[] = [
        { kind: "access", itemId, token: input.token.access_token, tokenHash: accessTokenHash },
      ];
      if (refreshItemId && input.token.refresh_token && refreshTokenHash) {
        specs.push({
          kind: "refresh",
          itemId: refreshItemId,
          token: input.token.refresh_token,
          tokenHash: refreshTokenHash,
        });
      }
      // Each external write has its own durable outbox row.  Never exchange a
      // code again because one item was partial: recovery reconciles or
      // compensates these rows instead.
      yield* ensureCredentialItems({ claim: input.claim, provider, specs });
      for (const spec of specs) {
        yield* writeCredentialItem({ claim: input.claim, provider, spec });
      }
      yield* assertAttemptClaim(input.claim);
      yield* deps.fuma.use("oauth_credential_intent.markStored", (db) =>
        looseDb(db).updateMany("oauth_credential_intent", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", input.claim.attemptKey),
              b("lease_token", "=", input.claim.token),
              b("lease_generation", "=", input.claim.generation),
            ),
          set: {
            status: "stored",
            lease_token: input.claim.token,
            lease_generation: input.claim.generation,
            stored_at: now,
            updated_at: now,
          },
        }),
      );
      return {
        provider,
        itemId,
        refreshItemId,
        oauthScope,
        expiresAt: expiresAtFrom(input.token),
        missingOAuthScopes,
      };
    });

  const markCredentialIntentCommitted = (
    claim: OAuthAttemptClaim,
    now: Date,
  ): Effect.Effect<void, StorageFailure> =>
    deps.fuma
      .use("oauth_credential_intent.markCommitted", (db) =>
        looseDb(db).updateMany("oauth_credential_intent", {
          where: (b: any) =>
            b.and(
              b("attempt_key", "=", claim.attemptKey),
              b("lease_token", "=", claim.token),
              b("lease_generation", "=", claim.generation),
            ),
          set: {
            status: "committed",
            lease_token: claim.token,
            lease_generation: claim.generation,
            committed_at: now,
            updated_at: now,
          },
        }),
      )
      .pipe(Effect.asVoid);

  const mintFromStoredIntent = (
    row: Record<string, unknown>,
  ): Effect.Effect<MintOAuthConnectionInput, StorageFailure> =>
    Effect.gen(function* () {
      const provider = deps.defaultWritableProvider();
      if (!provider) {
        return yield* new StorageError({
          message: "Credential provider for OAuth recovery is unavailable.",
          cause: undefined,
        });
      }
      if (String(row.provider_key ?? "") !== String(provider.key)) {
        return yield* new StorageError({
          message: "OAuth credential intent provider does not match the configured provider.",
          cause: undefined,
        });
      }
      const access = yield* provider.get(ProviderItemId.make(String(row.item_id)));
      if (!access || (yield* sha256Hex(access)) !== String(row.access_token_hash)) {
        return yield* new StorageError({
          message: "OAuth credential intent is not recoverable from the credential provider.",
          cause: undefined,
        });
      }
      const refreshItemId = row.refresh_item_id == null ? null : String(row.refresh_item_id);
      if (refreshItemId && row.refresh_token_hash) {
        const refresh = yield* provider.get(ProviderItemId.make(refreshItemId));
        if (!refresh || (yield* sha256Hex(refresh)) !== String(row.refresh_token_hash)) {
          return yield* new StorageError({
            message:
              "OAuth refresh credential intent is not recoverable from the credential provider.",
            cause: undefined,
          });
        }
      }
      return {
        owner: String(row.owner) as Owner,
        name: ConnectionName.make(String(row.name)),
        integration: IntegrationSlug.make(String(row.integration)),
        template: AuthTemplateSlug.make(String(row.template)),
        identityLabel: row.identity_label == null ? null : String(row.identity_label),
        provider: String(row.provider_key),
        itemId: String(row.item_id),
        oauthClient: OAuthClientSlug.make(String(row.oauth_client)),
        oauthClientOwner: String(row.oauth_client_owner) as Owner,
        refreshItemId,
        expiresAt: row.expires_at == null ? null : Number(row.expires_at),
        oauthScope: row.oauth_scope == null ? null : String(row.oauth_scope),
        missingOAuthScopes: decodeMissingScopes(row.missing_oauth_scopes),
        oauthTokenUrl: row.oauth_token_url == null ? null : String(row.oauth_token_url),
      };
    });

  const mintFromToken = (
    target: {
      readonly owner: Owner;
      readonly name: ConnectionName;
      readonly integration: IntegrationSlug;
      readonly template: AuthTemplateSlug;
      readonly identityLabel?: string | null;
    },
    client: LoadedOAuthClient,
    token: OAuth2TokenResponse,
    /** The scope set requested at /authorize + /token (the integration's
     *  declared or discovered scopes) — the recorded-scope fallback when the AS
     *  omits `scope`. */
    requestedScopes: readonly string[],
    /** The owner of `client` — persisted so refresh loads it by explicit owner. */
    clientOwner: Owner,
    /** Regional token endpoint override to persist when the code was redeemed
     *  off the client's configured host; null to use the client's token URL. */
    oauthTokenUrl: string | null,
  ): Effect.Effect<Connection, StorageFailure> =>
    Effect.gen(function* () {
      const provider = deps.defaultWritableProvider();
      if (!provider || !provider.set) {
        return yield* new StorageError({
          message:
            "No default writable credential provider is registered to store the OAuth access token.",
          cause: undefined,
        });
      }
      const itemId = accessItemId(target.owner, target.integration, target.name);
      yield* provider.set(ProviderItemId.make(itemId), token.access_token);

      let refreshItemId: string | null = null;
      if (token.refresh_token) {
        refreshItemId = refreshItemIdFor(itemId);
        yield* provider.set(ProviderItemId.make(refreshItemId), token.refresh_token);
      }

      const oauthScope = recordedOAuthScope(token, requestedScopes);
      return yield* deps.mintOAuthConnection({
        owner: target.owner,
        name: target.name,
        integration: target.integration,
        template: target.template,
        identityLabel: target.identityLabel ?? null,
        provider: String(provider.key),
        itemId,
        oauthClient: OAuthClientSlug.make(client.slug),
        oauthClientOwner: clientOwner,
        refreshItemId,
        expiresAt: expiresAtFrom(token),
        // Record the granted scope the AS echoed back. Some providers, including
        // Microsoft, issue a refresh token for `offline_access` but omit that
        // non-resource scope from the token `scope` string, so preserve it when
        // the refresh token proves it was granted.
        oauthScope,
        missingOAuthScopes:
          client.grant === "authorization_code"
            ? missingGrantedOAuthScopes(requestedScopes, oauthScope)
            : [],
        oauthTokenUrl,
      });
    });

  const deleteSession = (state: OAuthState): Effect.Effect<void, StorageFailure> =>
    deps.fuma
      .use("oauth_session.delete", (db) =>
        looseDb(db).deleteMany("oauth_session", {
          where: (b: any) => b("state", "=", String(state)),
        }),
      )
      .pipe(Effect.asVoid);

  // -----------------------------------------------------------------------
  // cancel — drop an in-flight session.
  // -----------------------------------------------------------------------
  const cancel = (state: OAuthState): Effect.Effect<void, StorageFailure> => deleteSession(state);

  // -----------------------------------------------------------------------
  // probe — RFC 8414 / OIDC discovery for onboarding pre-fill.
  // -----------------------------------------------------------------------
  const probe = (
    input: OAuthProbeInput,
  ): Effect.Effect<OAuthProbeResult, OAuthProbeError | StorageFailure> =>
    Effect.gen(function* () {
      const options = { endpointUrlPolicy: deps.endpointUrlPolicy };
      // Try protected-resource metadata first (RFC 9728), then the AS issuer.
      const resource = yield* discoverProtectedResourceMetadata(input.url, options).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      // EXPLICIT discovery order: when the protected-resource metadata advertises
      // an authorization server, probe that; otherwise probe the input endpoint
      // itself as a last resort. This is a documented probe order, not a silent
      // guess — a probe that finds no AS metadata fails loudly below.
      const issuerCandidate = resource?.metadata.authorization_servers?.[0] ?? input.url;
      const as = yield* discoverAuthorizationServerMetadata(issuerCandidate, options).pipe(
        Effect.mapError(
          (cause) =>
            new OAuthProbeError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message` field
              message: `OAuth discovery failed: ${sanitizeOAuthBoundaryText(cause.message)}`,
            }),
        ),
      );
      if (!as) {
        return yield* new OAuthProbeError({
          message: `No OAuth authorization-server metadata found at ${input.url}`,
        });
      }
      return {
        issuer: as.metadata.issuer,
        authorizationUrl: as.metadata.authorization_endpoint,
        tokenUrl: as.metadata.token_endpoint,
        resource: resource?.metadata.resource ?? null,
        // Prefer the resource's own RFC 9728 scopes (authoritative, even when
        // empty); fall back to the authorization server's list only when PRM is
        // silent. For a spec-compliant MCP server (one that publishes PRM) this
        // matches what `oauth.start` discovers. The AS fallback is a best-effort
        // hint for the registration form on servers that omit PRM — where
        // `oauth.start` requests none — so the two can differ for those.
        scopesSupported: resource?.metadata.scopes_supported ?? as.metadata.scopes_supported,
        registrationEndpoint: as.metadata.registration_endpoint ?? null,
        tokenEndpointAuthMethodsSupported: as.metadata.token_endpoint_auth_methods_supported,
        clientIdMetadataDocumentSupported:
          as.metadata.client_id_metadata_document_supported === true,
      } satisfies OAuthProbeResult;
    }).pipe(Effect.provide(httpClientLayer));

  return {
    createClient,
    removeClient,
    registerDynamicClient,
    listClients,
    start,
    complete,
    getCompletionReceipt,
    cancel,
    probe,
  };
};
