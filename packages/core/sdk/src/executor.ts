import { Cause, Effect, Inspectable, Layer, Option, Predicate, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { fumadb } from "@executor-js/fumadb";
import { memoryAdapter } from "@executor-js/fumadb/adapters/memory";
import { withQueryContext, type Condition, type ConditionBuilder } from "@executor-js/fumadb/query";
import { schema as fumaSchema, type RelationsMap } from "@executor-js/fumadb/schema";
import type { AnyColumn } from "@executor-js/fumadb/schema";
import {
  StorageError,
  isStorageFailure,
  makeFumaClient,
  type FumaDb,
  type FumaRow,
  type FumaTables,
  type StorageFailure,
} from "./fuma-runtime";
import { makeFumaBlobStore, pluginBlobStore, type BlobStore, type OwnerPartitions } from "./blob";
import { coreToolsPlugin } from "./core-tools";
import type {
  Connection,
  ConnectionInputOrigin,
  ConnectionRef,
  CreateConnectionInput,
  ConnectionValueInput,
  UpdateConnectionInput,
  ValidateConnectionInput,
} from "./connection";
import { HealthCheckResult, HealthCheckSpec } from "./health-check";
import type { HealthCheckCandidate } from "./health-check";
import {
  coreSchema,
  isToolPolicyAction,
  TOOL_INVOCATION_COLUMNS,
  type ConnectionRow,
  type CoreSchema,
  type IntegrationRow,
  type OAuthClientRow,
  type ToolInvocationRow,
  type ToolRow,
  type ToolPolicyRow,
} from "./core-schema";
import {
  ElicitationDeclinedError,
  ElicitationResponse,
  FormElicitation,
  type ElicitationHandler,
  type ElicitationRequest,
  type OnElicitation,
  type InvokeOptions,
} from "./elicitation";

export type { OnElicitation, InvokeOptions } from "./elicitation";
import {
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  IntegrationNotFoundError,
  InvalidConnectionInputError,
  IntegrationRemovalNotAllowedError,
  NoHandlerError,
  PluginNotLoadedError,
  ToolBlockedError,
  ToolInvocationError,
  ToolNotFoundError,
  type ExecuteError,
} from "./errors";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  NO_AUTH_TEMPLATE,
  OAuthClientSlug,
  Owner,
  PolicyId,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import type {
  AuthMethodDescriptor,
  Integration,
  IntegrationConfig,
  IntegrationDisplayDescriptor,
  RegisterIntegrationInput,
} from "./integration";
import {
  makeOAuthService,
  type MintOAuthConnectionInput,
  type OAuthScopePolicy,
} from "./oauth-service";
import type { OAuthService } from "./oauth-client";
import {
  comparePolicyRow,
  isValidPattern,
  matchPattern,
  positionForNewPattern,
  resolveEffectivePolicy,
  rowToToolPolicy,
  type CreateToolPolicyInput,
  type EffectivePolicy,
  type RemoveToolPolicyInput,
  type ToolPolicy,
  type UpdateToolPolicyInput,
} from "./policies";
import type { CredentialProvider, ProviderEntry } from "./provider";
import type {
  AnyPlugin,
  Elicit,
  IntegrationConfigureSchema,
  IntegrationPresetCatalogEntry,
  IntegrationRecord,
  OwnerBinding,
  PluginCtx,
  PluginExtensions,
  ResolveToolsResult,
  StaticIntegrationDecl,
  StaticToolDecl,
  StorageDeps,
  ToolPolicyProvider,
  ToolPolicyProviderRule,
  ToolInvocationCredential,
  PolicyAnnotationPluginCtx,
} from "./plugin";
import {
  pluginStorageId,
  type PluginStorageCollectionData,
  type PluginStorageCollectionDefinition,
  type PluginStorageCollectionQueryInput,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type PluginStorageRuntimeCollectionDefinition,
  type PluginStorageRuntimeIndexSpec,
} from "./plugin-storage";
import {
  assertExecutorOwnerPolicyTable,
  ORG_SUBJECT,
  type ExecutorOwnerPolicyContext,
} from "./owner-policy";
import { ToolSchemaView, type IntegrationDetectionResult } from "./types";
import { type Tool, type ToolAnnotations, type ToolDef, type ToolListFilter } from "./tool";
import { buildToolTypeScriptPreview } from "./schema-types";
import { collectReferencedDefinitions } from "./schema-refs";
import {
  refreshAccessToken,
  exchangeClientCredentials,
  shouldRefreshToken,
  type OAuthEndpointUrlPolicy,
} from "./oauth-helpers";
import { connectionIdentifier } from "./connection-name-identifier";
import {
  annotateToolResultOutcome,
  ToolProviderEvidenceSchema,
  type ToolProviderEvidence,
} from "./tool-result";
import {
  ExecuteOperationCarrier,
  ExecuteOperationApprovalDecision,
  ExecuteOperationFailureCode,
  OperationContractError,
  OperationDescriptorMismatchError,
  OperationRequestHashMismatchError,
  ExecuteOperationRequestCodec,
  ExecuteOperationResultCodec,
  canonicalizeOperationValue,
  deriveOperationDescriptor,
  hashExecuteOperationRequest,
  hashOperationValue,
  validateOperationSchema,
  type ExecuteOperationApproval,
  type ExecuteOperationApprovalContext,
  type ExecuteOperationApprovalHandler,
  type ExecuteOperationDefinition,
  type ExecuteOperationDescriptor,
  type ExecuteOperationError,
  type ExecuteOperationFailure,
  type ExecuteOperationRequest,
  type ExecuteOperationReplayStore,
  type ExecuteOperationResult,
  type ExecuteOperationStatus,
  type ExecuteOperationFailureCode as ExecuteOperationFailureCodeType,
  type ProviderReceipt,
} from "./operation";

const PLUGIN_STORAGE_DELETE_KEY_BATCH_SIZE = 90;
const PLUGIN_STORAGE_CREATE_ROW_BATCH_SIZE = 90;
const MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS = 4_000;
const isExecuteOperationCarrier = Schema.is(ExecuteOperationCarrier);
const isExecuteOperationApprovalDecision = Schema.is(ExecuteOperationApprovalDecision);
const isExecuteOperationFailureCode = Schema.is(ExecuteOperationFailureCode);

// ---------------------------------------------------------------------------
// Elicitation handler — resolved once at `createExecutor({ onElicitation })`
// and overridable per `execute`. A tool that requests user input mid-execution
// suspends the fiber and the handler decides how to respond. The "accept-all"
// sentinel auto-accepts (tests / non-interactive hosts).
// ---------------------------------------------------------------------------

const acceptAllHandler: ElicitationHandler = () =>
  Effect.succeed(ElicitationResponse.make({ action: "accept" }));

const resolveElicitationHandler = (onElicitation: OnElicitation): ElicitationHandler =>
  onElicitation === "accept-all" ? acceptAllHandler : onElicitation;

// ---------------------------------------------------------------------------
// Address scheme — `tools.<integration>.<owner>.<connection>.<tool>`.
// ---------------------------------------------------------------------------

const ADDRESS_PREFIX = "tools";

export interface ParsedToolAddress {
  readonly integration: IntegrationSlug;
  readonly owner: Owner;
  readonly connection: ConnectionName;
  readonly tool: ToolName;
}

const isOwner = (value: string): value is Owner => value === "org" || value === "user";

/** Parse a callable address; null when it's not a well-formed
 *  `tools.<integration>.<owner>.<connection>.<tool>`.
 *
 *  The four leading segments (prefix, integration, owner, connection) are
 *  slug-like and never contain a `.`; the `<tool>` segment is the *entire*
 *  remainder after the 4th dot, so it may itself contain dots. That lets a tool
 *  whose name is a structured `group.leaf` path (e.g. an OpenAPI
 *  `aliases.deleteAlias`) address naturally as
 *  `tools.<integration>.<owner>.<connection>.aliases.deleteAlias` — the same
 *  dotted nesting the sandbox `tools` proxy produces from property access. */
export const parseToolAddress = (address: string): ParsedToolAddress | null => {
  // Walk to the 4th dot; everything past it is the tool (dots and all).
  let cut = -1;
  for (let i = 0; i < 4; i++) {
    cut = address.indexOf(".", cut + 1);
    if (cut === -1) return null;
  }
  const [prefix, integration, owner, connection] = address.slice(0, cut).split(".") as [
    string,
    string,
    string,
    string,
  ];
  const tool = address.slice(cut + 1);
  if (prefix !== ADDRESS_PREFIX) return null;
  if (!isOwner(owner)) return null;
  if (integration.length === 0 || connection.length === 0 || tool.length === 0) {
    return null;
  }
  return {
    integration: IntegrationSlug.make(integration),
    owner,
    connection: ConnectionName.make(connection),
    tool: ToolName.make(tool),
  };
};

export const connectionAddress = (
  owner: Owner,
  integration: IntegrationSlug,
  connection: ConnectionName,
): ConnectionAddress =>
  ConnectionAddress.make(`${ADDRESS_PREFIX}.${integration}.${owner}.${connection}`);

export const toolAddress = (
  owner: Owner,
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName,
): ToolAddress =>
  ToolAddress.make(`${ADDRESS_PREFIX}.${integration}.${owner}.${connection}.${tool}`);

// ---------------------------------------------------------------------------
// Owner key helpers — every owned-row write stamps `tenant`, `owner`,
// `subject` (org → subject="").
// ---------------------------------------------------------------------------

interface OwnedKeys {
  readonly tenant: string;
  readonly owner: Owner;
  readonly subject: string;
}

// ---------------------------------------------------------------------------
// Executor — public surface. Every list/execute/schema call is a direct
// core-table query unioned with the in-memory static pool.
// ---------------------------------------------------------------------------

export type Executor<TPlugins extends readonly AnyPlugin[] = readonly []> = {
  readonly integrations: {
    readonly list: () => Effect.Effect<readonly Integration[], StorageFailure>;
    readonly get: (slug: IntegrationSlug) => Effect.Effect<Integration | null, StorageFailure>;
    readonly update: (
      slug: IntegrationSlug,
      patch: { readonly name?: string; readonly description?: string },
    ) => Effect.Effect<void, IntegrationNotFoundError | StorageFailure>;
    readonly remove: (
      slug: IntegrationSlug,
    ) => Effect.Effect<void, IntegrationRemovalNotAllowedError | StorageFailure>;
    readonly detect: (
      url: string,
    ) => Effect.Effect<readonly IntegrationDetectionResult[], StorageFailure>;
    /** The integration's declared health check: which authenticated operation a
     *  connection runs to prove its credential is alive and surface whose
     *  account it is. Configured by the user the same way auth methods are. */
    readonly healthCheck: {
      /** The currently declared check, or null when none is configured (or the
       *  owning plugin has no health-check capability). */
      readonly get: (
        slug: IntegrationSlug,
      ) => Effect.Effect<HealthCheckSpec | null, StorageFailure>;
      /** The operations a user can pick from, ranked non-destructive-first then
       *  fewest required arguments. Empty when the plugin has no candidates. */
      readonly candidates: (
        slug: IntegrationSlug,
      ) => Effect.Effect<
        readonly HealthCheckCandidate[],
        IntegrationNotFoundError | StorageFailure
      >;
      /** Declare (or clear, with `null`) the health check for the integration. */
      readonly set: (
        slug: IntegrationSlug,
        spec: HealthCheckSpec | null,
      ) => Effect.Effect<void, IntegrationNotFoundError | StorageFailure>;
    };
  };

  readonly connections: {
    readonly create: (
      input: CreateConnectionInput,
    ) => Effect.Effect<
      Connection,
      | IntegrationNotFoundError
      | CredentialProviderNotRegisteredError
      | InvalidConnectionInputError
      | StorageFailure
    >;
    readonly list: (filter?: {
      readonly integration?: IntegrationSlug;
      readonly owner?: Owner;
    }) => Effect.Effect<readonly Connection[], StorageFailure>;
    readonly get: (ref: ConnectionRef) => Effect.Effect<Connection | null, StorageFailure>;
    /** Edit user-curated metadata (description, identityLabel). Credentials and
     *  OAuth lifecycle fields are not editable here. */
    readonly update: (
      ref: ConnectionRef,
      input: UpdateConnectionInput,
    ) => Effect.Effect<Connection, ConnectionNotFoundError | StorageFailure>;
    readonly remove: (
      ref: ConnectionRef,
    ) => Effect.Effect<void, ConnectionNotFoundError | StorageFailure>;
    readonly refresh: (
      ref: ConnectionRef,
    ) => Effect.Effect<
      readonly Tool[],
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    >;
    /** Run the integration's declared health check against a saved connection:
     *  classify the credential (healthy / expired / degraded / unknown) and
     *  extract its identity for display. Never throws on an auth wall or upstream
     *  error: those come back as a `HealthCheckResult` with the matching status. */
    readonly checkHealth: (
      ref: ConnectionRef,
      options?: {
        /** Return the persisted verdict when younger than this; probe
         *  otherwise. Omit to always probe. */
        readonly ifStaleMs?: number;
      },
    ) => Effect.Effect<
      HealthCheckResult,
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    >;
    /** Validate an in-flight credential WITHOUT saving it (key-first connect):
     *  resolve the pasted value(s), run the health check, and return the result
     *  so the caller can confirm the key works and derive a name from the
     *  identity before creating the connection. */
    readonly validate: (
      input: ValidateConnectionInput,
    ) => Effect.Effect<HealthCheckResult, IntegrationNotFoundError | StorageFailure>;
  };

  /** Shared OAuth service. Hosts use this through the core HTTP OAuth group;
   *  plugins see the same service as `ctx.oauth`. */
  readonly oauth: OAuthService;

  readonly tools: {
    readonly list: (filter?: ToolListFilter) => Effect.Effect<readonly Tool[], StorageFailure>;
    readonly schema: (address: ToolAddress) => Effect.Effect<ToolSchemaView | null, StorageFailure>;
  };

  readonly providers: {
    readonly list: () => Effect.Effect<readonly ProviderKey[]>;
    readonly items: (key: ProviderKey) => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
  };

  readonly policies: {
    readonly list: () => Effect.Effect<readonly ToolPolicy[], StorageFailure>;
    readonly create: (input: CreateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly update: (input: UpdateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly remove: (input: RemoveToolPolicyInput) => Effect.Effect<void, StorageFailure>;
    readonly resolve: (address: ToolAddress) => Effect.Effect<EffectivePolicy, StorageFailure>;
  };

  readonly execute: (
    address: ToolAddress,
    args: unknown,
    options?: InvokeOptions,
  ) => Effect.Effect<unknown, ExecuteError>;

  /** True only when reviewed operation definitions and a replay ledger were
   * configured at startup. Hosts must omit operation routes/tools otherwise. */
  readonly operationExecutionAvailable: boolean;

  /** Execute a reviewed operation by registry key. The carrier is supplied by
   * a trusted adapter, never accepted as caller input. */
  readonly executeOperation: (
    request: ExecuteOperationRequest,
    carrier: ExecuteOperationCarrier,
  ) => Effect.Effect<ExecuteOperationResult, ExecuteOperationError | ExecuteError | StorageFailure>;

  readonly close: () => Effect.Effect<void, StorageFailure>;
} & PluginExtensions<TPlugins>;

export interface ExecutorDb {
  readonly db: FumaDb<any>;
  readonly close?: () => Effect.Effect<void, StorageFailure> | Promise<void> | void;
}

export type ExecutorDbInput = FumaDb<any> | ExecutorDb;

export type ExecutorDbFactory = (config: {
  readonly tables: FumaTables;
}) => ExecutorDbInput | Effect.Effect<ExecutorDbInput, StorageFailure>;

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = readonly []> {
  /** The org / workspace this executor is bound to. `owner: "org"` rows file
   *  here. */
  readonly tenant: Tenant;
  /** The acting member, or omit for a pure-org executor (no `owner:"user"`). */
  readonly subject?: Subject;
  readonly db?: ExecutorDbInput | ExecutorDbFactory;
  /**
   * Backend for the plugin blob seam (`StorageDeps.blobs`). Defaults to the
   * FumaDB `blob` table over `db`. Hosts with an object store hand one in
   * (e.g. the R2 store in `@executor-js/cloudflare/blob-store`) so multi-MB
   * values stay out of the relational tier.
   */
  readonly blobs?: BlobStore;
  readonly plugins?: TPlugins;
  /** Config-level credential providers, merged with every
   *  `plugin.credentialProviders`. Config providers register first, so the
   *  default (first writable) store is selected from them when present. */
  readonly providers?: readonly CredentialProvider[];
  /**
   * How to respond when a tool requests user input mid-invocation. Pass
   * `"accept-all"` for tests / non-interactive hosts, or a handler.
   */
  readonly onElicitation: OnElicitation;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  /**
   * Fetch API implementation for dependencies that cannot consume `httpClientLayer`.
   * Prefer `httpClientLayer` for normal SDK and plugin HTTP.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The OAuth callback URL (`${webBaseUrl}/oauth/callback`) the host serves and
   * sends to providers. There is NO localhost default: omit it (or pass
   * undefined) only for executors that never run interactive OAuth — the
   * redirect-requiring flows then fail loudly instead of guessing a callback.
   * Hosts serving OAuth derive this from the request origin / web base URL.
   */
  readonly redirectUri?: string;
  /** Optional URL selected organization slug to carry inside OAuth `state`. */
  readonly oauthCallbackStateOrgSlug?: string;
  readonly oauthEndpointUrlPolicy?: OAuthEndpointUrlPolicy;
  /**
   * Enable the built-in `core-tools` plugin which contributes agent-facing
   * static tools over the v2 surface (integrations / connections / policies).
   */
  readonly coreTools?: {
    readonly webBaseUrl?: string;
    readonly orgSlug?: string;
    readonly includeProviders?: boolean;
  };
  /** Host-owned, versioned operation registry. Callers select only an
   * operation key/version; target, provider transport, and schemas come from
   * these reviewed definitions. */
  readonly operations?: readonly ExecuteOperationDefinition[];
  /**
   * Host-owned replay/reservation ledger for carrier-neutral operations. It is
   * required whenever an operation registry is configured; the executor
   * refuses to start without it and never falls back to a process-local
   * ledger. Tests and explicitly local-only callers may use the exported
   * in-memory helper.
   */
  readonly operationReplayStore?: ExecuteOperationReplayStore<StorageFailure>;
  /**
   * Test/local-only escape hatch for the exported in-memory replay helper.
   * Cloud/server hosts must leave this unset and inject a durable store.
   */
  readonly allowProcessLocalOperationReplayStore?: boolean;
  /**
   * Explicit approval/grant adapter for operations whose resolved policy is
   * `require_approval`. It receives the complete execution binding and must
   * return a persisted grant decision; generic `onElicitation` is never used
   * as an implicit operation approval.
   */
  readonly operationApproval?: ExecuteOperationApprovalHandler;
  /**
   * How long a connection's persisted tool catalog stays fresh when its plugin
   * lists a live remote catalog (`plugin.remoteToolCatalog`, e.g. MCP servers,
   * whose tool sets change server-side with no executor-visible signal). Once
   * older than this, the catalog is re-listed on the next tools read. Defaults
   * to 15 minutes; pass `null` to disable time-based re-sync (stale-mark and
   * config-revision re-sync still apply).
   */
  readonly toolsSyncTtlMs?: number | null;
}

/** Default freshness window for remote-catalog connections (see
 *  `ExecutorConfig.toolsSyncTtlMs`). */
export const DEFAULT_TOOLS_SYNC_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// collectTables — return the executor-owned Fuma table set. Plugins persist
// through host-owned facades (`pluginStorage`, `blobs`) instead of contributing
// table definitions, so the schema is fixed and plugin-independent.
// ---------------------------------------------------------------------------

export const collectTables = (): FumaTables => {
  validateExecutorOwnerPolicyTables(coreSchema);
  return { ...coreSchema };
};

const validateExecutorOwnerPolicyTables = (tables: FumaTables): void => {
  for (const [tableKey, tableDef] of Object.entries(tables)) {
    assertExecutorOwnerPolicyTable(tableDef, tableKey);
  }
};

const validateExecutorDbTables = (required: FumaTables, actual: FumaTables): void => {
  const missing = Object.keys(required)
    .filter((tableName) => !actual[tableName])
    .sort();
  if (missing.length === 0) return;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous startup validation before Executor services are built
  throw new StorageError({
    message: `Executor database is missing required table definitions: ${missing.join(", ")}`,
    cause: {
      missing,
      available: Object.keys(actual).sort(),
    },
  });
};

const storageFailureFromUnknown = (message: string, cause: unknown): StorageFailure =>
  isStorageFailure(cause) ? cause : new StorageError({ message, cause });

const pluginStorageFailure = (pluginId: string, hook: string, cause: unknown): StorageFailure =>
  storageFailureFromUnknown(`${hook} failed for plugin ${pluginId}`, cause);

const createDefaultMemoryDb = (tables: FumaTables): ExecutorDb => {
  const version = "1.0.0";
  const latestSchema = fumaSchema<string, FumaTables, RelationsMap<FumaTables>>({
    version,
    tables,
  });
  const factory = fumadb({
    namespace: "executor_memory",
    schemas: [latestSchema],
  });

  // oxlint-disable-next-line executor/no-double-cast -- boundary: fumadb's generic ORM client type doesn't structurally match the FumaDb facade
  const db = factory.client(memoryAdapter()).orm(version) as unknown as FumaDb;
  return { db };
};

// ---------------------------------------------------------------------------
// JSON helpers + row → public projection conversions
// ---------------------------------------------------------------------------

const decodeJsonFromString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const decodeJsonColumn = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  return decodeJsonFromString(value).pipe(Option.getOrElse(() => value));
};

const rowToIntegration = (
  row: IntegrationRow,
  authMethods: readonly AuthMethodDescriptor[] = [],
  display?: IntegrationDisplayDescriptor,
): Integration => ({
  slug: IntegrationSlug.make(row.slug),
  // Pre-split rows have no `name`; their description WAS the display name.
  name: row.name ?? row.description ?? row.slug,
  // `description` is now nullable (cleared where it only held a duplicated
  // title); present it as "" so the public Integration type stays a string.
  description: row.description ?? "",
  kind: row.plugin_id,
  canRemove: Boolean(row.can_remove),
  canRefresh: Boolean(row.can_refresh),
  authMethods,
  ...(display?.url ? { displayUrl: display.url } : {}),
  ...(display?.family ? { family: display.family } : {}),
});

const rowToIntegrationRecord = (
  row: IntegrationRow,
  authMethods: readonly AuthMethodDescriptor[] = [],
): IntegrationRecord => ({
  ...rowToIntegration(row, authMethods),
  config: decodeJsonColumn(row.config),
});

const decodeLastHealth = Schema.decodeUnknownOption(HealthCheckResult);
const decodeHealthCheckSpec = Schema.decodeUnknownOption(HealthCheckSpec);

const missingOAuthScopesFromProviderState = (value: unknown): readonly string[] => {
  const decoded = decodeJsonColumn(value);
  if (decoded == null || typeof decoded !== "object" || Array.isArray(decoded)) return [];
  const scopes = (decoded as Record<string, unknown>).missingOAuthScopes;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
};

const rowToConnection = (row: ConnectionRow): Connection => {
  const owner = row.owner as Owner;
  const integration = IntegrationSlug.make(row.integration);
  const name = ConnectionName.make(row.name);
  return {
    owner,
    name,
    integration,
    template: AuthTemplateSlug.make(row.template),
    provider: ProviderKey.make(row.provider),
    address: connectionAddress(owner, integration, name),
    identityLabel: row.identity_label ?? null,
    description: row.description ?? null,
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    oauthClient: row.oauth_client == null ? null : OAuthClientSlug.make(String(row.oauth_client)),
    oauthClientOwner:
      row.oauth_client_owner == null ? null : (String(row.oauth_client_owner) as Owner),
    oauthScope: row.oauth_scope == null ? null : String(row.oauth_scope),
    missingOAuthScopes: missingOAuthScopesFromProviderState(row.provider_state),
    lastHealth: Option.getOrNull(decodeLastHealth(row.last_health)),
  };
};

/** Parse a connection row's `oauth_scope` (space-delimited, as echoed by the
 *  token endpoint) into the credential's `grantedScopes`. Undefined when the
 *  row carries none, so scope comparisons downstream fail open. */
const grantedScopesFromRow = (row: {
  readonly oauth_scope?: unknown;
}): readonly string[] | undefined => {
  if (row.oauth_scope == null) return undefined;
  const scopes = String(row.oauth_scope).split(/\s+/).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
};

/** The canonical credential variable for a single-secret connection. OAuth tokens
 *  and the primary apiKey value resolve through it. */
const PRIMARY_INPUT_VARIABLE = "token";

interface NormalizedConnectionInput {
  readonly variable: string;
  readonly origin: ConnectionInputOrigin;
}

/** Flatten any `ConnectionValueInput` form (single `value`/`from` sugar, pasted
 *  `values` map, or the canonical per-variable `inputs` map) into a uniform list
 *  of named origins. */
const normalizeConnectionInputs = (
  input: ConnectionValueInput,
): readonly NormalizedConnectionInput[] => {
  if ("inputs" in input) {
    return Object.entries(input.inputs).map(([variable, origin]) => ({ variable, origin }));
  }
  if ("values" in input) {
    return Object.entries(input.values).map(([variable, value]) => ({
      variable,
      origin: { value },
    }));
  }
  if ("from" in input) {
    return [{ variable: PRIMARY_INPUT_VARIABLE, origin: { from: input.from } }];
  }
  return [{ variable: PRIMARY_INPUT_VARIABLE, origin: { value: input.value } }];
};

/** Decode a connection row's `item_ids` JSON map (`variable → provider item id`).
 *  Tolerates the historically-single shape by returning `{}` for anything that
 *  isn't an object. */
const connectionItemIds = (row: ConnectionRow): Record<string, string> => {
  const decoded = decodeJsonColumn(row.item_ids);
  if (decoded == null || typeof decoded !== "object") return {};
  return decoded as Record<string, string>;
};

// Accepts a projected row (the invoke/list paths select away the heavy
// schema columns); `Tool.inputSchema`/`outputSchema` are optional and stay
// absent for those callers — `tools.schema` is the schema-bearing surface.
const rowToTool = (
  row: ToolInvocationRow & Partial<Pick<ToolRow, "input_schema" | "output_schema">>,
  annotations?: ToolAnnotations,
): Tool => {
  const owner = row.owner as Owner;
  const integration = IntegrationSlug.make(row.integration);
  const connection = ConnectionName.make(row.connection);
  const name = ToolName.make(row.name);
  return {
    address: toolAddress(owner, integration, connection, name),
    owner,
    integration,
    connection,
    name,
    pluginId: row.plugin_id,
    description: row.description,
    inputSchema: decodeJsonColumn(row.input_schema),
    outputSchema: decodeJsonColumn(row.output_schema),
    annotations: annotations ?? (decodeJsonColumn(row.annotations) as ToolAnnotations | undefined),
  };
};

// ---------------------------------------------------------------------------
// Condition builders
// ---------------------------------------------------------------------------

type AnyCb = ConditionBuilder<Record<string, AnyColumn>>;
type CoreTableName = keyof CoreSchema & string;
type CoreRow<TName extends CoreTableName> = FumaRow<CoreSchema[TName]>;
type CoreColumn<TName extends CoreTableName> = keyof CoreRow<TName> & string;
type CoreWhere = (b: AnyCb) => Condition | boolean;
type CoreFindManyOptions<TName extends CoreTableName = CoreTableName> = {
  readonly where?: CoreWhere;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?:
    | readonly [string, "asc" | "desc"]
    | readonly (readonly [string, "asc" | "desc"])[];
  /** Column projection (fumadb `select`). Omit for all columns. Use on hot
   *  paths whose rows carry heavy JSON columns the caller discards — e.g. a
   *  tool row is ~KBs of schemas but invoke routing needs only the names. */
  readonly select?: readonly CoreColumn<TName>[];
};
type CoreFindFirstOptions<TName extends CoreTableName = CoreTableName> = Omit<
  CoreFindManyOptions<TName>,
  "limit" | "offset"
>;
/** The narrowed row a projected query returns: the selected columns keep
 *  their types, everything else is absent. */
type CoreProjectedRow<TName extends CoreTableName, TSelect> = TSelect extends readonly (infer K)[]
  ? Pick<CoreRow<TName>, Extract<K, keyof CoreRow<TName>>>
  : CoreRow<TName>;

type LooseStorageDb = {
  readonly count: (tableName: string, options?: unknown) => Promise<number>;
  readonly create: (
    tableName: string,
    row: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly createMany: (
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ) => Promise<readonly unknown[]>;
  readonly deleteMany: (tableName: string, options?: unknown) => Promise<void>;
  readonly findFirst: (
    tableName: string,
    options?: unknown,
  ) => Promise<Record<string, unknown> | null>;
  readonly findMany: (
    tableName: string,
    options?: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly updateMany: (tableName: string, options: unknown) => Promise<void>;
};

const asLooseStorageDb = (db: unknown): LooseStorageDb => db as LooseStorageDb;

const makeCoreDb = (fuma: ReturnType<typeof makeFumaClient>) => ({
  count: <TName extends CoreTableName>(
    tableName: TName,
    options?: { readonly where?: CoreWhere },
  ): Effect.Effect<number, StorageFailure> =>
    fuma.use(`${tableName}.count`, (db) => asLooseStorageDb(db).count(tableName, options)),
  create: <TName extends CoreTableName>(
    tableName: TName,
    row: Record<string, unknown>,
  ): Effect.Effect<CoreRow<TName>, StorageFailure> =>
    fuma.use(`${tableName}.create`, (db) =>
      asLooseStorageDb(db).create(tableName, row),
    ) as Effect.Effect<CoreRow<TName>, StorageFailure>,
  createMany: <TName extends CoreTableName>(
    tableName: TName,
    rows: readonly Record<string, unknown>[],
  ): Effect.Effect<void, StorageFailure> =>
    rows.length === 0
      ? Effect.void
      : fuma
          .use(`${tableName}.createMany`, (db) => asLooseStorageDb(db).createMany(tableName, rows))
          .pipe(Effect.asVoid),
  deleteMany: <TName extends CoreTableName>(
    tableName: TName,
    options: { readonly where?: CoreWhere } = {},
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.deleteMany`, (db) =>
      asLooseStorageDb(db).deleteMany(tableName, options),
    ),
  findFirst: <TName extends CoreTableName, const TOptions extends CoreFindFirstOptions<TName>>(
    tableName: TName,
    options: TOptions,
  ): Effect.Effect<CoreProjectedRow<TName, TOptions["select"]> | null, StorageFailure> =>
    fuma.use(`${tableName}.findFirst`, (db) =>
      asLooseStorageDb(db).findFirst(tableName, options),
    ) as Effect.Effect<CoreProjectedRow<TName, TOptions["select"]> | null, StorageFailure>,
  findMany: <TName extends CoreTableName, const TOptions extends CoreFindManyOptions<TName>>(
    tableName: TName,
    options: TOptions = {} as TOptions,
  ): Effect.Effect<readonly CoreProjectedRow<TName, TOptions["select"]>[], StorageFailure> =>
    fuma.use(`${tableName}.findMany`, (db) =>
      asLooseStorageDb(db).findMany(tableName, options),
    ) as Effect.Effect<readonly CoreProjectedRow<TName, TOptions["select"]>[], StorageFailure>,
  updateMany: <TName extends CoreTableName>(
    tableName: TName,
    options: {
      readonly where?: CoreWhere;
      readonly set: Record<string, unknown>;
    },
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.updateMany`, (db) =>
      asLooseStorageDb(db).updateMany(tableName, options),
    ),
});

type CoreDb = ReturnType<typeof makeCoreDb>;

// ---------------------------------------------------------------------------
// Plugin storage facade — owner-scoped (was scope-keyed). Reads fall through
// [user, org]; writes/deletes name an explicit owner.
// ---------------------------------------------------------------------------

const pluginStorageEntryFromRow = <T>(row: CoreRow<"plugin_storage">): PluginStorageEntry<T> => ({
  id: pluginStorageId({
    pluginId: row.plugin_id,
    collection: row.collection,
    key: row.key,
  }),
  owner: row.owner as Owner,
  pluginId: row.plugin_id,
  collection: row.collection,
  key: row.key,
  data: row.data as T,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
});

const pluginStorageIndexSpecFields = (spec: PluginStorageRuntimeIndexSpec): readonly string[] =>
  typeof spec === "string" ? [spec] : spec;

const pluginStorageCollectionIndexedFields = (
  definition: PluginStorageRuntimeCollectionDefinition,
): ReadonlySet<string> =>
  new Set(definition.indexes.flatMap((spec) => pluginStorageIndexSpecFields(spec)));

const pluginStorageQueryValidationError = (
  definition: PluginStorageRuntimeCollectionDefinition,
  query: PluginStorageCollectionQueryInput<PluginStorageCollectionDefinition> | undefined,
): StorageError | null => {
  if (!query) return null;
  const indexedFields = pluginStorageCollectionIndexedFields(definition);
  const fields = new Set<string>([
    ...Object.keys(query.where ?? {}),
    ...(query.orderBy ?? []).map((order) => order.field),
  ]);
  for (const field of fields) {
    if (!indexedFields.has(field)) {
      return new StorageError({
        message: `Plugin storage collection "${definition.name}" cannot query field "${field}" because it is not declared as an index`,
        cause: undefined,
      });
    }
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
    return new StorageError({
      message: `Plugin storage collection "${definition.name}" received an invalid query limit`,
      cause: undefined,
    });
  }
  if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0)) {
    return new StorageError({
      message: `Plugin storage collection "${definition.name}" received an invalid query offset`,
      cause: undefined,
    });
  }
  return null;
};

const isPluginStorageRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const pluginStorageWhereOperators = ["eq", "in", "gt", "gte", "lt", "lte"] as const;

const isPluginStorageWhereFilter = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isPluginStorageRecord(value) && pluginStorageWhereOperators.some((operator) => operator in value);

const pluginStorageComparableValue = (value: unknown): string | number | boolean | null => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (value == null) return null;
  return JSON.stringify(value);
};

const comparePluginStorageValues = (left: unknown, right: unknown): number => {
  const leftValue = pluginStorageComparableValue(left);
  const rightValue = pluginStorageComparableValue(right);
  if (leftValue === rightValue) return 0;
  if (leftValue === null) return -1;
  if (rightValue === null) return 1;
  return leftValue < rightValue ? -1 : 1;
};

const pluginStorageDataField = (data: unknown, field: string): unknown =>
  isPluginStorageRecord(data) ? data[field] : undefined;

const matchesWhereOperator = (operator: string, value: unknown, operand: unknown): boolean => {
  if (operator === "eq") return comparePluginStorageValues(value, operand) === 0;
  if (operator === "in") {
    return (
      Array.isArray(operand) &&
      operand.some((item) => comparePluginStorageValues(value, item) === 0)
    );
  }
  if (operator === "gt") return comparePluginStorageValues(value, operand) > 0;
  if (operator === "gte") return comparePluginStorageValues(value, operand) >= 0;
  if (operator === "lt") return comparePluginStorageValues(value, operand) < 0;
  if (operator === "lte") return comparePluginStorageValues(value, operand) <= 0;
  return false;
};

const matchesWhereOperators = (
  value: unknown,
  filter: Readonly<Record<string, unknown>>,
): boolean => {
  for (const [operator, operand] of Object.entries(filter)) {
    if (!matchesWhereOperator(operator, value, operand)) return false;
  }
  return true;
};

const rowMatchesPluginStorageWhere = (
  row: CoreRow<"plugin_storage">,
  where: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (!where) return true;
  for (const [field, condition] of Object.entries(where)) {
    const value = pluginStorageDataField(row.data, field);
    if (isPluginStorageWhereFilter(condition)) {
      if (!matchesWhereOperators(value, condition)) return false;
    } else if (comparePluginStorageValues(value, condition) !== 0) {
      return false;
    }
  }
  return true;
};

const makePluginStorageFacade = (input: {
  readonly core: CoreDb;
  readonly pluginId: string;
  readonly owner: OwnerBinding;
}): PluginStorageFacade => {
  // Owner partitions: org always, plus this subject's user partition.
  const readOwners: readonly Owner[] = input.owner.subject == null ? ["org"] : ["user", "org"];

  const ownerSubject = (owner: Owner): { owner: Owner; subject: string } | null => {
    if (owner === "org") return { owner: "org", subject: ORG_SUBJECT };
    if (input.owner.subject == null) return null;
    return { owner: "user", subject: String(input.owner.subject) };
  };

  const tenant = String(input.owner.tenant);

  const whereFor =
    (collection: string, key?: string): CoreWhere =>
    (b: AnyCb) =>
      b.and(
        b("plugin_id", "=", input.pluginId),
        b("collection", "=", collection),
        key === undefined ? true : b("key", "=", key),
      );

  const whereOwner = (owner: Owner, collection: string, key: string): CoreWhere => {
    const os = ownerSubject(owner);
    return (b: AnyCb) =>
      b.and(
        b("plugin_id", "=", input.pluginId),
        b("collection", "=", collection),
        b("key", "=", key),
        b("owner", "=", owner),
        b("subject", "=", os ? os.subject : ORG_SUBJECT),
      );
  };

  const ownerRank = (owner: Owner): number => readOwners.indexOf(owner);

  const sortByOwnerPrecedence = (rows: readonly CoreRow<"plugin_storage">[]) =>
    [...rows].sort((left, right) => {
      const l = ownerRank(left.owner as Owner);
      const r = ownerRank(right.owner as Owner);
      return l - r || left.key.localeCompare(right.key);
    });

  const getVisible = <T>(collection: string, key: string) =>
    input.core.findMany("plugin_storage", { where: whereFor(collection, key) }).pipe(
      Effect.map((rows) => sortByOwnerPrecedence(rows)[0] ?? null),
      Effect.map((row) => (row ? pluginStorageEntryFromRow<T>(row) : null)),
    );

  const getForOwnerImpl = <T>(owner: Owner, collection: string, key: string) =>
    input.core
      .findFirst("plugin_storage", {
        where: whereOwner(owner, collection, key),
      })
      .pipe(Effect.map((row) => (row ? pluginStorageEntryFromRow<T>(row) : null)));

  const putImpl = <T>(owner: Owner, collection: string, key: string, data: unknown) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot write plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      const existing = yield* input.core.findFirst("plugin_storage", {
        where: whereOwner(owner, collection, key),
      });
      const now = new Date();
      if (existing) {
        yield* input.core.updateMany("plugin_storage", {
          where: whereOwner(owner, collection, key),
          set: { data, updated_at: now },
        });
        return pluginStorageEntryFromRow<T>({
          ...existing,
          data,
          updated_at: now,
        });
      }
      const created = yield* input.core.create("plugin_storage", {
        tenant,
        owner: os.owner,
        subject: os.subject,
        plugin_id: input.pluginId,
        collection,
        key,
        data,
        created_at: now,
        updated_at: now,
      });
      return pluginStorageEntryFromRow<T>(created);
    });

  const removeImpl = (owner: Owner, collection: string, key: string) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot delete plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      yield* input.core.deleteMany("plugin_storage", {
        where: whereOwner(owner, collection, key),
      });
    });

  const keysByCollection = (
    entries: readonly { readonly collection: string; readonly key: string }[],
  ) => {
    const grouped = new Map<string, Set<string>>();
    for (const entry of entries) {
      const keys = grouped.get(entry.collection);
      if (keys) {
        keys.add(entry.key);
      } else {
        grouped.set(entry.collection, new Set([entry.key]));
      }
    }
    return grouped;
  };

  const deleteManyImpl = (
    owner: Owner,
    subject: string,
    entries: readonly { readonly collection: string; readonly key: string }[],
  ) =>
    Effect.gen(function* () {
      for (const [collection, keys] of keysByCollection(entries)) {
        const uniqueKeys = [...keys];
        for (
          let offset = 0;
          offset < uniqueKeys.length;
          offset += PLUGIN_STORAGE_DELETE_KEY_BATCH_SIZE
        ) {
          const batchKeys = uniqueKeys.slice(offset, offset + PLUGIN_STORAGE_DELETE_KEY_BATCH_SIZE);
          yield* input.core.deleteMany("plugin_storage", {
            where: (b) =>
              b.and(
                b("plugin_id", "=", input.pluginId),
                b("collection", "=", collection),
                b("key", "in", batchKeys),
                b("owner", "=", owner),
                b("subject", "=", subject),
              ),
          });
        }
      }
    });

  const putManyImpl = (
    owner: Owner,
    entries: readonly {
      readonly collection: string;
      readonly key: string;
      readonly data: unknown;
    }[],
  ) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot write plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      const entriesById = new Map(
        entries.map((entry) => [
          pluginStorageId({
            pluginId: input.pluginId,
            collection: entry.collection,
            key: entry.key,
          }),
          entry,
        ]),
      );
      const uniqueEntries = [...entriesById.values()];
      if (uniqueEntries.length === 0) return;

      yield* deleteManyImpl(owner, os.subject, uniqueEntries);

      const now = new Date();
      for (
        let offset = 0;
        offset < uniqueEntries.length;
        offset += PLUGIN_STORAGE_CREATE_ROW_BATCH_SIZE
      ) {
        const batchEntries = uniqueEntries.slice(
          offset,
          offset + PLUGIN_STORAGE_CREATE_ROW_BATCH_SIZE,
        );
        yield* input.core.createMany(
          "plugin_storage",
          batchEntries.map((entry) => ({
            tenant,
            owner: os.owner,
            subject: os.subject,
            plugin_id: input.pluginId,
            collection: entry.collection,
            key: entry.key,
            data: entry.data,
            created_at: now,
            updated_at: now,
          })),
        );
      }
    });

  const removeManyImpl = (
    owner: Owner,
    entries: readonly { readonly collection: string; readonly key: string }[],
  ) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot delete plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      yield* deleteManyImpl(owner, os.subject, entries);
    });

  const queryCollection = <TDefinition extends PluginStorageCollectionDefinition>(
    definition: TDefinition,
    queryInput?: PluginStorageCollectionQueryInput<TDefinition>,
  ) =>
    Effect.gen(function* () {
      const validationError = pluginStorageQueryValidationError(
        definition,
        queryInput as
          | PluginStorageCollectionQueryInput<PluginStorageCollectionDefinition>
          | undefined,
      );
      if (validationError) return yield* validationError;

      const rows = yield* input.core.findMany("plugin_storage", {
        where: whereFor(definition.name),
      });
      const filtered = sortByOwnerPrecedence(rows)
        .filter((row) =>
          queryInput?.keyPrefix === undefined ? true : row.key.startsWith(queryInput.keyPrefix),
        )
        .filter((row) =>
          rowMatchesPluginStorageWhere(
            row,
            queryInput?.where as Readonly<Record<string, unknown>> | undefined,
          ),
        );

      const sorted =
        queryInput?.orderBy && queryInput.orderBy.length > 0
          ? [...filtered].sort((left, right) => {
              for (const order of queryInput.orderBy ?? []) {
                const direction = order.direction === "desc" ? -1 : 1;
                const compared =
                  comparePluginStorageValues(
                    pluginStorageDataField(left.data, order.field),
                    pluginStorageDataField(right.data, order.field),
                  ) * direction;
                if (compared !== 0) return compared;
              }
              return (
                ownerRank(left.owner as Owner) - ownerRank(right.owner as Owner) ||
                left.key.localeCompare(right.key)
              );
            })
          : filtered;

      const offset = queryInput?.offset ?? 0;
      const limited =
        queryInput?.limit === undefined
          ? sorted.slice(offset)
          : sorted.slice(offset, offset + queryInput.limit);
      return limited.map((row) =>
        pluginStorageEntryFromRow<PluginStorageCollectionData<TDefinition>>(row),
      );
    });

  return {
    collection: (definition) => ({
      get: (storageInput) =>
        getVisible(definition.name, storageInput.key) as Effect.Effect<
          PluginStorageEntry<PluginStorageCollectionData<typeof definition>> | null,
          StorageFailure
        >,
      getForOwner: (storageInput) =>
        getForOwnerImpl(storageInput.owner, definition.name, storageInput.key) as Effect.Effect<
          PluginStorageEntry<PluginStorageCollectionData<typeof definition>> | null,
          StorageFailure
        >,
      list: (storageInput) => queryCollection(definition, { keyPrefix: storageInput?.keyPrefix }),
      put: (storageInput) =>
        putImpl(
          storageInput.owner,
          definition.name,
          storageInput.key,
          storageInput.data,
        ) as Effect.Effect<
          PluginStorageEntry<PluginStorageCollectionData<typeof definition>>,
          StorageFailure
        >,
      query: (storageInput) => queryCollection(definition, storageInput),
      count: (storageInput) =>
        queryCollection(definition, storageInput).pipe(Effect.map((rows) => rows.length)),
      remove: (storageInput) => removeImpl(storageInput.owner, definition.name, storageInput.key),
    }),
    get: (storageInput) => getVisible(storageInput.collection, storageInput.key),
    getForOwner: (storageInput) =>
      getForOwnerImpl(storageInput.owner, storageInput.collection, storageInput.key),
    list: (storageInput) =>
      Effect.gen(function* () {
        const rows = yield* input.core.findMany("plugin_storage", {
          where: whereFor(storageInput.collection),
        });
        return sortByOwnerPrecedence(rows)
          .filter((row) =>
            storageInput.keyPrefix === undefined
              ? true
              : row.key.startsWith(storageInput.keyPrefix),
          )
          .map((row) => pluginStorageEntryFromRow(row));
      }),
    put: (storageInput) =>
      putImpl(storageInput.owner, storageInput.collection, storageInput.key, storageInput.data),
    putMany: (storageInput) => putManyImpl(storageInput.owner, storageInput.entries),
    remove: (storageInput) =>
      removeImpl(storageInput.owner, storageInput.collection, storageInput.key),
    removeMany: (storageInput) => removeManyImpl(storageInput.owner, storageInput.entries),
  };
};

// ---------------------------------------------------------------------------
// Approval argument preview
// ---------------------------------------------------------------------------

const approvalArgumentPreview = (args: unknown): string => {
  const text = JSON.stringify(args ?? {}, null, 2) ?? "null";
  return text.length > MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS
    ? `${text.slice(0, MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS)}...`
    : text;
};

// ---------------------------------------------------------------------------
// createExecutor
// ---------------------------------------------------------------------------

interface StaticTools {
  readonly integration: StaticIntegrationDecl;
  readonly tool: StaticToolDecl;
  readonly pluginId: string;
  readonly ctx: PluginCtx<unknown>;
}

interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly storage: unknown;
  readonly ctx: PluginCtx<unknown>;
}

const EXECUTOR_INTEGRATION_ID = "executor";
const EXECUTOR_INTEGRATION: StaticIntegrationDecl = {
  id: EXECUTOR_INTEGRATION_ID,
  kind: "built-in",
  name: "Executor",
  canRemove: false,
  canRefresh: false,
  canEdit: false,
  tools: [],
};

const isReadonlyRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null;

const POLICY_MUTATING_STORAGE_METHOD =
  /^(?:put|append|remove|delete|set|update|create|write|clear|insert|upsert|replace|mark)/i;
const POLICY_READING_STORAGE_METHOD =
  /^(?:get|list|find|read|has|exists|query|count|keys|values|entries|tojson)/i;

/** Build the deliberately narrow storage view used by policy annotation
 * resolvers. A type-level `Readonly<T>` is not enough because storage methods
 * can still mutate through their closures, so the runtime facade hides common
 * mutators and rejects all proxy writes. */
const makePolicyReadonlyStorage = <T>(storage: T): Readonly<T> => {
  if (typeof storage !== "object" || storage === null) return storage;
  const target = storage as object;
  return new Proxy(target, {
    get: (current, property) => {
      if (typeof property === "string" && POLICY_MUTATING_STORAGE_METHOD.test(property)) {
        return undefined;
      }
      let owner: object | null = current;
      let value: unknown;
      while (owner !== null) {
        const descriptor = Reflect.getOwnPropertyDescriptor(owner, property);
        if (descriptor) {
          if (!("value" in descriptor)) return undefined;
          value = descriptor.value;
          break;
        }
        owner = Reflect.getPrototypeOf(owner);
      }
      if (value === undefined && owner === null) return undefined;
      if (typeof value !== "function") return value;
      if (typeof property === "string" && !POLICY_READING_STORAGE_METHOD.test(property)) {
        return undefined;
      }
      return value.bind(current);
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  }) as Readonly<T>;
};

type StandardJsonSchemaSide = "input" | "output";
type StandardJsonSchemaFns = {
  readonly input?: (options: { readonly target: "draft-07" }) => unknown;
  readonly output?: (options: { readonly target: "draft-07" }) => unknown;
};

const staticToolSchemaRoot = (
  schema: StaticToolDecl["inputSchema"] | StaticToolDecl["outputSchema"],
  side: StandardJsonSchemaSide,
): unknown | undefined => {
  if (!schema) return undefined;
  const standard = isReadonlyRecord(schema) ? schema["~standard"] : undefined;
  if (!isReadonlyRecord(standard)) return schema;
  const jsonSchema = standard["jsonSchema"];
  if (!isReadonlyRecord(jsonSchema)) return schema;
  const materialize = (jsonSchema as StandardJsonSchemaFns)[side];
  return typeof materialize === "function" ? materialize({ target: "draft-07" }) : jsonSchema;
};

export const createExecutor = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  config: ExecutorConfig<TPlugins>,
): Effect.Effect<Executor<TPlugins>, StorageFailure> =>
  Effect.gen(function* () {
    const defaultPlugins = (): TPlugins => {
      const empty: readonly AnyPlugin[] = [];
      return empty as TPlugins;
    };
    const { plugins: userPlugins = defaultPlugins() } = config;

    const tenant = String(config.tenant);
    const subject = config.subject != null ? String(config.subject) : null;

    const ownerBinding: OwnerBinding = {
      tenant: config.tenant,
      subject: config.subject ?? null,
    };

    const ownedKeys = (owner: Owner): OwnedKeys => {
      if (owner === "org") return { tenant, owner, subject: ORG_SUBJECT };
      if (subject == null) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: programmer error caught and surfaced as StorageError below by callers
        throw new StorageError({
          message: `Cannot target owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      return { tenant, owner, subject };
    };

    const requireUserSubject = (owner: Owner): Effect.Effect<void, StorageFailure> =>
      owner === "user" && subject == null
        ? Effect.fail(
            new StorageError({
              message: `Cannot target owner "user": executor has no subject.`,
              cause: undefined,
            }),
          )
        : Effect.void;

    // Built-in core-tools plugin: agent-facing static tools over the v2 surface.
    const plugins: readonly AnyPlugin[] = config.coreTools
      ? ([
          coreToolsPlugin({
            webBaseUrl: config.coreTools.webBaseUrl,
            orgSlug: config.coreTools.orgSlug,
            includeProviders: config.coreTools.includeProviders,
          }),
          ...userPlugins,
        ] as readonly AnyPlugin[])
      : (userPlugins as readonly AnyPlugin[]);

    const tables = yield* Effect.try({
      try: () => collectTables(),
      catch: (cause) => storageFailureFromUnknown("Failed to collect executor tables", cause),
    });
    const dbInput = yield* Effect.suspend(() => {
      if (!config.db) return Effect.succeed(createDefaultMemoryDb(tables));
      if (typeof config.db !== "function") return Effect.succeed(config.db);
      const out = config.db({ tables });
      return Effect.isEffect(out) ? out : Effect.succeed(out);
    });
    const rootDbUntyped = "db" in dbInput ? dbInput.db : dbInput;
    const closeDb = "db" in dbInput ? dbInput.close : undefined;
    yield* Effect.try({
      try: () => {
        validateExecutorDbTables(tables, rootDbUntyped.internal.tables);
        validateExecutorOwnerPolicyTables(rootDbUntyped.internal.tables);
      },
      catch: (cause) => storageFailureFromUnknown("Failed to validate executor tables", cause),
    });

    const ownerContext: ExecutorOwnerPolicyContext = { tenant, subject };
    const rootDb = withQueryContext(rootDbUntyped, ownerContext);
    const fuma = makeFumaClient(rootDb);
    const core = makeCoreDb(fuma);
    const blobs = config.blobs ?? makeFumaBlobStore(fuma);
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => fuma.transaction(effect);

    // Populated once, never mutated after startup.
    const staticTools = new Map<string, StaticTools>();
    const runtimes = new Map<string, PluginRuntime>();
    let activeToolPolicyProvider: ToolPolicyProvider | null = null;
    const operationRegistry = new Map<string, ExecuteOperationDefinition>();
    for (const definition of config.operations ?? []) {
      const registryKey = `${definition.operationKey}@${definition.version}`;
      if (operationRegistry.has(registryKey)) {
        return yield* new StorageError({
          message: `Duplicate Executor operation definition: ${registryKey}`,
          cause: undefined,
        });
      }
      if (!definition.inputSchema || !definition.outputSchema) {
        return yield* new StorageError({
          message: `Executor operation ${registryKey} must declare input and output schemas.`,
          cause: undefined,
        });
      }
      operationRegistry.set(registryKey, definition);
    }
    if (
      (config.operations?.length ?? 0) > 0 &&
      (config.operationReplayStore === undefined ||
        (config.operationReplayStore.durability !== "durable" &&
          config.allowProcessLocalOperationReplayStore !== true))
    ) {
      return yield* new StorageError({
        message:
          "Executor operation registry requires a durable operationReplayStore; refusing to start with a process-local replay ledger.",
        cause: undefined,
      });
    }
    // There is no implicit process-local ledger. Hosts that expose operation
    // definitions must inject a durable store; the startup guard above makes
    // that requirement explicit, while this check also protects a future
    // dynamically-populated registry.
    const operationReplayStore = config.operationReplayStore;
    const operationExecutionAvailable =
      operationRegistry.size > 0 && operationReplayStore !== undefined;
    // Credential providers keyed by `provider.key`, in registration order.
    const credentialProviders = new Map<string, CredentialProvider>();
    const credentialProviderOrder: string[] = [];

    const staticToolOwner = (): Owner => (subject == null ? "org" : "user");
    const staticToolConnection = (integration: StaticIntegrationDecl): ConnectionName =>
      ConnectionName.make(integration.id === EXECUTOR_INTEGRATION_ID ? "coreTools" : "static");

    const staticIntegrations = (): readonly StaticIntegrationDecl[] => {
      const byId = new Map<string, StaticIntegrationDecl>();
      for (const entry of staticTools.values()) {
        if (!byId.has(entry.integration.id)) byId.set(entry.integration.id, entry.integration);
      }
      return [...byId.values()];
    };

    const staticDeclToIntegration = (integration: StaticIntegrationDecl): Integration => ({
      slug: IntegrationSlug.make(integration.id),
      name: integration.name,
      description: integration.name,
      kind: integration.kind,
      canRemove: integration.canRemove ?? false,
      canRefresh: integration.canRefresh ?? false,
      authMethods: [],
    });

    const staticToolToTool = (entry: StaticTools): Tool => ({
      address: ToolAddress.make(`${entry.integration.id}.${entry.tool.name}`),
      owner: staticToolOwner(),
      integration: IntegrationSlug.make(entry.integration.id),
      connection: staticToolConnection(entry.integration),
      name: ToolName.make(entry.tool.name),
      pluginId: entry.pluginId,
      description: entry.tool.description,
      inputSchema: staticToolSchemaRoot(entry.tool.inputSchema, "input"),
      outputSchema: staticToolSchemaRoot(entry.tool.outputSchema, "output"),
      annotations: entry.tool.annotations,
      static: true,
    });

    const registerCredentialProvider = (
      provider: CredentialProvider,
      sourceLabel: string,
    ): Effect.Effect<void, StorageFailure> => {
      const key = String(provider.key);
      if (credentialProviders.has(key)) {
        return Effect.fail(
          new StorageError({
            message: `Duplicate credential provider key: ${key} (from ${sourceLabel})`,
            cause: undefined,
          }),
        );
      }
      credentialProviders.set(key, provider);
      credentialProviderOrder.push(key);
      return Effect.void;
    };

    // Config-level providers register first so the default store prefers them.
    for (const provider of config.providers ?? []) {
      yield* registerCredentialProvider(provider, "config");
    }

    const defaultWritableProvider = (): CredentialProvider | null => {
      for (const key of credentialProviderOrder) {
        const provider = credentialProviders.get(key);
        if (provider?.writable) return provider;
      }
      return null;
    };

    const extensions: Record<string, object> = {};

    // ------------------------------------------------------------------
    // Owner condition builders. The owner policy already restricts reads to
    // (tenant, org|this-subject); `byOwner` narrows to one explicit owner.
    // ------------------------------------------------------------------

    const byOwner =
      (owner: Owner): CoreWhere =>
      (b: AnyCb) => {
        const keys = owner === "org" ? ORG_SUBJECT : (subject ?? "__none__");
        return b.and(b("owner", "=", owner), b("subject", "=", keys));
      };

    // ------------------------------------------------------------------
    // Credential resolution
    // ------------------------------------------------------------------

    const findConnectionRow = (
      ref: ConnectionRef,
    ): Effect.Effect<ConnectionRow | null, StorageFailure> =>
      core.findFirst("connection", {
        where: (b: AnyCb) =>
          b.and(
            byOwner(ref.owner)(b),
            b("integration", "=", String(ref.integration)),
            b("name", "=", String(ref.name)),
          ),
      });

    // In-flight refresh gate — concurrent resolves of the same connection share
    // one refresh (mirrors v1's refresh deferred-map) so we never fire two
    // refresh-token grants for the same connection in parallel (the AS rotates
    // the refresh token; the second request would race on a consumed token).
    const refreshInFlight = new Map<
      string,
      Effect.Effect<string | null, StorageFailure | CredentialResolutionError>
    >();

    const connectionKey = (row: ConnectionRow): string =>
      `${row.owner}:${row.subject}:${row.integration}:${row.name}`;

    const loadOAuthClientRow = (
      owner: Owner,
      slug: string,
    ): Effect.Effect<OAuthClientRow | null, StorageFailure> =>
      core.findFirst("oauth_client", {
        where: (b: AnyCb) => b.and(byOwner(owner)(b), b("slug", "=", slug)),
      });

    // Perform the actual refresh-token grant and persist the rotated material.
    const performTokenRefresh = (
      row: ConnectionRow,
      provider: CredentialProvider,
    ): Effect.Effect<string | null, StorageFailure | CredentialResolutionError> =>
      Effect.gen(function* () {
        const owner = row.owner as Owner;
        const reauth = (message: string): CredentialResolutionError =>
          new CredentialResolutionError({
            owner,
            integration: IntegrationSlug.make(row.integration),
            name: ConnectionName.make(row.name),
            message,
            reauthRequired: true,
          });

        // Load the backing app by the owner STORED on the connection (a Personal
        // connection may be backed by a shared Workspace app) — no derivation.
        const clientOwner = (row.oauth_client_owner ?? row.owner) as Owner;
        const clientRow = yield* loadOAuthClientRow(clientOwner, String(row.oauth_client));
        if (!clientRow) {
          return yield* reauth(`OAuth client "${row.oauth_client}" is no longer registered.`);
        }

        // The secret is stored in the provider (a vault item id), not inline.
        const clientSecret = clientRow.client_secret_item_id
          ? ((yield* provider.get(ProviderItemId.make(String(clientRow.client_secret_item_id)))) ??
            "")
          : "";
        // Re-request the scopes this connection was GRANTED (RFC 6749 §6: a
        // refresh must not exceed the originally-granted scope). Empty → omit
        // the param, which the AS treats as "same scopes as granted".
        const grantedScopes = row.oauth_scope
          ? String(row.oauth_scope).split(/\s+/).filter(Boolean)
          : [];

        // Refresh against the region the code was redeemed at when one was
        // recorded at connect time (multi-site providers like Datadog), else
        // the oauth_client's configured token endpoint.
        const tokenUrl = row.oauth_token_url
          ? String(row.oauth_token_url)
          : String(clientRow.token_url);

        // client_credentials (machine-to-machine) has NO refresh token — the
        // token is RE-MINTED from the client id/secret. The authorization_code
        // path below needs a stored refresh token. Branching on grant here is
        // what keeps a client_credentials connection (e.g. DealCloud) from
        // demanding a re-auth on a credential that has no human to re-auth.
        const token =
          String(clientRow.grant) === "client_credentials"
            ? yield* exchangeClientCredentials({
                tokenUrl,
                clientId: String(clientRow.client_id),
                clientSecret,
                scopes: grantedScopes,
                resource: clientRow.resource ? String(clientRow.resource) : undefined,
                endpointUrlPolicy: config.oauthEndpointUrlPolicy,
                fetch: config.fetch,
              }).pipe(
                // A client_credentials failure is never a rotated-refresh-token
                // problem, so do NOT map invalid_grant → reauth. Surface as a
                // StorageError; the in-flight gate clears on settle, so the next
                // invoke retries (handles transient AS/network blips).
                Effect.mapError(
                  (cause) =>
                    new StorageError({
                      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                      message: `Client-credentials token request failed: ${cause.message}`,
                      cause,
                    }),
                ),
              )
            : yield* Effect.gen(function* () {
                if (!row.refresh_item_id) {
                  return yield* reauth("No refresh token is stored for this connection.");
                }
                const refreshToken = yield* provider.get(ProviderItemId.make(row.refresh_item_id));
                if (!refreshToken) {
                  return yield* reauth("Stored refresh token could not be resolved.");
                }
                return yield* refreshAccessToken({
                  tokenUrl,
                  clientId: String(clientRow.client_id),
                  clientSecret,
                  refreshToken,
                  scopes: grantedScopes,
                  // RFC 8707: keep the re-minted token bound to the same resource
                  // (MCP servers require this on refresh).
                  resource: clientRow.resource ? String(clientRow.resource) : undefined,
                  endpointUrlPolicy: config.oauthEndpointUrlPolicy,
                  fetch: config.fetch,
                }).pipe(
                  Effect.mapError((cause) =>
                    cause.error === "invalid_grant"
                      ? reauth(
                          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                          `OAuth token refresh was rejected (invalid_grant): ${cause.message}`,
                        )
                      : new StorageError({
                          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                          message: `OAuth token refresh failed: ${cause.message}`,
                          cause,
                        }),
                  ),
                );
              });

        if (provider.set) {
          // OAuth is always single-input: the access token lives in the `token`
          // item. Fall back to a deterministic id if the map is somehow empty.
          const tokenItemId =
            connectionItemIds(row)[PRIMARY_INPUT_VARIABLE] ??
            `connection:${row.owner}:${row.integration}:${row.name}:${PRIMARY_INPUT_VARIABLE}`;
          yield* provider.set(ProviderItemId.make(tokenItemId), token.access_token);
          if (token.refresh_token && row.refresh_item_id) {
            yield* provider.set(ProviderItemId.make(row.refresh_item_id), token.refresh_token);
          }
        }

        const nextExpiresAt =
          typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : null;
        const set: Record<string, unknown> = {
          expires_at: nextExpiresAt,
          updated_at: new Date(),
        };
        if (token.scope !== undefined) set.oauth_scope = token.scope;
        yield* core.updateMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(owner)(b),
              b("integration", "=", String(row.integration)),
              b("name", "=", String(row.name)),
            ),
          set,
        });

        return token.access_token;
      });

    const refreshConnectionToken = (
      row: ConnectionRow,
      provider: CredentialProvider,
    ): Effect.Effect<string | null, StorageFailure | CredentialResolutionError> =>
      // Share a single refresh per connection so concurrent resolves of the same
      // connection all await one refresh-token grant (the AS rotates the refresh
      // token; parallel grants would race on a consumed token — v1's refresh
      // deferred-map). The gate is cleared once the refresh settles so a later
      // expiry can refresh again.
      Effect.gen(function* () {
        const key = connectionKey(row);
        const existing = refreshInFlight.get(key);
        if (existing) return yield* existing;
        // `Effect.cached` memoizes the grant onto a deferred: it runs once and
        // replays to every awaiter sharing this entry.
        const memoized = yield* Effect.cached(performTokenRefresh(row, provider));
        const gated = memoized.pipe(
          Effect.ensuring(Effect.sync(() => refreshInFlight.delete(key))),
        );
        // Re-check after building (a peer fiber may have registered first while
        // we built ours) so everyone converges on the same shared grant.
        const winner = refreshInFlight.get(key) ?? gated;
        if (winner === gated) refreshInFlight.set(key, gated);
        return yield* winner;
      });

    // Resolve every named input of a connection (`variable → value`). A
    // single-secret connection yields `{ token: <value> }`; an apiKey method with
    // two distinct inputs yields one entry per variable. OAuth connections refresh
    // first (always single-input → `{ token: <access> }`).
    const resolveConnectionValues = (
      row: ConnectionRow,
    ): Effect.Effect<Record<string, string | null>, StorageFailure | CredentialResolutionError> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(row.provider);
        if (!provider) {
          return yield* new CredentialProviderNotRegisteredError({
            provider: ProviderKey.make(row.provider),
          });
        }
        // OAuth connections refresh their access token before resolving when
        // it has expired (or is within the skew window).
        const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
        if (row.oauth_client != null && shouldRefreshToken({ expiresAt })) {
          const access = yield* refreshConnectionToken(row, provider);
          return { [PRIMARY_INPUT_VARIABLE]: access };
        }
        const out: Record<string, string | null> = {};
        for (const [variable, itemId] of Object.entries(connectionItemIds(row))) {
          out[variable] = yield* provider.get(ProviderItemId.make(itemId));
        }
        return out;
      }).pipe(
        // CredentialProviderNotRegisteredError is part of CredentialResolution
        // for ctx.connections.resolveValue's StorageFailure channel — fold it.
        Effect.catchTag("CredentialProviderNotRegisteredError", (err) =>
          Effect.fail(
            new StorageError({
              message: `Credential provider "${err.provider}" is not registered.`,
              cause: err,
            }),
          ),
        ),
      );

    /** The primary (`token`) value — the public seam for OAuth + single-input
     *  callers that only ever need one value. */
    const resolveConnectionValue = (
      row: ConnectionRow,
    ): Effect.Effect<string | null, StorageFailure | CredentialResolutionError> =>
      resolveConnectionValues(row).pipe(
        Effect.map((values) => values[PRIMARY_INPUT_VARIABLE] ?? null),
      );

    // The plugin-facing contract (`ctx.connections.resolveValue`, `getValue`,
    // `getValues`) is `StorageFailure`-typed; fold a reauth-required resolution
    // failure into a StorageError so the public surface stays stable.
    const foldResolutionFailure = <A>(
      effect: Effect.Effect<A, StorageFailure | CredentialResolutionError>,
    ): Effect.Effect<A, StorageFailure> =>
      effect.pipe(
        Effect.catchTag("CredentialResolutionError", (err) =>
          Effect.fail(
            new StorageError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
              message: err.message,
              cause: err,
            }),
          ),
        ),
      );

    const resolveConnectionValueByRef = (
      ref: ConnectionRef,
    ): Effect.Effect<string | null, StorageFailure> =>
      foldResolutionFailure(
        Effect.gen(function* () {
          const row = yield* findConnectionRow(ref);
          if (!row) return null;
          return yield* resolveConnectionValue(row);
        }),
      );

    const resolveConnectionValuesByRef = (
      ref: ConnectionRef,
    ): Effect.Effect<Record<string, string | null>, StorageFailure> =>
      foldResolutionFailure(
        Effect.gen(function* () {
          const row = yield* findConnectionRow(ref);
          if (!row) return {};
          return yield* resolveConnectionValues(row);
        }),
      );

    // ------------------------------------------------------------------
    // Integrations
    // ------------------------------------------------------------------

    const findIntegrationRow = (
      slug: IntegrationSlug,
    ): Effect.Effect<IntegrationRow | null, StorageFailure> =>
      core.findFirst("integration", {
        where: (b: AnyCb) => b("slug", "=", String(slug)),
      });

    // Project a row's stored config into declared auth methods via the owning
    // plugin's `describeAuthMethods` hook. The hook is plugin-authored, so a
    // throw (malformed config it didn't guard) degrades to `[]` rather than
    // failing the catalog read.
    const describeAuthMethodsForRow = (row: IntegrationRow): readonly AuthMethodDescriptor[] => {
      const runtime = runtimes.get(row.plugin_id);
      const describe = runtime?.plugin.describeAuthMethods;
      if (!describe) return [];
      const record = rowToIntegrationRecord(row);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plugin-authored projector must never fail the catalog read
      try {
        return describe(record);
      } catch {
        return [];
      }
    };

    const describeDisplayForRow = (row: IntegrationRow): IntegrationDisplayDescriptor => {
      const runtime = runtimes.get(row.plugin_id);
      const describe = runtime?.plugin.describeIntegrationDisplay;
      if (!describe) return {};
      const record = rowToIntegrationRecord(row);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plugin-authored projector must never fail the catalog read
      try {
        const display = describe(record);
        return {
          ...(display.url && display.url.length > 0 ? { url: display.url } : {}),
          ...(display.family && display.family.length > 0 ? { family: display.family } : {}),
        };
      } catch {
        return {};
      }
    };

    // The declared health check off the integration row's own column. CORE
    // owns this storage (never the plugin config blob), so a plugin config
    // rewrite can never strip it and no plugin schema has to declare it.
    const describeHealthCheckForRow = (row: IntegrationRow): HealthCheckSpec | null =>
      Option.getOrNull(decodeHealthCheckSpec(row.health_check));

    // The health-check hooks are typed `Effect<_, unknown>` at the PluginSpec
    // boundary (each plugin owns its own error shape). Fold that channel into a
    // StorageError so the public health-check surface stays StorageFailure-typed.
    // A genuine storage failure surfaces here; an auth wall or upstream error is
    // a SUCCESSFUL `HealthCheckResult` (status expired/degraded), not a failure.
    const foldPluginFailure = <A>(
      effect: Effect.Effect<A, unknown>,
      message: string,
    ): Effect.Effect<A, StorageFailure> =>
      effect.pipe(
        Effect.catch((cause: unknown) =>
          isStorageFailure(cause)
            ? Effect.fail(cause)
            : Effect.fail(new StorageError({ message, cause })),
        ),
      );

    const integrationsList = (): Effect.Effect<readonly Integration[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany("integration", {});
        const staticIntegrationList = staticIntegrations().map(staticDeclToIntegration);
        const dbIntegrations = rows.map((row) =>
          rowToIntegration(row, describeAuthMethodsForRow(row), describeDisplayForRow(row)),
        );
        // A scoped toolkit must not advertise providers it grants no tools from
        // (mirrors `connectionsList`). Static integrations are system namespaces, not
        // user providers, so they stay; DB-backed integrations are filtered to
        // those that contribute at least one visible tool under the active policy.
        if (!activeToolPolicyProvider) return [...staticIntegrationList, ...dbIntegrations];
        const visibleTools = yield* toolsList({ includeAnnotations: false });
        const visibleIntegrationSlugs = new Set(
          visibleTools.filter((tool) => !tool.static).map((tool) => String(tool.integration)),
        );
        return [
          ...staticIntegrationList,
          ...dbIntegrations.filter((integration) =>
            visibleIntegrationSlugs.has(String(integration.slug)),
          ),
        ];
      });

    const integrationsGet = (
      slug: IntegrationSlug,
    ): Effect.Effect<Integration | null, StorageFailure> =>
      Effect.gen(function* () {
        const staticIntegration = staticIntegrations().find(
          (integration) => integration.id === String(slug),
        );
        if (staticIntegration) return staticDeclToIntegration(staticIntegration);
        const row = yield* findIntegrationRow(slug);
        return row
          ? rowToIntegration(row, describeAuthMethodsForRow(row), describeDisplayForRow(row))
          : null;
      });

    const integrationsGetRecord = (
      slug: IntegrationSlug,
    ): Effect.Effect<IntegrationRecord | null, StorageFailure> =>
      findIntegrationRow(slug).pipe(
        Effect.map((row) =>
          row ? rowToIntegrationRecord(row, describeAuthMethodsForRow(row)) : null,
        ),
      );

    const integrationsRegister = (
      pluginId: string,
      input: RegisterIntegrationInput,
    ): Effect.Effect<void, StorageFailure> =>
      transaction(
        Effect.gen(function* () {
          const now = new Date();
          const existing = yield* findIntegrationRow(input.slug);
          const config = input.config === undefined ? null : input.config;
          if (existing) {
            yield* core.updateMany("integration", {
              where: (b: AnyCb) => b("slug", "=", String(input.slug)),
              set: {
                plugin_id: pluginId,
                name: input.name ?? existing.name ?? null,
                description: input.description,
                config,
                can_remove: input.canRemove ?? Boolean(existing.can_remove),
                can_refresh: input.canRefresh ?? Boolean(existing.can_refresh),
                updated_at: now,
              },
            });
            return;
          }
          yield* core.create("integration", {
            tenant,
            slug: String(input.slug),
            plugin_id: pluginId,
            name: input.name ?? null,
            description: input.description,
            config,
            can_remove: input.canRemove ?? true,
            can_refresh: input.canRefresh ?? false,
            created_at: now,
            updated_at: now,
          });
        }),
      );

    const integrationsUpdate = (
      slug: IntegrationSlug,
      patch: {
        readonly name?: string;
        readonly description?: string;
        readonly config?: IntegrationConfig;
      },
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const now = new Date();
        const set: Record<string, unknown> = { updated_at: now };
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.description !== undefined) set.description = patch.description;
        if (patch.config !== undefined) {
          set.config = patch.config;
          // A config change can change the derived tools. The writer can only
          // rebuild catalogs in its own partition (owner policy), so revise
          // the integration: other subjects' connections compare this stamp
          // against their `tools_synced_at` and lazily rebuild on next read.
          set.config_revised_at = now.getTime();
        }
        yield* core.updateMany("integration", {
          where: (b: AnyCb) => b("slug", "=", String(slug)),
          set,
        });
      });

    const integrationsUpdatePublic = (
      slug: IntegrationSlug,
      patch: { readonly name?: string; readonly description?: string },
    ): Effect.Effect<void, IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const existing = yield* findIntegrationRow(slug);
        if (!existing) return yield* new IntegrationNotFoundError({ slug });
        yield* integrationsUpdate(slug, patch);
      });

    const integrationsRemove = (
      slug: IntegrationSlug,
    ): Effect.Effect<void, IntegrationRemovalNotAllowedError | StorageFailure> =>
      transaction(
        Effect.gen(function* () {
          const existing = yield* findIntegrationRow(slug);
          if (!existing) return;
          if (!existing.can_remove) {
            return yield* new IntegrationRemovalNotAllowedError({ slug });
          }
          const runtime = runtimes.get(existing.plugin_id);
          if (runtime?.plugin.removeIntegration) {
            yield* runtime.plugin
              .removeIntegration({
                ctx: runtime.ctx,
                integration: rowToIntegrationRecord(existing, describeAuthMethodsForRow(existing)),
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(existing.plugin_id, "removeIntegration", cause),
                ),
              );
          }
          // Drop owned connections / tools / definitions for this integration.
          const where = (b: AnyCb) => b("integration", "=", String(slug));
          yield* core.deleteMany("tool", { where });
          yield* core.deleteMany("definition", { where });
          yield* core.deleteMany("connection", { where });
          yield* core.deleteMany("integration", {
            where: (b: AnyCb) => b("slug", "=", String(slug)),
          });
        }),
      );

    const integrationsDetect = (
      url: string,
    ): Effect.Effect<readonly IntegrationDetectionResult[], StorageFailure> =>
      Effect.gen(function* () {
        const results: IntegrationDetectionResult[] = [];
        for (const runtime of runtimes.values()) {
          if (!runtime.plugin.detect) continue;
          const result = yield* runtime.plugin
            .detect({ ctx: runtime.ctx, url })
            .pipe(
              Effect.mapError((cause) => pluginStorageFailure(runtime.plugin.id, "detect", cause)),
            );
          if (result) results.push(result);
        }
        return results;
      });

    // ------------------------------------------------------------------
    // Health checks: dispatch to the owning plugin's hooks.
    // ------------------------------------------------------------------

    const integrationHealthCheckGet = (
      slug: IntegrationSlug,
    ): Effect.Effect<HealthCheckSpec | null, StorageFailure> =>
      findIntegrationRow(slug).pipe(
        Effect.map((row) => (row ? describeHealthCheckForRow(row) : null)),
      );

    const integrationHealthCheckCandidates = (
      slug: IntegrationSlug,
    ): Effect.Effect<readonly HealthCheckCandidate[], IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findIntegrationRow(slug);
        if (!row) return yield* new IntegrationNotFoundError({ slug });
        const runtime = runtimes.get(row.plugin_id);
        const list = runtime?.plugin.listHealthCheckCandidates;
        if (!runtime || !list) return [];
        const record = rowToIntegrationRecord(row, describeAuthMethodsForRow(row));
        return yield* foldPluginFailure(
          list({ ctx: runtime.ctx, integration: record }),
          `Listing health-check candidates for "${slug}" failed.`,
        );
      });

    // Core-owned write: the spec lands in the integration row's own column.
    // No plugin hook, no config read-modify-write, nothing a plugin's own
    // config cycle can clobber.
    const integrationSetHealthCheck = (
      slug: IntegrationSlug,
      spec: HealthCheckSpec | null,
    ): Effect.Effect<void, IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findIntegrationRow(slug);
        if (!row) return yield* new IntegrationNotFoundError({ slug });
        yield* core.updateMany("integration", {
          where: (b: AnyCb) => b("slug", "=", String(slug)),
          set: { health_check: spec, updated_at: new Date() },
        });
      });

    // ------------------------------------------------------------------
    // Per-connection tool production
    // ------------------------------------------------------------------

    const toolSyncHealthDetailPrefix = "Tool sync failing";

    const toolSyncHealth = (reason: string): HealthCheckResult => ({
      status: "degraded",
      checkedAt: Date.now(),
      detail: `${toolSyncHealthDetailPrefix}: ${reason}`,
    });

    const syncHealthReason = (result: ResolveToolsResult): string =>
      result.incompleteReason ?? "plugin returned an incomplete tool catalog";

    const produceConnectionTools = (
      integrationRow: IntegrationRow,
      ref: ConnectionRef,
      mode: "explicit" | "background" = "explicit",
    ): Effect.Effect<readonly Tool[], IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const runtime = runtimes.get(integrationRow.plugin_id);
        const keys = yield* Effect.try({
          try: () => ownedKeys(ref.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const owner = ref.owner;
        const where = (b: AnyCb) =>
          b.and(
            byOwner(owner)(b),
            b("integration", "=", String(ref.integration)),
            b("connection", "=", String(ref.name)),
          );
        const connectionWhere = (b: AnyCb) =>
          b.and(
            byOwner(owner)(b),
            b("integration", "=", String(ref.integration)),
            b("name", "=", String(ref.name)),
          );
        const isToolSyncHealth = (health: HealthCheckResult | null): boolean =>
          health?.detail?.startsWith(toolSyncHealthDetailPrefix) === true;
        const syncedSet = (row: ConnectionRow | null) => {
          const health = row ? Option.getOrNull(decodeLastHealth(row.last_health)) : null;
          return isToolSyncHealth(health)
            ? { tools_synced_at: Date.now(), last_health: null, updated_at: new Date() }
            : { tools_synced_at: Date.now() };
        };
        // Every exit stamps the sync time — including the cleanup paths that
        // produce zero tools — so the stale-catalog check (`config_revised_at`
        // vs `tools_synced_at`) doesn't re-attempt this connection per read.
        // Successful syncs also clear stale sync-failure health records, while
        // preserving genuine health-check outcomes.
        const stampSynced = (row: ConnectionRow | null) =>
          core.updateMany("connection", {
            where: connectionWhere,
            set: syncedSet(row),
          });
        const stampSyncedWithHealth = (reason: string) =>
          core.updateMany("connection", {
            where: connectionWhere,
            set: {
              tools_synced_at: Date.now(),
              last_health: toolSyncHealth(reason),
              updated_at: new Date(),
            },
          });

        // Defense in depth (and cleanup for rows created before the create-time
        // guard, or emptied by an external edit): a credentialed non-OAuth
        // connection with no bound credential inputs can never resolve a value,
        // so never advertise tools for it — every call would fail with
        // `connection_value_missing`. OAuth connections resolve via refresh and
        // carry their token outside `item_ids`; no-auth (`"none"` template)
        // connections legitimately bind nothing (an empty `item_ids` is their
        // canonical shape) — both are exempt.
        const existingRow = yield* findConnectionRow(ref);
        if (
          existingRow &&
          existingRow.oauth_client == null &&
          existingRow.template !== String(NO_AUTH_TEMPLATE) &&
          Object.keys(connectionItemIds(existingRow)).length === 0
        ) {
          yield* transaction(
            Effect.gen(function* () {
              yield* core.deleteMany("tool", { where });
              yield* core.deleteMany("definition", { where });
              yield* stampSynced(existingRow);
            }),
          );
          return [];
        }

        if (!runtime?.plugin.resolveTools) {
          // No dynamic tools — clear any existing rows and return empty.
          yield* transaction(
            Effect.gen(function* () {
              yield* core.deleteMany("tool", { where });
              yield* core.deleteMany("definition", { where });
              yield* stampSynced(existingRow);
            }),
          );
          return [];
        }

        const result: ResolveToolsResult = yield* runtime.plugin
          .resolveTools({
            ctx: runtime.ctx,
            integration: rowToIntegration(integrationRow),
            config: decodeJsonColumn(integrationRow.config),
            httpClientLayer: runtime.ctx.httpClientLayer,
            connection: ref,
            template: existingRow ? AuthTemplateSlug.make(existingRow.template) : null,
            storage: runtime.storage,
            getValue: () => resolveConnectionValueByRef(ref),
            getValues: () => resolveConnectionValuesByRef(ref),
          })
          .pipe(
            Effect.mapError((cause) =>
              pluginStorageFailure(integrationRow.plugin_id, "resolveTools", cause),
            ),
          );

        if (result.incomplete === true) {
          // Non-authoritative listing (integration unreachable, auth not ready).
          // Keep the existing catalog — replacing it would wipe working tools
          // over a transient outage — and stamp the sync time anyway so a down
          // server isn't re-dialed on every read; the freshness TTL re-attempts
          // later.
          const reason = syncHealthReason(result);
          yield* stampSyncedWithHealth(reason);
          yield* Effect.logWarning("executor tool sync preserved catalog", {
            reason,
            integration: String(ref.integration),
            connection: String(ref.name),
          });
          const keptRows = yield* core.findMany("tool", { where });
          return keptRows.map((row) => rowToTool(row as ConnectionToolRow));
        }

        if (
          mode === "background" &&
          runtime.plugin.remoteToolCatalog === true &&
          result.tools.length === 0
        ) {
          const keptRows = yield* core.findMany("tool", { where });
          if (keptRows.length > 0) {
            const reason =
              "background tool sync produced an authoritative empty catalog for a connection with existing tools";
            yield* stampSyncedWithHealth(reason);
            yield* Effect.logWarning("executor tool sync preserved nonzero catalog", {
              reason,
              integration: String(ref.integration),
              connection: String(ref.name),
              existingToolCount: keptRows.length,
            });
            return keptRows.map((row) => rowToTool(row as ConnectionToolRow));
          }
        }

        const now = new Date();
        const toolRows = result.tools.map((tool: ToolDef) => ({
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          integration: String(ref.integration),
          connection: String(ref.name),
          plugin_id: integrationRow.plugin_id,
          name: String(tool.name),
          description: tool.description ?? "",
          input_schema: tool.inputSchema ?? null,
          output_schema: tool.outputSchema ?? null,
          annotations: tool.annotations ?? null,
          created_at: now,
          updated_at: now,
        }));

        const definitionRows = Object.entries(result.definitions ?? {}).map(([name, schema]) => ({
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          integration: String(ref.integration),
          connection: String(ref.name),
          plugin_id: integrationRow.plugin_id,
          name,
          schema,
          created_at: now,
        }));

        yield* transaction(
          Effect.gen(function* () {
            yield* core.deleteMany("tool", { where });
            yield* core.deleteMany("definition", { where });
            yield* core.createMany("tool", toolRows);
            yield* core.createMany("definition", definitionRows);
            yield* stampSynced(existingRow);
          }),
        );

        return result.tools.map((tool: ToolDef) =>
          rowToTool(
            {
              tenant: keys.tenant,
              owner: keys.owner,
              subject: keys.subject,
              integration: String(ref.integration),
              connection: String(ref.name),
              plugin_id: integrationRow.plugin_id,
              name: String(tool.name),
              description: tool.description ?? "",
              input_schema: tool.inputSchema ?? null,
              output_schema: tool.outputSchema ?? null,
              annotations: tool.annotations ?? null,
              created_at: now,
              updated_at: now,
            } as ConnectionToolRow,
            tool.annotations,
          ),
        );
      });

    // ------------------------------------------------------------------
    // Connections
    // ------------------------------------------------------------------

    const connectionsCreate = (
      input: CreateConnectionInput,
    ): Effect.Effect<
      Connection,
      | IntegrationNotFoundError
      | CredentialProviderNotRegisteredError
      | InvalidConnectionInputError
      | StorageFailure
    > =>
      Effect.gen(function* () {
        const name = connectionIdentifier(String(input.name));
        // Typed (not StorageError) so the HTTP edge can answer 400 with the
        // reason instead of an opaque 500 — callers can act on it.
        if (input.owner === "user" && subject == null) {
          return yield* new InvalidConnectionInputError({
            message:
              'Cannot create a personal connection: this context has no user subject. Create it with owner "org", or connect as a signed-in user.',
          });
        }
        const integrationRow = yield* findIntegrationRow(input.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({
            slug: input.integration,
          });
        }

        // Resolve the value origin(s) → one provider + an item_ids map (one entry
        // per named input). All of a connection's inputs share a single provider:
        // pasted inputs go to the default writable store, external `from` inputs to
        // their provider. Mixing pasted + external, or two external providers, is
        // rejected (the connection row carries one `provider`).
        const inputs = normalizeConnectionInputs(input);
        const pasted = inputs.filter((i) => "value" in i.origin);
        const external = inputs.filter((i) => "from" in i.origin);
        // A credentialed connection is born wired: it must reference at least
        // one credential input. An empty binding (no inputs at all — e.g. an
        // empty `values`/`inputs` map) is a credential with no credential: it
        // would persist, produce a full tool catalog, and then fail every
        // invocation with `connection_value_missing`. Reject it here — EXCEPT
        // for the no-auth template ("none"), where zero inputs and an empty
        // `item_ids` map are the canonical shape (public MCP servers; the UI
        // submits `values: {}` for them). OAuth connections are minted via
        // `mintOAuthConnection`, not this path; an external `from` reference
        // may resolve to null and is surfaced at invoke time, not here.
        const isNoAuth = String(input.template) === String(NO_AUTH_TEMPLATE);
        if (inputs.length === 0 && !isNoAuth) {
          return yield* new InvalidConnectionInputError({
            message: "A connection must supply at least one credential input.",
          });
        }
        let providerKey: string;
        const itemIds: Record<string, string> = {};
        if (external.length > 0 && pasted.length > 0) {
          return yield* new InvalidConnectionInputError({
            message: "A connection cannot mix pasted and external-provider inputs.",
          });
        }
        if (external.length > 0) {
          const providers = new Set(
            external.map((i) => ("from" in i.origin ? String(i.origin.from.provider) : "")),
          );
          if (providers.size > 1) {
            return yield* new InvalidConnectionInputError({
              message: "A connection's inputs must all use the same external provider.",
            });
          }
          const [only] = [...providers];
          const provider = credentialProviders.get(only ?? "");
          if (!provider) {
            return yield* new CredentialProviderNotRegisteredError({
              provider: ProviderKey.make(only ?? ""),
            });
          }
          providerKey = only ?? "";
          for (const i of external) {
            if ("from" in i.origin) itemIds[i.variable] = String(i.origin.from.id);
          }
        } else {
          const provider = defaultWritableProvider();
          if (!provider) {
            return yield* new CredentialProviderNotRegisteredError({
              provider: ProviderKey.make("default"),
            });
          }
          providerKey = String(provider.key);
          for (const i of pasted) {
            const itemId = `connection:${input.owner}:${input.integration}:${name}:${i.variable}`;
            if ("value" in i.origin && provider.set) {
              yield* provider.set(ProviderItemId.make(itemId), i.origin.value);
            }
            itemIds[i.variable] = itemId;
          }
        }

        const keys = yield* Effect.try({
          try: () => ownedKeys(input.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const now = new Date();
        yield* transaction(
          Effect.gen(function* () {
            const existing = yield* findConnectionRow({
              owner: input.owner,
              integration: input.integration,
              name,
            });
            const set: Record<string, unknown> = {
              template: String(input.template),
              provider: providerKey,
              item_ids: itemIds,
              identity_label: input.identityLabel ?? null,
              // Re-saving a credential keeps an existing curated description
              // unless the caller explicitly provides one.
              ...(input.description !== undefined ? { description: input.description } : {}),
              updated_at: now,
            };
            if (existing) {
              yield* core.updateMany("connection", {
                where: (b: AnyCb) =>
                  b.and(
                    byOwner(input.owner)(b),
                    b("integration", "=", String(input.integration)),
                    b("name", "=", String(name)),
                  ),
                set,
              });
            } else {
              yield* core.create("connection", {
                tenant: keys.tenant,
                owner: keys.owner,
                subject: keys.subject,
                integration: String(input.integration),
                name: String(name),
                template: String(input.template),
                provider: providerKey,
                item_ids: itemIds,
                identity_label: input.identityLabel ?? null,
                description: input.description ?? null,
                oauth_client: null,
                refresh_item_id: null,
                expires_at: null,
                oauth_scope: null,
                provider_state: null,
                created_at: now,
                updated_at: now,
              });
            }
          }),
        );

        const ref: ConnectionRef = {
          owner: input.owner,
          integration: input.integration,
          name,
        };
        // Produce + persist tools for the new connection.
        yield* produceConnectionTools(integrationRow, ref).pipe(
          Effect.catchTag("IntegrationNotFoundError", () => Effect.succeed([] as readonly Tool[])),
        );

        const row = yield* findConnectionRow(ref);
        return row
          ? rowToConnection(row)
          : rowToConnection({
              tenant: keys.tenant,
              owner: keys.owner,
              subject: keys.subject,
              integration: String(input.integration),
              name: String(name),
              template: String(input.template),
              provider: providerKey,
              item_ids: itemIds,
              identity_label: input.identityLabel ?? null,
              description: input.description ?? null,
              oauth_client: null,
              refresh_item_id: null,
              expires_at: null,
              oauth_scope: null,
              provider_state: null,
              created_at: now,
              updated_at: now,
            } as ConnectionRow);
      });

    // Mint (or re-mint) an OAuth connection: write the connection row with its
    // OAuth lifecycle fields (the access token is already stored in the provider
    // by the OAuth service) + produce the connection's tools. Mirrors
    // `connectionsCreate`'s upsert + tool-production, stamping the OAuth columns.
    const mintOAuthConnection = (
      input: MintOAuthConnectionInput,
    ): Effect.Effect<Connection, StorageFailure> =>
      Effect.gen(function* () {
        const name = connectionIdentifier(String(input.name));
        yield* requireUserSubject(input.owner);
        const integrationRow = yield* findIntegrationRow(input.integration);
        if (!integrationRow) {
          return yield* new StorageError({
            message: `Integration not found: ${input.integration}`,
            cause: undefined,
          });
        }
        const keys = yield* Effect.try({
          try: () => ownedKeys(input.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const now = new Date();
        const ref: ConnectionRef = {
          owner: input.owner,
          integration: input.integration,
          name,
        };
        yield* transaction(
          Effect.gen(function* () {
            const existing = yield* findConnectionRow(ref);
            const set: Record<string, unknown> = {
              template: String(input.template),
              provider: input.provider,
              item_ids: { [PRIMARY_INPUT_VARIABLE]: input.itemId },
              identity_label: input.identityLabel ?? null,
              oauth_client: String(input.oauthClient),
              oauth_client_owner: input.oauthClientOwner,
              refresh_item_id: input.refreshItemId,
              expires_at: input.expiresAt,
              oauth_scope: input.oauthScope,
              oauth_token_url: input.oauthTokenUrl ?? null,
              provider_state:
                input.missingOAuthScopes && input.missingOAuthScopes.length > 0
                  ? { missingOAuthScopes: input.missingOAuthScopes }
                  : null,
              updated_at: now,
            };
            if (existing) {
              yield* core.updateMany("connection", {
                where: (b: AnyCb) =>
                  b.and(
                    byOwner(input.owner)(b),
                    b("integration", "=", String(input.integration)),
                    b("name", "=", String(name)),
                  ),
                set,
              });
            } else {
              yield* core.create("connection", {
                tenant: keys.tenant,
                owner: keys.owner,
                subject: keys.subject,
                integration: String(input.integration),
                name: String(name),
                template: String(input.template),
                provider: input.provider,
                item_ids: { [PRIMARY_INPUT_VARIABLE]: input.itemId },
                identity_label: input.identityLabel ?? null,
                // Curated description: never stamped by a mint — a reconnect
                // or token refresh must not erase what the user wrote.
                description: null,
                oauth_client: String(input.oauthClient),
                oauth_client_owner: input.oauthClientOwner,
                refresh_item_id: input.refreshItemId,
                expires_at: input.expiresAt,
                oauth_scope: input.oauthScope,
                oauth_token_url: input.oauthTokenUrl ?? null,
                provider_state:
                  input.missingOAuthScopes && input.missingOAuthScopes.length > 0
                    ? { missingOAuthScopes: input.missingOAuthScopes }
                    : null,
                created_at: now,
                updated_at: now,
              });
            }
          }),
        );

        // Produce + persist tools for the minted connection (same path
        // connections.create uses).
        yield* produceConnectionTools(integrationRow, ref).pipe(
          Effect.catchTag("IntegrationNotFoundError", () => Effect.succeed([] as readonly Tool[])),
        );

        const row = yield* findConnectionRow(ref);
        return row
          ? rowToConnection(row)
          : rowToConnection({
              tenant: keys.tenant,
              owner: keys.owner,
              subject: keys.subject,
              integration: String(input.integration),
              name: String(name),
              template: String(input.template),
              provider: input.provider,
              item_ids: { [PRIMARY_INPUT_VARIABLE]: input.itemId },
              identity_label: input.identityLabel ?? null,
              description: null,
              oauth_client: String(input.oauthClient),
              oauth_client_owner: input.oauthClientOwner,
              refresh_item_id: input.refreshItemId,
              expires_at: input.expiresAt,
              oauth_scope: input.oauthScope,
              oauth_token_url: input.oauthTokenUrl ?? null,
              provider_state:
                input.missingOAuthScopes && input.missingOAuthScopes.length > 0
                  ? { missingOAuthScopes: input.missingOAuthScopes }
                  : null,
              created_at: now,
              updated_at: now,
            } as ConnectionRow);
      });

    const connectionsList = (filter?: {
      readonly integration?: IntegrationSlug;
      readonly owner?: Owner;
    }): Effect.Effect<readonly Connection[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              filter?.integration === undefined
                ? true
                : b("integration", "=", String(filter.integration)),
              filter?.owner === undefined ? true : b("owner", "=", filter.owner),
            ),
        });
        const connections = rows.map(rowToConnection);
        if (!activeToolPolicyProvider) return connections;

        const visibleTools = yield* toolsList({ includeAnnotations: false });
        const visibleConnectionKeys = new Set(
          visibleTools
            .filter((tool) => !tool.static)
            .map((tool) => `${tool.owner}:${tool.integration}:${tool.connection}`),
        );
        return connections.filter((connection) =>
          visibleConnectionKeys.has(
            `${connection.owner}:${connection.integration}:${connection.name}`,
          ),
        );
      });

    const connectionsGet = (ref: ConnectionRef): Effect.Effect<Connection | null, StorageFailure> =>
      findConnectionRow(ref).pipe(Effect.map((row) => (row ? rowToConnection(row) : null)));

    const connectionsUpdate = (
      ref: ConnectionRef,
      input: UpdateConnectionInput,
    ): Effect.Effect<Connection, ConnectionNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findConnectionRow(ref);
        if (!row) {
          return yield* new ConnectionNotFoundError({
            owner: ref.owner,
            integration: ref.integration,
            name: ref.name,
          });
        }
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (input.description !== undefined) set.description = input.description;
        if (input.identityLabel !== undefined) set.identity_label = input.identityLabel;
        yield* core.updateMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(ref.owner)(b),
              b("integration", "=", String(ref.integration)),
              b("name", "=", String(ref.name)),
            ),
          set,
        });
        const updated = yield* findConnectionRow(ref);
        return rowToConnection(updated ?? row);
      });

    const connectionsRemove = (
      ref: ConnectionRef,
    ): Effect.Effect<void, ConnectionNotFoundError | StorageFailure> =>
      transaction(
        Effect.gen(function* () {
          const row = yield* findConnectionRow(ref);
          if (!row) {
            return yield* new ConnectionNotFoundError({
              owner: ref.owner,
              integration: ref.integration,
              name: ref.name,
            });
          }
          const integrationRow = yield* findIntegrationRow(ref.integration);
          const runtime = integrationRow ? runtimes.get(integrationRow.plugin_id) : undefined;
          if (integrationRow && runtime?.plugin.removeConnection) {
            yield* runtime.plugin
              .removeConnection({
                ctx: runtime.ctx,
                integration: ref.integration,
                connection: ref,
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(integrationRow.plugin_id, "removeConnection", cause),
                ),
              );
          }
          const where = (b: AnyCb) =>
            b.and(
              byOwner(ref.owner)(b),
              b("integration", "=", String(ref.integration)),
              b("connection", "=", String(ref.name)),
            );
          yield* core.deleteMany("tool", { where });
          yield* core.deleteMany("definition", { where });
          yield* core.deleteMany("connection", {
            where: (b: AnyCb) =>
              b.and(
                byOwner(ref.owner)(b),
                b("integration", "=", String(ref.integration)),
                b("name", "=", String(ref.name)),
              ),
          });
        }),
      );

    const connectionsRefresh = (
      ref: ConnectionRef,
    ): Effect.Effect<
      readonly Tool[],
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    > =>
      Effect.gen(function* () {
        const row = yield* findConnectionRow(ref);
        if (!row) {
          return yield* new ConnectionNotFoundError({
            owner: ref.owner,
            integration: ref.integration,
            name: ref.name,
          });
        }
        const integrationRow = yield* findIntegrationRow(ref.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({ slug: ref.integration });
        }
        return yield* produceConnectionTools(integrationRow, ref);
      });

    // No health-check capability ⇒ "unknown" rather than an error: the caller
    // can still render the connection, just without a liveness verdict.
    const unknownHealth = (): HealthCheckResult => ({ status: "unknown", checkedAt: Date.now() });

    const persistHealthResult = (
      ref: ConnectionRef,
      result: HealthCheckResult,
    ): Effect.Effect<void, never> =>
      core
        .updateMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              b("owner", "=", String(ref.owner)),
              b("integration", "=", String(ref.integration)),
              b("name", "=", String(ref.name)),
            ),
          set: { last_health: result, updated_at: new Date() },
        })
        .pipe(Effect.ignore);

    const healthFromCredentialResolutionError = (
      err: CredentialResolutionError,
    ): Effect.Effect<HealthCheckResult, StorageFailure> =>
      err.reauthRequired === true
        ? Effect.succeed({
            status: "expired",
            checkedAt: Date.now(),
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
            detail: err.message,
          })
        : Effect.fail(
            new StorageError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
              message: err.message,
              cause: err,
            }),
          );

    const healthFromCredentialResolutionFailure = (
      failure: CredentialResolutionError,
    ): HealthCheckResult =>
      failure.reauthRequired === true
        ? {
            status: "expired",
            checkedAt: Date.now(),
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
            detail: failure.message,
          }
        : {
            status: "degraded",
            checkedAt: Date.now(),
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
            detail: failure.message,
          };

    // Genuine storage failures propagate: an infra blip must fail the request,
    // not persist as a "degraded" verdict on the connection.
    const oauthCredentialHealthWithoutProbe = (
      row: ConnectionRow,
    ): Effect.Effect<HealthCheckResult, StorageFailure> =>
      resolveConnectionValues(row).pipe(
        Effect.as({
          status: "healthy" as const,
          checkedAt: Date.now(),
          detail: "Credential resolved (no probe configured).",
        }),
        Effect.catchTag("CredentialResolutionError", (failure) =>
          Effect.succeed(healthFromCredentialResolutionFailure(failure)),
        ),
      );

    // Resolve an in-flight credential's value map (key-first validation) without
    // saving anything. Mirrors `resolveConnectionValues` for the saved-row path:
    // pasted `value`/`values` are used directly; `from` origins resolve through
    // their provider. Single-secret sugar lands on the `token` variable.
    const resolveInFlightValues = (
      input: ConnectionValueInput,
    ): Effect.Effect<Record<string, string | null>, StorageFailure> =>
      Effect.gen(function* () {
        const out: Record<string, string | null> = {};
        for (const { variable, origin } of normalizeConnectionInputs(input)) {
          if ("value" in origin) {
            out[variable] = origin.value;
            continue;
          }
          const provider = credentialProviders.get(String(origin.from.provider));
          if (!provider) {
            return yield* new StorageError({
              message: `Credential provider "${origin.from.provider}" is not registered.`,
              cause: undefined,
            });
          }
          out[variable] = yield* provider.get(origin.from.id);
        }
        return out;
      });

    const connectionCheckHealth = (
      ref: ConnectionRef,
      options?: {
        /** Skip the probe and return the persisted verdict when it is younger
         *  than this. The server owns the freshness decision so N open tabs
         *  revalidating on load cannot stampede an upstream. Omit = always
         *  probe (the manual "Check now"). */
        readonly ifStaleMs?: number;
      },
    ): Effect.Effect<
      HealthCheckResult,
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    > =>
      Effect.gen(function* () {
        const connectionRow = yield* findConnectionRow(ref);
        if (!connectionRow) {
          return yield* new ConnectionNotFoundError({
            owner: ref.owner,
            integration: ref.integration,
            name: ref.name,
          });
        }
        if (options?.ifStaleMs !== undefined) {
          const cached = Option.getOrNull(decodeLastHealth(connectionRow.last_health));
          if (cached && Date.now() - cached.checkedAt < options.ifStaleMs) return cached;
        }
        const integrationRow = yield* findIntegrationRow(ref.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({ slug: ref.integration });
        }
        const runtime = runtimes.get(integrationRow.plugin_id);
        const check = runtime?.plugin.checkHealth;
        if (!runtime || !check) return unknownHealth();
        const spec = describeHealthCheckForRow(integrationRow) ?? undefined;
        if (spec === undefined && connectionRow.oauth_client != null) {
          const result = yield* oauthCredentialHealthWithoutProbe(connectionRow);
          yield* persistHealthResult(ref, result);
          return result;
        }

        const result = yield* Effect.gen(function* () {
          const values = yield* resolveConnectionValues(connectionRow);
          const record = rowToIntegrationRecord(
            integrationRow,
            describeAuthMethodsForRow(integrationRow),
          );
          const grantedScopes = grantedScopesFromRow(connectionRow);
          const credential: ToolInvocationCredential = {
            owner: connectionRow.owner as Owner,
            integration: ref.integration,
            connection: ConnectionName.make(connectionRow.name),
            template: AuthTemplateSlug.make(connectionRow.template),
            value: values[PRIMARY_INPUT_VARIABLE] ?? null,
            values,
            config: record.config,
            ...(grantedScopes ? { grantedScopes } : {}),
          };
          // Core resolves the declared spec (its own column) and hands it to the
          // plugin; plugins no longer read it out of their config.
          return yield* foldPluginFailure(
            check({ ctx: runtime.ctx, integration: record, credential, spec }),
            `Health check for connection "${ref.name}" failed.`,
          );
        }).pipe(Effect.catchTag("CredentialResolutionError", healthFromCredentialResolutionError));
        // Persist the verdict on the connection row so the accounts list shows
        // alive/expired at a glance. Best-effort: a write failure must not turn
        // a successful probe into an error.
        yield* persistHealthResult(ref, result);
        return result;
      });

    const connectionValidate = (
      input: ValidateConnectionInput,
    ): Effect.Effect<HealthCheckResult, IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const integrationRow = yield* findIntegrationRow(input.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({ slug: input.integration });
        }
        const runtime = runtimes.get(integrationRow.plugin_id);
        const check = runtime?.plugin.checkHealth;
        if (!runtime || !check) return unknownHealth();

        const values = yield* resolveInFlightValues(input);
        const record = rowToIntegrationRecord(
          integrationRow,
          describeAuthMethodsForRow(integrationRow),
        );
        const credential: ToolInvocationCredential = {
          owner: input.owner,
          integration: input.integration,
          // No connection exists yet (key-first); a synthetic name keeps the
          // credential shape whole. The probe authenticates on values+template,
          // not on this name (it only appears in upstream-error messages).
          connection: ConnectionName.make("(unsaved)"),
          template: input.template,
          value: values[PRIMARY_INPUT_VARIABLE] ?? null,
          values,
          config: record.config,
        };
        // Caller override (editor preview) wins; otherwise the declared spec
        // from the integration row. Nothing persists here: validate is the
        // key-first flow's dry run.
        const spec = input.spec ?? describeHealthCheckForRow(integrationRow) ?? undefined;
        return yield* foldPluginFailure(
          check({ ctx: runtime.ctx, integration: record, credential, spec }),
          `Validating credential for "${input.integration}" failed.`,
        );
      });

    // Clear the sync stamp so the next tools read re-produces this connection's
    // catalog. The deferred variant of `connectionsRefresh` for signals that
    // arrive mid-invocation (an MCP `notifications/tools/list_changed`, an
    // unknown-tool rejection) where re-listing inline would block the caller.
    const connectionsMarkToolsStale = (ref: ConnectionRef): Effect.Effect<void, StorageFailure> =>
      core.updateMany("connection", {
        where: (b: AnyCb) =>
          b.and(
            byOwner(ref.owner)(b),
            b("integration", "=", String(ref.integration)),
            b("name", "=", String(ref.name)),
          ),
        set: { tools_synced_at: null },
      });

    // ------------------------------------------------------------------
    // Active policy source.
    // ------------------------------------------------------------------

    type ActivePolicyRuleSet =
      | { readonly kind: "global"; readonly rows: readonly ToolPolicyRow[] }
      | {
          readonly kind: "provider";
          readonly provider: ToolPolicyProvider;
          readonly rules: readonly ToolPolicyProviderRule[] | null;
        }
      | {
          readonly kind: "prepared";
          readonly resolve: (input: {
            readonly toolId: string;
            readonly defaultRequiresApproval?: boolean;
          }) => EffectivePolicy;
        };

    const compareProviderPolicyRule = (
      a: ToolPolicyProviderRule,
      b: ToolPolicyProviderRule,
    ): number => {
      if (a.position < b.position) return -1;
      if (a.position > b.position) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };

    const resolveProviderPolicyFromRules = (
      toolId: string,
      rules: readonly ToolPolicyProviderRule[],
    ): EffectivePolicy => {
      for (const rule of [...rules].sort(compareProviderPolicyRule)) {
        if (!matchPattern(rule.pattern, toolId)) continue;
        return {
          action: rule.action,
          source: "user",
          pattern: rule.pattern,
          policyId: rule.id,
        };
      }
      // Toolkit-style providers are capability allowlists. No matching rule
      // means the tool is outside the capability boundary.
      return {
        action: "block",
        source: "user",
        pattern: "*",
      };
    };

    const listActivePolicyRuleSet = (): Effect.Effect<ActivePolicyRuleSet, StorageFailure> =>
      activeToolPolicyProvider
        ? // Batched per-operation resolver: fetch all policy + connection state
          // once, then resolve every tool in this operation against that
          // snapshot. Avoids the per-tool resolve N+1 on the list surface.
          activeToolPolicyProvider.prepare
          ? activeToolPolicyProvider
              .prepare()
              .pipe(Effect.map((resolve) => ({ kind: "prepared" as const, resolve })))
          : activeToolPolicyProvider.resolve
            ? Effect.succeed({
                kind: "provider" as const,
                provider: activeToolPolicyProvider,
                rules: null,
              })
            : activeToolPolicyProvider.list().pipe(
                Effect.map((rules) => ({
                  kind: "provider" as const,
                  provider: activeToolPolicyProvider!,
                  rules,
                })),
              )
        : core
            .findMany("tool_policy", {})
            .pipe(Effect.map((rows) => ({ kind: "global" as const, rows })));

    const resolvePolicyFromRuleSet = (
      toolId: string,
      ruleSet: ActivePolicyRuleSet,
      defaultRequiresApproval?: boolean,
    ): Effect.Effect<EffectivePolicy, StorageFailure> =>
      ruleSet.kind === "prepared"
        ? Effect.succeed(ruleSet.resolve({ toolId, defaultRequiresApproval }))
        : ruleSet.kind === "provider"
          ? ruleSet.provider.resolve
            ? ruleSet.provider.resolve({ toolId, defaultRequiresApproval })
            : Effect.succeed(resolveProviderPolicyFromRules(toolId, ruleSet.rules ?? []))
          : Effect.succeed(
              resolveEffectivePolicy(
                toolId,
                ruleSet.rows,
                ownerRankForRow,
                defaultRequiresApproval,
              ),
            );

    // ------------------------------------------------------------------
    // Tools (read surface)
    // ------------------------------------------------------------------

    const matchesToolFilter = (tool: Tool, filter: ToolListFilter | undefined): boolean => {
      if (!filter) return true;
      if (filter.integration !== undefined && tool.integration !== filter.integration) return false;
      if (filter.owner !== undefined && tool.owner !== filter.owner) return false;
      if (filter.connection !== undefined && tool.connection !== filter.connection) return false;
      if (filter.query !== undefined) {
        const q = filter.query.toLowerCase();
        const hay = `${tool.name} ${tool.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };

    // How long a remote-catalog connection's persisted tools stay fresh
    // (`ExecutorConfig.toolsSyncTtlMs`; `null` disables time-based re-sync).
    const toolsSyncTtlMs =
      config.toolsSyncTtlMs === undefined ? DEFAULT_TOOLS_SYNC_TTL_MS : config.toolsSyncTtlMs;

    // Rebuild any visible connection whose persisted tool catalog is stale.
    // Three triggers:
    //  - stale-marked: `tools_synced_at` is NULL (`connections.markToolsStale`
    //    — an MCP `tools/list_changed` notification or unknown-tool rejection
    //    cleared it mid-invocation);
    //  - config-revised: the integration's last tool-affecting config change
    //    postdates the connection's catalog. The change's author could only
    //    rewrite catalogs in their own partition (owner policy); every other
    //    subject converges here, on their own read, under their own binding;
    //  - expired: the plugin lists a live remote catalog (an MCP server, whose
    //    tool set can change with no executor-visible signal) and the catalog
    //    is older than the freshness TTL.
    // Best-effort: a failed rebuild leaves the stale-but-working catalog in
    // place and retries on the next read.
    const syncStaleConnectionTools = Effect.gen(function* () {
      const integrations = yield* core.findMany("integration", {});
      if (integrations.length === 0) return;
      const integrationBySlug = new Map(integrations.map((row) => [row.slug, row] as const));
      // The TTL only matters when a loaded plugin actually lists a live remote
      // catalog; otherwise skip it so age alone never widens the stale query.
      const anyRemoteCatalog = Array.from(runtimes.values()).some(
        (runtime) => runtime.plugin.remoteToolCatalog === true,
      );
      const cutoff =
        toolsSyncTtlMs == null || !anyRemoteCatalog ? null : Date.now() - toolsSyncTtlMs;

      // Bound the scan to potentially-stale rows: stale-marked (NULL stamp) or
      // synced before the latest instant any trigger could fire at (the TTL
      // cutoff / the newest config revision). Per-row trigger checks below
      // re-verify against each row's own integration; in steady state this
      // query returns nothing and the read pays one indexed lookup.
      const latestRevision = integrations.reduce<number | null>(
        (max, row) =>
          row.config_revised_at == null
            ? max
            : Math.max(max ?? Number(row.config_revised_at), Number(row.config_revised_at)),
        null,
      );
      const staleBefore =
        cutoff === null && latestRevision === null
          ? null
          : Math.max(cutoff ?? Number.MIN_SAFE_INTEGER, latestRevision ?? Number.MIN_SAFE_INTEGER);

      const connections = yield* core.findMany("connection", {
        where: (b: AnyCb) =>
          staleBefore === null
            ? b.isNull("tools_synced_at")
            : b.or(b.isNull("tools_synced_at"), b("tools_synced_at", "<", staleBefore)),
      });
      for (const connection of connections) {
        const integrationRow = integrationBySlug.get(connection.integration);
        if (!integrationRow) continue;
        const runtime = runtimes.get(integrationRow.plugin_id);
        // Only re-produce catalogs this executor can actually re-list —
        // rebuilding under an unloaded plugin would clear a working catalog.
        // (A loaded plugin without `resolveTools` still flows through:
        // `produceConnectionTools` runs its clear-and-stamp cleanup path.)
        if (!runtime) continue;

        const syncedAt =
          connection.tools_synced_at == null ? null : Number(connection.tools_synced_at);
        const revisedTime =
          integrationRow.config_revised_at == null
            ? null
            : Number(integrationRow.config_revised_at);

        const staleMarked = syncedAt === null;
        const configRevised = revisedTime !== null && (syncedAt ?? 0) < revisedTime;
        const expired =
          cutoff !== null &&
          runtime.plugin.remoteToolCatalog === true &&
          syncedAt !== null &&
          syncedAt < cutoff;
        if (!staleMarked && !configRevised && !expired) continue;

        yield* produceConnectionTools(
          integrationRow,
          {
            owner: connection.owner as Owner,
            integration: IntegrationSlug.make(connection.integration),
            name: ConnectionName.make(connection.name),
          },
          "background",
        ).pipe(
          Effect.catch(() => Effect.succeed([] as readonly Tool[])),
          Effect.withSpan("executor.tools.sync_stale", {
            attributes: {
              "executor.integration": connection.integration,
              "executor.connection": connection.name,
            },
          }),
        );
      }
    });

    const toolsList = (filter?: ToolListFilter): Effect.Effect<readonly Tool[], StorageFailure> =>
      Effect.gen(function* () {
        yield* syncStaleConnectionTools;
        // Projected: the list surface is metadata (address, description,
        // annotations) — loading every tool's input/output schema JSON made
        // an unbounded list scale with schema bytes, not tool count.
        const rows = yield* core.findMany("tool", {
          where: (b: AnyCb) =>
            b.and(
              filter?.integration === undefined
                ? true
                : b("integration", "=", String(filter.integration)),
              filter?.owner === undefined ? true : b("owner", "=", filter.owner),
              filter?.connection === undefined
                ? true
                : b("connection", "=", String(filter.connection)),
            ),
          select: TOOL_INVOCATION_COLUMNS,
        });
        const includeBlocked = filter?.includeBlocked ?? false;
        const policyRules = yield* listActivePolicyRuleSet();
        const tools: Tool[] = [];
        for (const row of rows) {
          const tool = rowToTool(row);
          if (!matchesToolFilter(tool, filter)) continue;
          if (!includeBlocked) {
            const effective = yield* resolvePolicyFromRuleSet(
              normalizedPolicyId(tool),
              policyRules,
              tool.annotations?.requiresApproval,
            );
            if (effective.action === "block") continue;
          }
          tools.push(tool);
        }
        for (const entry of staticTools.values()) {
          const tool = staticToolToTool(entry);
          if (!matchesToolFilter(tool, filter)) continue;
          if (!includeBlocked) {
            const effective = yield* resolvePolicyFromRuleSet(
              normalizedPolicyId(tool),
              policyRules,
              tool.annotations?.requiresApproval,
            );
            if (effective.action === "block") continue;
          }
          tools.push(tool);
        }
        return tools;
      });

    const toolSchema = (
      address: ToolAddress,
    ): Effect.Effect<ToolSchemaView | null, StorageFailure> =>
      Effect.gen(function* () {
        const policyRules = yield* listActivePolicyRuleSet();
        const staticEntry = staticTools.get(String(address));
        if (staticEntry) {
          const tool = staticToolToTool(staticEntry);
          const effective = yield* resolvePolicyFromRuleSet(
            normalizedPolicyId(tool),
            policyRules,
            tool.annotations?.requiresApproval,
          );
          if (effective.action === "block") return null;
          const preview = yield* Effect.tryPromise({
            try: () =>
              buildToolTypeScriptPreview({
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
                defs: new Map(),
              }),
            catch: (cause) =>
              storageFailureFromUnknown("Failed to build static tool TypeScript preview", cause),
          }).pipe(Effect.option);
          return ToolSchemaView.make({
            address,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            inputTypeScript: Option.getOrUndefined(preview)?.inputTypeScript,
            outputTypeScript: Option.getOrUndefined(preview)?.outputTypeScript,
            typeScriptDefinitions: Option.getOrUndefined(preview)?.typeScriptDefinitions,
          });
        }

        const parsed = parseToolAddress(String(address));
        if (!parsed) return null;
        const row = yield* core.findFirst("tool", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(parsed.owner)(b),
              b("integration", "=", String(parsed.integration)),
              b("connection", "=", String(parsed.connection)),
              b("name", "=", String(parsed.tool)),
            ),
        });
        if (!row) return null;
        const tool = rowToTool(row);
        const effective = yield* resolvePolicyFromRuleSet(
          normalizedPolicyId(tool),
          policyRules,
          tool.annotations?.requiresApproval,
        );
        if (effective.action === "block") return null;

        const runtime = runtimes.get(row.plugin_id);
        const projected = runtime?.plugin.projectToolSchema
          ? yield* runtime.plugin
              .projectToolSchema({
                ctx: runtime.ctx,
                toolRow: row,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(row.plugin_id, "projectToolSchema", cause),
                ),
              )
          : null;
        const inputSchema =
          projected && Object.prototype.hasOwnProperty.call(projected, "inputSchema")
            ? projected.inputSchema
            : tool.inputSchema;
        const outputSchema =
          projected && Object.prototype.hasOwnProperty.call(projected, "outputSchema")
            ? projected.outputSchema
            : tool.outputSchema;

        const definitionRows = yield* core.findMany("definition", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(parsed.owner)(b),
              b("integration", "=", String(parsed.integration)),
              b("connection", "=", String(parsed.connection)),
            ),
        });
        const defs = new Map<string, unknown>();
        for (const def of definitionRows) defs.set(def.name, decodeJsonColumn(def.schema));

        const referenced = collectReferencedDefinitions([inputSchema, outputSchema], defs);
        const preview = yield* Effect.tryPromise({
          try: () =>
            buildToolTypeScriptPreview({
              inputSchema,
              outputSchema,
              defs,
            }),
          catch: (cause) =>
            storageFailureFromUnknown("Failed to build tool TypeScript preview", cause),
        }).pipe(Effect.option);

        const view = preview;
        return ToolSchemaView.make({
          address,
          name: tool.name,
          description: tool.description,
          inputSchema,
          outputSchema,
          schemaDefinitions:
            Object.keys(referenced).length > 0
              ? (referenced as Record<string, unknown>)
              : undefined,
          inputTypeScript: Option.getOrUndefined(view)?.inputTypeScript,
          outputTypeScript: Option.getOrUndefined(view)?.outputTypeScript,
          typeScriptDefinitions: Option.getOrUndefined(view)?.typeScriptDefinitions,
        });
      });

    // ------------------------------------------------------------------
    // Providers
    // ------------------------------------------------------------------

    const providersList = (): Effect.Effect<readonly ProviderKey[]> =>
      Effect.sync(() => credentialProviderOrder.map((key) => ProviderKey.make(key)));

    const providersItems = (
      key: ProviderKey,
    ): Effect.Effect<readonly ProviderEntry[], StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider || !provider.list) return [];
        return yield* provider.list();
      });

    const providersGet = (
      key: ProviderKey,
      id: ProviderItemId,
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider) return null;
        return yield* provider.get(id);
      });

    const providersHas = (
      key: ProviderKey,
      id: ProviderItemId,
    ): Effect.Effect<boolean, StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider) return false;
        if (provider.has) return yield* provider.has(id);
        const value = yield* provider.get(id);
        return value !== null;
      });

    const providersSetDefault = (
      id: ProviderItemId,
      value: string,
    ): Effect.Effect<ProviderKey, CredentialProviderNotRegisteredError | StorageFailure> =>
      Effect.gen(function* () {
        const provider = defaultWritableProvider();
        if (!provider || !provider.set) {
          return yield* new CredentialProviderNotRegisteredError({
            provider: ProviderKey.make("default"),
          });
        }
        yield* provider.set(id, value);
        return provider.key;
      });

    const providersRemove = (
      key: ProviderKey,
      id: ProviderItemId,
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider || !provider.delete) return;
        yield* provider.delete(id);
      });

    // ------------------------------------------------------------------
    // Policies — owner-ranked (user=0 inner, org=1 outer).
    // ------------------------------------------------------------------

    const ownerRankForRow = (row: { readonly owner: string }): number =>
      row.owner === "user" ? 0 : 1;

    // Tool policies gate by tool identity (`<integration>.<tool>`), independent of
    // which connection serves it; the org/user split is handled by owner-scoped
    // policy rows + ownerRank, not the match pattern.
    const normalizedPolicyId = (tool: Tool): string =>
      tool.static
        ? String(tool.address)
        : `${tool.integration}.${tool.owner}.${tool.connection}.${tool.name}`;

    const policiesList = (): Effect.Effect<readonly ToolPolicy[], StorageFailure> =>
      core
        .findMany("tool_policy", {})
        .pipe(
          Effect.map((rows) =>
            [...rows]
              .sort((a, b) => ownerRankForRow(a) - ownerRankForRow(b) || comparePolicyRow(a, b))
              .map(rowToToolPolicy),
          ),
        );

    const policiesCreate = (
      input: CreateToolPolicyInput,
    ): Effect.Effect<ToolPolicy, StorageFailure> =>
      Effect.gen(function* () {
        if (!isValidPattern(input.pattern)) {
          return yield* new StorageError({
            message: `Invalid tool policy pattern: ${input.pattern}`,
            cause: undefined,
          });
        }
        if (!isToolPolicyAction(input.action)) {
          return yield* new StorageError({
            message: `Invalid tool policy action: ${String(input.action)}`,
            cause: undefined,
          });
        }
        yield* requireUserSubject(input.owner);
        const keys = yield* Effect.try({
          try: () => ownedKeys(input.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const existing = yield* core.findMany("tool_policy", {
          where: byOwner(input.owner),
        });
        // Default placement is specificity-aware (below any more-specific
        // rule), not top-of-list: a client that omits position — the UI when
        // its policy list is stale, the API, an agent tool — must not have its
        // broad rule silently shadow an existing narrow one.
        const position = input.position ?? positionForNewPattern(input.pattern, existing);
        const id = PolicyId.make(
          `pol_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
        );
        const now = new Date();
        const created = yield* core.create("tool_policy", {
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          id: String(id),
          pattern: input.pattern,
          action: input.action,
          position,
          created_at: now,
          updated_at: now,
        });
        return rowToToolPolicy(created);
      });

    const policiesUpdate = (
      input: UpdateToolPolicyInput,
    ): Effect.Effect<ToolPolicy, StorageFailure> =>
      Effect.gen(function* () {
        if (input.pattern !== undefined && !isValidPattern(input.pattern)) {
          return yield* new StorageError({
            message: `Invalid tool policy pattern: ${input.pattern}`,
            cause: undefined,
          });
        }
        const where = (b: AnyCb) => b.and(byOwner(input.owner)(b), b("id", "=", input.id));
        const existing = yield* core.findFirst("tool_policy", { where });
        if (!existing) {
          return yield* new StorageError({
            message: `Tool policy not found: ${input.id}`,
            cause: undefined,
          });
        }
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (input.pattern !== undefined) set.pattern = input.pattern;
        if (input.action !== undefined) set.action = input.action;
        if (input.position !== undefined) set.position = input.position;
        yield* core.updateMany("tool_policy", { where, set });
        const updated = yield* core.findFirst("tool_policy", { where });
        return rowToToolPolicy(updated ?? ({ ...existing, ...set } as ToolPolicyRow));
      });

    const policiesRemove = (input: RemoveToolPolicyInput): Effect.Effect<void, StorageFailure> =>
      core.deleteMany("tool_policy", {
        where: (b: AnyCb) => b.and(byOwner(input.owner)(b), b("id", "=", input.id)),
      });

    const policiesResolve = (
      address: ToolAddress,
    ): Effect.Effect<EffectivePolicy, StorageFailure> =>
      Effect.gen(function* () {
        const parsed = parseToolAddress(String(address));
        const policyRows = yield* core.findMany("tool_policy", {});
        const toolId = parsed
          ? `${parsed.integration}.${parsed.owner}.${parsed.connection}.${parsed.tool}`
          : String(address);
        // Find the tool to read its default approval annotation.
        let requiresApproval: boolean | undefined;
        if (parsed) {
          const row = yield* core.findFirst("tool", {
            where: (b: AnyCb) =>
              b.and(
                byOwner(parsed.owner)(b),
                b("integration", "=", String(parsed.integration)),
                b("connection", "=", String(parsed.connection)),
                b("name", "=", String(parsed.tool)),
              ),
          });
          if (row) {
            const annotations = decodeJsonColumn(row.annotations) as ToolAnnotations | undefined;
            requiresApproval = annotations?.requiresApproval;
          }
        }
        return resolveEffectivePolicy(toolId, policyRows, ownerRankForRow, requiresApproval);
      });

    // ------------------------------------------------------------------
    // Elicitation
    // ------------------------------------------------------------------

    const defaultElicitationHandler = resolveElicitationHandler(config.onElicitation);

    const pickHandler = (options: InvokeOptions | undefined): ElicitationHandler =>
      options?.onElicitation
        ? resolveElicitationHandler(options.onElicitation)
        : defaultElicitationHandler;

    const buildElicit = (
      address: ToolAddress,
      args: unknown,
      handler: ElicitationHandler,
    ): Elicit => {
      return (request: ElicitationRequest) =>
        Effect.gen(function* () {
          const response: ElicitationResponse = yield* handler({
            address,
            args,
            request,
          });
          if (response.action !== "accept") {
            return yield* new ElicitationDeclinedError({
              address,
              action: response.action,
            });
          }
          return response;
        });
    };

    // The single source of truth for "will enforceApproval pause this call".
    // Read before pre-approval arg validation so the extra validation pass
    // only runs for calls that would otherwise burn a user approval.
    const approvalRequired = (
      annotations: ToolAnnotations | undefined,
      policy: EffectivePolicy,
    ): boolean => {
      if (policy.action === "approve") return false;
      return policy.action === "require_approval" || annotations?.requiresApproval === true;
    };

    const enforceApproval = (
      annotations: ToolAnnotations | undefined,
      address: ToolAddress,
      args: unknown,
      policy: EffectivePolicy,
      handler: ElicitationHandler,
    ): Effect.Effect<"not_required" | "approved", ElicitationDeclinedError> =>
      Effect.gen(function* () {
        if (!approvalRequired(annotations, policy)) return "not_required" as const;
        const policyForcesApproval = policy.action === "require_approval";
        const message = annotations?.approvalDescription
          ? annotations.approvalDescription
          : policyForcesApproval && policy.pattern
            ? `Approve ${address}? (matched policy: ${policy.pattern})`
            : `Approve ${address}?`;
        const request = FormElicitation.make({
          message: `${message}\n\nArguments:\n${approvalArgumentPreview(args)}`,
          requestedSchema: { type: "object", properties: {} },
        });
        const response = yield* handler({ address, args, request });
        if (response.action !== "accept") {
          return yield* new ElicitationDeclinedError({
            address,
            action: response.action,
          });
        }
        return "approved" as const;
      });

    // ------------------------------------------------------------------
    // execute — the invoke path.
    // ------------------------------------------------------------------

    const TOOL_SUGGESTION_LIMIT = 5;

    const toolSuggestions = (rows: readonly ToolInvocationRow[]): readonly ToolAddress[] =>
      rows.map((row) => rowToTool(row).address);

    const toolRowsForConnectionWhere = (parsed: ParsedToolAddress) => (b: AnyCb) =>
      b.and(
        byOwner(parsed.owner)(b),
        b("integration", "=", String(parsed.integration)),
        b("connection", "=", String(parsed.connection)),
      );

    const searchToolRowsForConnection = (
      parsed: ParsedToolAddress,
    ): Effect.Effect<readonly ToolInvocationRow[], StorageFailure> =>
      core.findMany("tool", {
        where: (b: AnyCb) =>
          b.and(
            toolRowsForConnectionWhere(parsed)(b),
            b.or(
              b("name", "contains", String(parsed.tool)),
              b("description", "contains", String(parsed.tool)),
            ),
          ),
        orderBy: ["name", "asc"],
        limit: TOOL_SUGGESTION_LIMIT,
        select: TOOL_INVOCATION_COLUMNS,
      });

    const findToolRowsForConnection = (
      parsed: ParsedToolAddress,
    ): Effect.Effect<readonly ToolInvocationRow[], StorageFailure> =>
      core.findMany("tool", {
        where: toolRowsForConnectionWhere(parsed),
        orderBy: ["name", "asc"],
        limit: TOOL_SUGGESTION_LIMIT,
        select: TOOL_INVOCATION_COLUMNS,
      });

    type InternalOperationContext = {
      readonly executionId: string;
      readonly jobId: string;
      readonly requestSha256: string;
      readonly approvalSatisfied: boolean;
    };

    type InternalInvocationResult = {
      readonly value: unknown;
      readonly policy: EffectivePolicy;
      readonly approval: "not_required" | "approved";
      readonly provider?: unknown;
    };

    type SafeToolResultProjection =
      | { readonly ok: true; readonly data: unknown; readonly provider?: unknown }
      | { readonly ok: false; readonly error: unknown; readonly provider?: unknown }
      | { readonly ok: "invalid" };

    type DataPropertyResult =
      | { readonly ok: true; readonly present: boolean; readonly value: unknown }
      | { readonly ok: false };

    const dataProperty = (value: object, key: string): unknown | undefined => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: hostile Proxy reflection may throw; absence is the safe projection
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
      } catch {
        return undefined;
      }
    };

    const strictDataProperty = (value: object, key: string): DataPropertyResult => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: hostile Proxy reflection may throw; invalid projection is typed below
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return {
          ok: true,
          present: descriptor !== undefined && "value" in descriptor,
          value: descriptor && "value" in descriptor ? descriptor.value : undefined,
        };
      } catch {
        return { ok: false };
      }
    };

    /**
     * Read the ToolResult discriminator without invoking plugin-owned getters.
     * Operation output canonicalization performs the full strict clone later;
     * this projection only decides whether the value is a success/failure
     * wrapper and extracts data through own data descriptors.
     */
    const safeToolResultProjection = (value: unknown): SafeToolResultProjection | undefined => {
      if (typeof value !== "object" || value === null) return undefined;
      let isArray = false;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: hostile Proxy reflection may throw; invalid projection is typed below
      try {
        isArray = Array.isArray(value);
      } catch {
        return { ok: "invalid" };
      }
      if (isArray) return undefined;
      const ok = strictDataProperty(value, "ok");
      if (!ok.ok) return { ok: "invalid" };
      if (ok.value === true) {
        const dataDescriptor = strictDataProperty(value, "data");
        if (!dataDescriptor.ok || !dataDescriptor.present) return { ok: "invalid" };
        return {
          ok: true,
          data: dataDescriptor.value,
          provider: dataProperty(value, "provider"),
        };
      }
      if (ok.value === false) {
        const errorDescriptor = strictDataProperty(value, "error");
        if (!errorDescriptor.ok || !errorDescriptor.present) return { ok: "invalid" };
        return {
          ok: false,
          error: errorDescriptor.value,
          provider: dataProperty(value, "provider"),
        };
      }
      return undefined;
    };

    const providerEvidenceFromValue = (value: unknown): unknown => {
      const projection = safeToolResultProjection(value);
      return projection && projection.ok !== "invalid" ? projection.provider : undefined;
    };

    /** Operation spans never receive a plugin-controlled error code. The
     * generic invoke surface retains its historical annotation, while the
     * attested path records only the stable failure bucket. */
    const annotateInvocationOutcome = (
      value: unknown,
      isOperation: boolean,
    ): Effect.Effect<void> => {
      if (!isOperation) return annotateToolResultOutcome(value);
      const projection = safeToolResultProjection(value);
      return projection?.ok === false || projection?.ok === "invalid"
        ? Effect.annotateCurrentSpan({
            "executor.tool.outcome": "fail",
            "executor.tool.error_code": "operation_failed",
          })
        : Effect.annotateCurrentSpan({ "executor.tool.outcome": "ok" });
    };

    const policyAnnotationContext = (
      ctx: PluginCtx<unknown>,
    ): PolicyAnnotationPluginCtx<unknown> => ({
      owner: Object.freeze({ ...ctx.owner }),
      storage: makePolicyReadonlyStorage(ctx.storage),
    });

    const resolveAnnotationsWithReadonlyContext = (input: {
      readonly runtime: PluginRuntime;
      readonly integration: IntegrationSlug;
      readonly connection: ConnectionName;
      readonly toolRows: readonly ToolInvocationRow[];
    }): Effect.Effect<Record<string, ToolAnnotations>, StorageFailure> =>
      Effect.try({
        try: () =>
          input.runtime.plugin.resolveAnnotations?.({
            ctx: policyAnnotationContext(input.runtime.ctx),
            integration: input.integration,
            connection: input.connection,
            toolRows: input.toolRows,
          }),
        catch: (cause) =>
          pluginStorageFailure(input.runtime.plugin.id, "resolveAnnotations", cause),
      }).pipe(
        Effect.flatMap((resolved) => {
          if (resolved === undefined) return Effect.succeed({});
          if (!Effect.isEffect(resolved)) {
            return Effect.fail(
              pluginStorageFailure(input.runtime.plugin.id, "resolveAnnotations", resolved),
            );
          }
          return Effect.catchCause(resolved, (cause) =>
            Effect.fail(pluginStorageFailure(input.runtime.plugin.id, "resolveAnnotations", cause)),
          );
        }),
        Effect.mapError((cause) =>
          isStorageFailure(cause)
            ? cause
            : pluginStorageFailure(input.runtime.plugin.id, "resolveAnnotations", cause),
        ),
      );

    // Operation handlers receive credentials and a reviewed target from core;
    // they do not receive the executor's ambient mutation/credential surface.
    // Keep the existing PluginCtx type for generic handlers, but hand
    // operation handlers a capability facade that exposes only owner, HTTP,
    // and plugin-owned read storage. Missing capabilities fail as an opaque
    // defect and are normalized by the operation boundary.
    const operationPluginContext = (ctx: PluginCtx<unknown>): PluginCtx<unknown> => {
      const isWriteCapability = (property: PropertyKey): boolean =>
        typeof property === "string" &&
        /^(create|delete|insert|put|set|update|remove|write|save|clear|reset|replace|publish|register|upsert|patch|run|execute|transaction)/i.test(
          property,
        );
      const readOnlyStorage =
        typeof ctx.storage === "object" && ctx.storage !== null
          ? new Proxy(ctx.storage, {
              get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (typeof value !== "function") return value;
                if (isWriteCapability(property)) {
                  return undefined;
                }
                return value.bind(target);
              },
              has(target, property) {
                return !isWriteCapability(property) && Reflect.has(target, property);
              },
              ownKeys(target) {
                return Reflect.ownKeys(target).filter((property) => !isWriteCapability(property));
              },
              getOwnPropertyDescriptor(target, property) {
                return isWriteCapability(property)
                  ? undefined
                  : Reflect.getOwnPropertyDescriptor(target, property);
              },
            })
          : ctx.storage;
      const readOnlyIntegrations = new Proxy(ctx.core.integrations, {
        get(target, property, receiver) {
          if (property !== "get" && property !== "list") return undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
        has(target, property) {
          return property === "get" || property === "list";
        },
        ownKeys() {
          return ["get", "list"];
        },
        getOwnPropertyDescriptor(target, property) {
          if (property !== "get" && property !== "list") return undefined;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      const readOnlyCore = new Proxy(ctx.core, {
        get(target, property, _receiver) {
          if (property === "integrations") {
            return readOnlyIntegrations;
          }
          return undefined;
        },
        has(_target, property) {
          return property === "integrations";
        },
        ownKeys() {
          return ["integrations"];
        },
        getOwnPropertyDescriptor(target, property) {
          return property === "integrations"
            ? Reflect.getOwnPropertyDescriptor(target, property)
            : undefined;
        },
      });
      return new Proxy(ctx, {
        get(target, property, receiver) {
          if (property === "owner" || property === "httpClientLayer") {
            return Reflect.get(target, property, receiver);
          }
          if (property === "storage") return readOnlyStorage;
          if (property === "core") return readOnlyCore;
          // connections/providers/pluginStorage/policies/execute/transaction
          // are intentionally absent from this capability context.
          return undefined;
        },
        has(_target, property) {
          return (
            property === "owner" ||
            property === "httpClientLayer" ||
            property === "storage" ||
            property === "core"
          );
        },
        ownKeys() {
          return ["owner", "httpClientLayer", "storage", "core"];
        },
        getOwnPropertyDescriptor(target, property) {
          return property === "owner" ||
            property === "httpClientLayer" ||
            property === "storage" ||
            property === "core"
            ? Reflect.getOwnPropertyDescriptor(target, property)
            : undefined;
        },
      });
    };

    const executeInternal = (
      address: ToolAddress,
      args: unknown,
      options?: InvokeOptions,
      internal?: {
        readonly policy?: EffectivePolicy;
        readonly operation?: InternalOperationContext;
      },
    ): Effect.Effect<InternalInvocationResult, ExecuteError> => {
      const handler = pickHandler(options);
      return Effect.gen(function* () {
        // oxlint-disable executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-manual-tag-check -- boundary: normalize arbitrary unknown plugin failures into a human-readable message for ToolInvocationError/telemetry
        const formatInvocationCauseMessage = (cause: unknown): string => {
          if (cause instanceof Error && cause.message.length > 0) return cause.message;
          // Non-Error / empty-message causes: `String(plainObject)` renders
          // "[object Object]", which is what telemetry then shows as the only
          // label for the failure. Prefer the tag, else stringify structurally.
          if (typeof cause === "object" && cause !== null) {
            const tag = (cause as { readonly _tag?: unknown })._tag;
            if (typeof tag === "string") return tag;
            return Inspectable.toStringUnknown(cause, 0);
          }
          return String(cause);
        };
        const sanitizeInvocationCause = (
          cause: unknown,
        ): Readonly<Record<string, string | number | boolean>> => {
          if (typeof cause !== "object" || cause === null) return {};
          const status = dataProperty(cause, "status");
          return typeof status === "number" &&
            Number.isInteger(status) &&
            status >= 100 &&
            status <= 599
            ? { status }
            : {};
        };
        // oxlint-enable executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-manual-tag-check
        const wrapInvocationError = <A, E>(
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A, ToolInvocationError> =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ToolInvocationError({
                  address,
                  // Operation receipts are public and replayable; neither
                  // their span failure nor their typed cause may retain a
                  // provider message/token. Generic execution keeps its
                  // historical diagnostic cause for local callers.
                  message: internal?.operation
                    ? "Operation invocation failed."
                    : formatInvocationCauseMessage(cause),
                  cause: internal?.operation ? sanitizeInvocationCause(cause) : cause,
                }),
            ),
          );

        // Static path — O(1) map lookup for plugin-contributed static tools
        // (core-tools, plugin executor namespaces). Addressed by their fqid,
        // not the 5-segment dynamic form.
        const staticEntry = staticTools.get(String(address));
        if (staticEntry) {
          const policy =
            internal?.policy ??
            (yield* listActivePolicyRuleSet().pipe(
              Effect.flatMap((policyRules) =>
                resolvePolicyFromRuleSet(
                  String(address),
                  policyRules,
                  staticEntry.tool.annotations?.requiresApproval,
                ),
              ),
            ));
          if (policy.action === "block") {
            return yield* new ToolBlockedError({
              address,
              pattern: policy.pattern ?? "*",
            });
          }
          const approval = internal?.operation?.approvalSatisfied
            ? ("approved" as const)
            : yield* enforceApproval(
                internal?.operation ? undefined : staticEntry.tool.annotations,
                address,
                args,
                policy,
                handler,
              );
          const value = yield* wrapInvocationError(
            staticEntry.tool.handler({
              ctx: internal?.operation ? operationPluginContext(staticEntry.ctx) : staticEntry.ctx,
              args,
              elicit: buildElicit(address, args, handler),
            }),
          );
          return {
            value,
            policy,
            approval,
            provider: providerEvidenceFromValue(value),
          };
        }

        const parsed = parseToolAddress(String(address));
        if (!parsed) {
          return yield* new ToolNotFoundError({ address });
        }

        // Find the tool row — projected: invoke needs routing/policy fields
        // only, never the multi-KB input/output schema JSON (`tools.schema`
        // is the schema-bearing surface).
        const row = yield* core.findFirst("tool", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(parsed.owner)(b),
              b("integration", "=", String(parsed.integration)),
              b("connection", "=", String(parsed.connection)),
              b("name", "=", String(parsed.tool)),
            ),
          select: TOOL_INVOCATION_COLUMNS,
        });
        if (!row) {
          const searchMatches = yield* searchToolRowsForConnection(parsed);
          const connectionTools =
            searchMatches.length > 0 ? searchMatches : yield* findToolRowsForConnection(parsed);
          return yield* new ToolNotFoundError({
            address,
            suggestions: toolSuggestions(connectionTools),
          });
        }

        // Resolve policy (owner-ranked).
        const toolForPolicy = rowToTool(row);
        const annotations = decodeJsonColumn(row.annotations) as ToolAnnotations | undefined;
        const policy =
          internal?.policy ??
          (yield* listActivePolicyRuleSet().pipe(
            Effect.flatMap((policyRules) =>
              resolvePolicyFromRuleSet(
                normalizedPolicyId(toolForPolicy),
                policyRules,
                annotations?.requiresApproval,
              ),
            ),
          ));
        if (policy.action === "block") {
          return yield* new ToolBlockedError({
            address,
            pattern: policy.pattern ?? "*",
          });
        }

        const runtime = runtimes.get(row.plugin_id);
        if (!runtime) {
          return yield* new PluginNotLoadedError({
            address,
            pluginId: row.plugin_id,
          });
        }
        if (!runtime.plugin.invokeTool) {
          return yield* new NoHandlerError({
            address,
            pluginId: row.plugin_id,
          });
        }

        // Find the connection row.
        const connectionRow = yield* findConnectionRow({
          owner: parsed.owner,
          integration: parsed.integration,
          name: parsed.connection,
        });
        if (!connectionRow) {
          return yield* new ConnectionNotFoundError({
            owner: parsed.owner,
            integration: parsed.integration,
            name: parsed.connection,
          });
        }

        // Resolve annotations + enforce approval.
        let resolvedAnnotations = annotations;
        if (
          !internal?.operation &&
          policy.action !== "approve" &&
          runtime.plugin.resolveAnnotations
        ) {
          const map = yield* resolveAnnotationsWithReadonlyContext({
            runtime,
            integration: parsed.integration,
            connection: parsed.connection,
            toolRows: [row],
          }).pipe(wrapInvocationError);
          resolvedAnnotations = map[String(parsed.tool)] ?? annotations;
        }
        // When this call is about to pause for approval, validate args
        // first: a call that can only fail (missing required path param /
        // body) must be rejected here, not after the user grants an approval
        // that then goes to waste. Non-pausing calls skip this — invokeTool
        // raises the identical failure moments later without the extra pass.
        if (
          !internal?.operation &&
          approvalRequired(resolvedAnnotations, policy) &&
          runtime.plugin.validateToolArgs
        ) {
          yield* runtime.plugin
            .validateToolArgs({ ctx: runtime.ctx, toolRow: row, args })
            .pipe(wrapInvocationError);
        }
        const approval = internal?.operation?.approvalSatisfied
          ? ("approved" as const)
          : yield* enforceApproval(
              internal?.operation ? undefined : resolvedAnnotations,
              address,
              args,
              policy,
              handler,
            );

        // Resolve every named credential input (`variable → value`); `value` is
        // the primary `token` for single-input + OAuth callers.
        const values = yield* resolveConnectionValues(connectionRow);
        const integrationRow = yield* findIntegrationRow(parsed.integration);
        const grantedScopes = grantedScopesFromRow(connectionRow);
        const credential: ToolInvocationCredential = {
          owner: parsed.owner,
          integration: parsed.integration,
          connection: parsed.connection,
          template: AuthTemplateSlug.make(connectionRow.template),
          value: values[PRIMARY_INPUT_VARIABLE] ?? null,
          values,
          config: integrationRow ? decodeJsonColumn(integrationRow.config) : undefined,
          ...(grantedScopes ? { grantedScopes } : {}),
        };

        const value = yield* wrapInvocationError(
          runtime.plugin.invokeTool({
            ctx: internal?.operation ? operationPluginContext(runtime.ctx) : runtime.ctx,
            toolRow: row,
            credential,
            args,
            elicit: buildElicit(address, args, handler),
            invokeOptions: options,
          }),
        );
        return {
          value,
          policy,
          approval,
          provider: providerEvidenceFromValue(value),
        };
      }).pipe(
        Effect.catchCause((cause) =>
          internal?.operation && Cause.hasDies(cause)
            ? Effect.fail(
                new ToolInvocationError({
                  address,
                  message: "Operation invocation failed.",
                  cause: {},
                }),
              )
            : Effect.failCause(cause),
        ),
        // Expected tool failures (`ToolResult.fail`) resolve through the
        // success channel, so the tracer alone would record them as healthy
        // spans. Stamp the outcome + error code so telemetry can distinguish
        // "tool ran fine" from "user hit an upstream error / auth wall"
        // without parsing response bodies.
        Effect.tap((result) =>
          annotateInvocationOutcome(result.value, internal?.operation !== undefined),
        ),
        Effect.withSpan("executor.tool.execute", {
          attributes: {
            "mcp.tool.name": String(address),
            "executor.tenant": tenant,
            ...(subject != null ? { "executor.subject": subject } : {}),
          },
        }),
      );
    };

    // Public generic execution deliberately retains its historical return
    // shape. The attested operation path uses the richer private result above
    // so it can carry the exact policy/approval/provider facts without
    // exposing a caller-supplied policy or invocation seam.
    const execute = (
      address: ToolAddress,
      args: unknown,
      options?: InvokeOptions,
    ): Effect.Effect<unknown, ExecuteError> =>
      executeInternal(address, args, options).pipe(Effect.map(({ value }) => value));

    // ------------------------------------------------------------------
    // OAuth service seam.
    // ------------------------------------------------------------------

    const oauth = makeOAuthService({
      fuma,
      owner: ownerBinding,
      tenant,
      subject,
      ownedKeys: (owner: Owner) => ownedKeys(owner),
      defaultWritableProvider,
      mintOAuthConnection: (input: MintOAuthConnectionInput) => mintOAuthConnection(input),
      // One integration-row read + one projector run. Resolve the method this
      // template selects exactly as the runtime's `selectAuthMethod` does —
      // exact slug match, else the sole declared method (single-method
      // integrations accept any slug); an ambiguous miss selects nothing rather
      // than guessing across methods. The discover-vs-scopes choice then reads
      // off that method (MCP exposes `discoveryUrl`), so core needs no plugin-id
      // knowledge.
      resolveOAuthScopePolicy: (integration: IntegrationSlug, template: AuthTemplateSlug) =>
        findIntegrationRow(integration).pipe(
          Effect.map((row): OAuthScopePolicy => {
            const methods = row ? describeAuthMethodsForRow(row) : [];
            const selected =
              methods.find((m: AuthMethodDescriptor) => m.template === String(template)) ??
              (methods.length === 1 ? methods[0] : undefined);
            const oauth = selected?.kind === "oauth" ? selected.oauth : undefined;
            // Declared scopes win. Discover only when the selected method
            // declares none but names a source to discover them from (MCP).
            if (oauth?.scopes === undefined && oauth?.discoveryUrl !== undefined) {
              return { kind: "discover" };
            }
            return { kind: "scopes", scopes: oauth?.scopes ?? [] };
          }),
        ),
      httpClientLayer: config.httpClientLayer,
      fetch: config.fetch,
      endpointUrlPolicy: config.oauthEndpointUrlPolicy,
      // EXPLICIT — no localhost default. When a caller omits `redirectUri` the
      // OAuth service receives `null` and redirect-requiring flows fail loudly
      // instead of silently using `http://127.0.0.1/callback`. Hosts that serve
      // OAuth (cloud, self-host) derive a real `${webBaseUrl}/oauth/callback`.
      redirectUri: config.redirectUri ?? null,
      callbackStateOrgSlug: config.oauthCallbackStateOrgSlug ?? null,
    });

    // ------------------------------------------------------------------
    // Plugin wiring — build ctx, run extension, populate static pools,
    // register credential providers.
    // ------------------------------------------------------------------

    const blobPartitions: OwnerPartitions = {
      org: `o:${tenant}`,
      user: subject != null ? `u:${tenant}:${subject}` : null,
    };

    for (const plugin of plugins) {
      if (runtimes.has(plugin.id)) {
        return yield* new StorageError({
          message: `Duplicate plugin id: ${plugin.id}`,
          cause: undefined,
        });
      }

      const pluginStorage = makePluginStorageFacade({
        core,
        pluginId: plugin.id,
        owner: ownerBinding,
      });
      const storageDeps: StorageDeps = {
        owner: ownerBinding,
        blobs: pluginBlobStore(blobs, blobPartitions, plugin.id),
        pluginStorage,
      };
      const storage = plugin.storage(storageDeps);

      const ctx: PluginCtx<unknown> = {
        owner: ownerBinding,
        storage,
        pluginStorage,
        httpClientLayer: config.httpClientLayer ?? FetchHttpClient.layer,
        core: {
          integrations: {
            register: (input: RegisterIntegrationInput) => integrationsRegister(plugin.id, input),
            update: (slug, patch) => integrationsUpdate(slug, patch),
            list: () => integrationsList(),
            get: (slug) => integrationsGetRecord(slug),
            remove: (slug) => integrationsRemove(slug),
            setHealthCheck: (slug, spec) =>
              integrationSetHealthCheck(slug, spec).pipe(
                // Fold not-found: a plugin declaring a default on a row it
                // never registered is a no-op, not a storage failure.
                Effect.catchTag("IntegrationNotFoundError", () => Effect.void),
              ),
            detect: (url) => integrationsDetect(url),
            configureSchemas: (): readonly IntegrationConfigureSchema[] =>
              Array.from(runtimes.values())
                .map(({ plugin }) =>
                  plugin.integrationConfigure
                    ? {
                        pluginId: plugin.id,
                        type: plugin.integrationConfigure.type,
                        schema: undefined,
                      }
                    : undefined,
                )
                .filter(Predicate.isNotUndefined),
            presets: (): readonly IntegrationPresetCatalogEntry[] =>
              Array.from(runtimes.values()).flatMap(({ plugin }) =>
                (plugin.integrationPresets ?? []).map((preset) => ({
                  ...preset,
                  pluginId: plugin.id,
                })),
              ),
          },
          policies: {
            list: () => policiesList(),
            create: (input) => policiesCreate(input),
            update: (input) => policiesUpdate(input),
            remove: (input) => policiesRemove(input),
          },
        },
        connections: {
          create: (input) => connectionsCreate(input),
          list: (filter) => connectionsList(filter),
          get: (ref) => connectionsGet(ref),
          update: (ref, input) => connectionsUpdate(ref, input),
          remove: (ref) => connectionsRemove(ref),
          refresh: (ref) => connectionsRefresh(ref),
          markToolsStale: (ref) => connectionsMarkToolsStale(ref),
          resolveValue: (ref) => resolveConnectionValueByRef(ref),
        },
        providers: {
          list: () => providersList(),
          items: (key) => providersItems(key),
          get: (key, id) => providersGet(key, id),
          has: (key, id) => providersHas(key, id),
          setDefault: (id, value) => providersSetDefault(id, value),
          remove: (key, id) => providersRemove(key, id),
        },
        oauth,
        execute: (address, args, options) => execute(address, args, options),
        transaction: <A, E>(effect: Effect.Effect<A, E>) => transaction(effect),
      };

      if (plugin.toolPolicyProvider) {
        const rawProvider = plugin.toolPolicyProvider(ctx);
        const provider = Effect.isEffect(rawProvider) ? yield* rawProvider : rawProvider;
        if (provider) {
          if (activeToolPolicyProvider) {
            return yield* new StorageError({
              message: "Only one plugin can provide the active tool policy source.",
              cause: undefined,
            });
          }
          activeToolPolicyProvider = provider;
        }
      }

      // Build extension FIRST so it's available as `self` for staticIntegrations.
      const extension: object = plugin.extension ? plugin.extension(ctx) : {};
      if (plugin.extension) {
        extensions[plugin.id] = extension;
      }

      const decls = plugin.staticIntegrations ? plugin.staticIntegrations(extension) : [];
      for (const integration of decls) {
        const mountUnderExecutor = integration.kind === "executor";
        const mountedIntegration = mountUnderExecutor ? EXECUTOR_INTEGRATION : integration;
        for (const tool of integration.tools) {
          const mountedTool = mountUnderExecutor
            ? { ...tool, name: `${integration.id}.${tool.name}` }
            : tool;
          const fqid = `${mountedIntegration.id}.${mountedTool.name}`;
          if (staticTools.has(fqid)) {
            return yield* new StorageError({
              message: `Duplicate static tool id: ${fqid} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticTools.set(fqid, {
            integration: mountedIntegration,
            tool: mountedTool,
            pluginId: plugin.id,
            ctx,
          });
        }
      }

      runtimes.set(plugin.id, { plugin, storage, ctx });

      if (plugin.credentialProviders) {
        const raw =
          typeof plugin.credentialProviders === "function"
            ? plugin.credentialProviders(ctx)
            : plugin.credentialProviders;
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) =>
                pluginStorageFailure(plugin.id, "credentialProviders", cause),
              ),
            )
          : raw;
        for (const provider of providers) {
          yield* registerCredentialProvider(provider, `plugin ${plugin.id}`);
        }
      }
    }

    // ------------------------------------------------------------------
    // Carrier-neutral operation execution.
    //
    // This is intentionally kept inside createExecutor. There is no public
    // "run with this policy/invoker" seam: the registry target, policy
    // snapshot, approval context, credential resolution, and provider receipt
    // all stay under Executor control.
    // ------------------------------------------------------------------

    const operationPolicy = (policy: EffectivePolicy) => ({
      decision:
        policy.action === "approve"
          ? ("allow" as const)
          : policy.action === "require_approval"
            ? ("require_approval" as const)
            : ("deny" as const),
      source: policy.source,
      ...(policy.pattern !== undefined ? { pattern: policy.pattern } : {}),
      ...(policy.policyId !== undefined ? { policyId: policy.policyId } : {}),
    });

    const safeFailureCode = (cause: unknown): ExecuteOperationFailureCodeType => {
      const raw =
        typeof cause === "string"
          ? cause
          : typeof cause === "object" && cause !== null
            ? dataProperty(cause, "code")
            : undefined;
      return typeof raw === "string" && isExecuteOperationFailureCode(raw)
        ? raw
        : "operation_failed";
    };

    const safeStatus = (cause: unknown): number | undefined => {
      if (typeof cause !== "object" || cause === null) return undefined;
      const status = dataProperty(cause, "status");
      return typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
        ? status
        : undefined;
    };

    const safeToolError = (
      error: unknown,
    ): {
      readonly code?: string;
      readonly status?: number;
      readonly retryable?: boolean;
    } => {
      if (typeof error !== "object" || error === null) return {};
      const code = dataProperty(error, "code");
      const status = dataProperty(error, "status");
      const retryable = dataProperty(error, "retryable");
      return {
        ...(typeof code === "string" ? { code } : {}),
        ...(typeof status === "number" ? { status } : {}),
        ...(typeof retryable === "boolean" ? { retryable } : {}),
      };
    };

    const sanitizeProviderEvidence = (
      evidence: unknown,
    ): Effect.Effect<ToolProviderEvidence | undefined> => {
      if (!evidence) return Effect.succeed(undefined);
      const operationTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
      const secretLikeMetadata =
        /(?:bearer|basic)\s+|(?:api[-_ ]?key|authorization|auth[-_ ]?header|password|passwd|secret|credential|client[-_ ]?secret|private[-_ ]?key|refresh[-_ ]?token|access[-_ ]?token|access[-_ ]?key|admin[-_ ]?key|aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret|aws[_-]?session|token)\s*[:=]|(?:sk-|gh[pousr]_|github_pat_|xox[bpras]-|AKIA|ASIA|eyJ)|-----BEGIN/i;
      return canonicalizeOperationValue(evidence).pipe(
        Effect.flatMap((snapshot) =>
          Schema.decodeUnknownEffect(ToolProviderEvidenceSchema)(snapshot.value),
        ),
        Effect.match({
          // Provider metadata is advisory. Invalid or secret-shaped metadata
          // must never cross the operation boundary; classify it as missing
          // evidence instead of leaking a parse error or raw value.
          onFailure: () => undefined,
          onSuccess: (validated) =>
            !operationTimestamp.test(validated.observedAt) ||
            secretLikeMetadata.test(JSON.stringify(validated))
              ? undefined
              : validated,
        }),
      );
    };

    const providerReceiptFromEvidence = (
      evidence: ToolProviderEvidence | undefined,
      operationRequestSha256: string,
    ): ProviderReceipt | undefined => {
      if (!evidence) return undefined;
      return {
        transport: evidence.transport,
        operationRequestSha256,
        ...(evidence.requestId !== undefined ? { requestId: evidence.requestId } : {}),
        ...(evidence.providerRequestSha256 !== undefined
          ? { providerRequestSha256: evidence.providerRequestSha256 }
          : {}),
        ...(evidence.responseSha256 !== undefined
          ? { responseSha256: evidence.responseSha256 }
          : {}),
        ...(evidence.status !== undefined ? { status: evidence.status } : {}),
        observedAt: evidence.observedAt,
      };
    };

    const reconcileProvider = (input: {
      readonly expectedTransport: ExecuteOperationDefinition["providerTransport"];
      readonly evidence?: ToolProviderEvidence;
      readonly requestSha256: string;
      readonly outputSha256?: string;
    }): {
      readonly status: "matched" | "mismatch" | "unavailable" | "not_attempted";
      readonly receipt?: ProviderReceipt;
    } => {
      const receipt = providerReceiptFromEvidence(input.evidence, input.requestSha256);
      if (input.expectedTransport === "none") {
        return input.evidence ? { status: "mismatch", receipt } : { status: "not_attempted" };
      }
      if (!input.evidence) return { status: "unavailable" };
      if (input.evidence.transport !== input.expectedTransport) {
        return { status: "mismatch", receipt };
      }
      if (
        input.outputSha256 !== undefined &&
        input.evidence.responseSha256 !== undefined &&
        input.evidence.responseSha256 !== input.outputSha256
      ) {
        return { status: "mismatch", receipt };
      }
      if (input.evidence.status !== undefined && input.evidence.status >= 400) {
        return { status: "mismatch", receipt };
      }
      // A receipt with an informational or redirect status is not successful
      // terminal evidence. Keep it as advisory/unavailable rather than
      // allowing a 1xx/3xx response to attest completion.
      if (
        input.evidence.status !== undefined &&
        (input.evidence.status < 200 || input.evidence.status >= 300)
      ) {
        return { status: "unavailable", receipt };
      }
      // A successful attestation requires an HTTP status and the canonical
      // sanitized response hash. The operation request hash in the public
      // receipt is stamped above by Executor, never accepted from a plugin.
      if (
        input.evidence.status === undefined ||
        input.outputSha256 === undefined ||
        input.evidence.responseSha256 === undefined
      ) {
        return { status: "unavailable", receipt };
      }
      return { status: "matched", receipt };
    };

    const samePolicy = (
      left: ExecuteOperationResult["policy"],
      right: ExecuteOperationResult["policy"],
    ): boolean =>
      left.decision === right.decision &&
      left.source === right.source &&
      left.pattern === right.pattern &&
      left.policyId === right.policyId;

    /** Validate a result read from a replay store as if it crossed an
     * untrusted carrier. The store is host-owned, but this check is what keeps
     * a corrupt or stale adapter from changing the reviewed target, tenant,
     * policy, hashes, or provider semantics on replay. Carrier is rebound to
     * the current trusted adapter after the immutable fields pass. */
    const validateAndRebindOperationResult = (input: {
      readonly raw: unknown;
      readonly request: ExecuteOperationRequest;
      readonly descriptor: ExecuteOperationDescriptor;
      readonly definition: ExecuteOperationDefinition;
      readonly tenant: string;
      readonly subject: string | null;
      readonly carrier: ExecuteOperationCarrier;
    }): Effect.Effect<ExecuteOperationResult, OperationContractError> =>
      Effect.gen(function* () {
        const snapshot = yield* canonicalizeOperationValue(input.raw).pipe(
          Effect.mapError(
            () => new OperationContractError({ field: "result", reason: "invalid_value" }),
          ),
        );
        const decoded = yield* ExecuteOperationResultCodec.decode(snapshot.value).pipe(
          Effect.mapError(
            () => new OperationContractError({ field: "result", reason: "invalid_value" }),
          ),
        );
        const failResult = (field: string) =>
          new OperationContractError({ field, reason: "invalid_value" });
        if (
          decoded.schemaVersion !== input.request.schemaVersion ||
          decoded.operationKey !== input.request.operationKey ||
          decoded.version !== input.request.version ||
          decoded.jobId !== input.request.jobId ||
          decoded.descriptorSha256 !== input.request.descriptorSha256 ||
          decoded.requestSha256 !== input.request.requestSha256 ||
          String(decoded.target) !== String(input.descriptor.target) ||
          decoded.providerTransport !== input.definition.providerTransport
        ) {
          return yield* failResult("result.binding");
        }

        if (
          decoded.approval.tenant !== input.tenant ||
          decoded.approval.subject !== (input.subject ?? undefined) ||
          decoded.approval.executionId !== decoded.executionId ||
          decoded.approval.jobId !== decoded.jobId ||
          decoded.approval.operationKey !== decoded.operationKey ||
          decoded.approval.version !== decoded.version ||
          decoded.approval.descriptorSha256 !== decoded.descriptorSha256 ||
          decoded.approval.requestSha256 !== decoded.requestSha256 ||
          String(decoded.approval.target) !== String(decoded.target) ||
          decoded.approval.providerTransport !== decoded.providerTransport ||
          decoded.approval.carrier !== decoded.carrier ||
          decoded.approval.sessionId !== `approval:${decoded.executionId}` ||
          !samePolicy(decoded.approval.policy, decoded.policy)
        ) {
          return yield* failResult("result.approval");
        }

        const outputPresent = Object.prototype.hasOwnProperty.call(decoded, "output");
        let outputSha256: string | null = decoded.outputSha256;
        let sanitizedOutput: unknown;
        if (outputPresent) {
          sanitizedOutput = yield* validateOperationSchema(
            input.definition.outputSchema,
            decoded.output,
            "output",
          ).pipe(Effect.mapError(() => failResult("result.output")));
          const calculated = yield* hashOperationValue(sanitizedOutput).pipe(
            Effect.mapError(() => failResult("result.output")),
          );
          if (decoded.outputSha256 !== calculated) {
            return yield* failResult("result.outputSha256");
          }
          outputSha256 = calculated;
        } else if (decoded.outputSha256 !== null) {
          return yield* failResult("result.outputSha256");
        }

        if (decoded.status === "completed" && !outputPresent) {
          return yield* failResult("result.output");
        }
        if (decoded.status === "completed" && decoded.failure !== undefined) {
          return yield* failResult("result.failure");
        }
        if (decoded.status !== "completed" && decoded.failure === undefined) {
          return yield* failResult("result.failure");
        }
        if (decoded.status !== "completed" && outputPresent) {
          return yield* failResult("result.output");
        }

        // The approval adapter is an authorization boundary, not a free-form
        // annotation. Reject results whose status, policy, and decision could
        // not have been produced by the reviewed lifecycle.
        if (
          decoded.status === "completed" &&
          (decoded.policy.decision === "deny" ||
            (decoded.policy.decision === "require_approval" &&
              decoded.approval.decision !== "approved") ||
            (decoded.policy.decision === "allow" && decoded.approval.decision !== "not_required"))
        ) {
          return yield* failResult("result.approval");
        }
        if (
          decoded.policy.decision === "require_approval" &&
          decoded.approval.decision === "not_required"
        ) {
          return yield* failResult("result.approval");
        }
        if (decoded.status === "blocked" && decoded.approval.decision === "approved") {
          return yield* failResult("result.approval");
        }
        if (decoded.status === "cancelled" && decoded.approval.decision !== "cancelled") {
          return yield* failResult("result.approval");
        }
        if (
          decoded.status === "failed" &&
          (decoded.approval.decision === "declined" || decoded.approval.decision === "cancelled")
        ) {
          return yield* failResult("result.approval");
        }
        if (decoded.failure !== undefined) {
          const code = decoded.failure.code;
          if (
            decoded.status === "cancelled" &&
            code !== "operation_cancelled" &&
            code !== "approval_cancelled"
          ) {
            return yield* failResult("result.failure");
          }
          if (
            decoded.status === "blocked" &&
            code !== "policy_blocked" &&
            code !== "approval_handler_required" &&
            code !== "approval_declined"
          ) {
            return yield* failResult("result.failure");
          }
          if (
            decoded.status === "failed" &&
            (code === "operation_cancelled" ||
              code === "approval_cancelled" ||
              code === "policy_blocked" ||
              code === "approval_handler_required" ||
              code === "approval_declined")
          ) {
            return yield* failResult("result.failure");
          }
        }

        const reconciliation = decoded.providerReconciliation;
        const receipt = reconciliation.receipt;
        let sanitizedReceipt: ProviderReceipt | undefined;
        if (receipt) {
          const safeProvider = yield* sanitizeProviderEvidence({
            transport: receipt.transport,
            ...(receipt.requestId !== undefined ? { requestId: receipt.requestId } : {}),
            ...(receipt.providerRequestSha256 !== undefined
              ? { providerRequestSha256: receipt.providerRequestSha256 }
              : {}),
            ...(receipt.responseSha256 !== undefined
              ? { responseSha256: receipt.responseSha256 }
              : {}),
            ...(receipt.status !== undefined ? { status: receipt.status } : {}),
            observedAt: receipt.observedAt,
          });
          if (!safeProvider) {
            return yield* failResult("result.providerReconciliation.receipt");
          }
          sanitizedReceipt = {
            ...safeProvider,
            operationRequestSha256: receipt.operationRequestSha256,
          };
          if (receipt.operationRequestSha256 !== input.request.requestSha256) {
            return yield* failResult("result.providerReconciliation.receipt");
          }
          if (
            reconciliation.status === "matched" &&
            receipt.transport !== input.definition.providerTransport
          ) {
            return yield* failResult("result.providerReconciliation.receipt.transport");
          }
          if (
            receipt.responseSha256 !== undefined &&
            outputSha256 !== null &&
            receipt.responseSha256 !== outputSha256
          ) {
            return yield* failResult("result.providerReconciliation.receipt.responseSha256");
          }
        }
        if (reconciliation.status === "not_attempted" && receipt !== undefined) {
          return yield* failResult("result.providerReconciliation");
        }
        if (reconciliation.status === "matched") {
          if (
            input.definition.providerTransport === "none" ||
            receipt === undefined ||
            outputSha256 === null ||
            receipt.responseSha256 !== outputSha256 ||
            receipt.status === undefined ||
            receipt.status < 200 ||
            receipt.status >= 300
          ) {
            return yield* failResult("result.providerReconciliation");
          }
        }
        if (
          decoded.status === "completed" &&
          (input.definition.providerTransport === "none"
            ? reconciliation.status !== "not_attempted"
            : reconciliation.status !== "matched")
        ) {
          return yield* failResult("result.providerReconciliation");
        }

        return {
          ...decoded,
          ...(outputPresent ? { output: sanitizedOutput, outputSha256 } : {}),
          providerReconciliation: sanitizedReceipt
            ? { ...reconciliation, receipt: sanitizedReceipt }
            : reconciliation,
          carrier: input.carrier,
          approval: { ...decoded.approval, carrier: input.carrier },
        };
      });

    const operationTargetPolicy = (
      target: ToolAddress,
    ): Effect.Effect<EffectivePolicy, StorageFailure> =>
      Effect.gen(function* () {
        const staticEntry = staticTools.get(String(target));
        if (staticEntry) {
          const tool = staticToolToTool(staticEntry);
          const rules = yield* listActivePolicyRuleSet();
          return yield* resolvePolicyFromRuleSet(
            normalizedPolicyId(tool),
            rules,
            tool.annotations?.requiresApproval,
          );
        }
        const parsed = parseToolAddress(String(target));
        const rules = yield* listActivePolicyRuleSet();
        if (!parsed) {
          return yield* resolvePolicyFromRuleSet(String(target), rules);
        }
        const row = yield* core.findFirst("tool", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(parsed.owner)(b),
              b("integration", "=", String(parsed.integration)),
              b("connection", "=", String(parsed.connection)),
              b("name", "=", String(parsed.tool)),
            ),
          select: TOOL_INVOCATION_COLUMNS,
        });
        let annotations = row
          ? (decodeJsonColumn(row.annotations) as ToolAnnotations | undefined)
          : undefined;
        const runtime = row ? runtimes.get(row.plugin_id) : undefined;
        if (row && runtime?.plugin.resolveAnnotations) {
          const resolved = yield* resolveAnnotationsWithReadonlyContext({
            runtime,
            integration: parsed.integration,
            connection: parsed.connection,
            toolRows: [row],
          });
          annotations = resolved[String(parsed.tool)] ?? annotations;
        }
        const toolId = `${parsed.integration}.${parsed.owner}.${parsed.connection}.${parsed.tool}`;
        return yield* resolvePolicyFromRuleSet(toolId, rules, annotations?.requiresApproval);
      });

    const executeOperation = (
      request: ExecuteOperationRequest,
      carrier: ExecuteOperationCarrier,
    ): Effect.Effect<
      ExecuteOperationResult,
      ExecuteOperationError | ExecuteError | StorageFailure
    > => {
      type ReservationBinding = {
        readonly tenant: string;
        readonly subject: string | null;
        readonly jobId: string;
        readonly requestSha256: string;
        readonly reservationToken: string;
        readonly request: ExecuteOperationRequest;
        readonly descriptor: ExecuteOperationDescriptor;
        readonly definition: ExecuteOperationDefinition;
        readonly carrier: ExecuteOperationCarrier;
      };
      let reservationBinding: ReservationBinding | undefined;
      let cancellationResultFactory: (() => ExecuteOperationResult) | undefined;
      let reservationSettled = false;

      return Effect.gen(function* () {
        if (!operationReplayStore) {
          return yield* new StorageError({
            message: "Executor operation replay storage is not configured.",
            cause: undefined,
          });
        }
        if (!isExecuteOperationCarrier(carrier)) {
          return yield* new OperationContractError({
            field: "carrier",
            reason: "unsupported_carrier",
          });
        }
        // Canonicalize the entire carrier value before the schema decoder reads
        // any field. This turns proxy/accessor traps into typed contract
        // failures instead of allowing Schema to invoke a caller-owned getter.
        const requestSnapshot = yield* canonicalizeOperationValue(request).pipe(
          Effect.mapError(
            () => new OperationContractError({ field: "request", reason: "invalid_request" }),
          ),
        );
        const decodedRequest = yield* ExecuteOperationRequestCodec.decode(
          requestSnapshot.value,
        ).pipe(
          Effect.mapError(
            () => new OperationContractError({ field: "request", reason: "invalid_request" }),
          ),
        );
        // Freeze a strict clone before any schema hook or policy code can see
        // the request. The exact clone is also the one passed to invocation.
        const inputSnapshot = yield* canonicalizeOperationValue(decodedRequest.input);
        const sanitizedRequest: ExecuteOperationRequest = {
          ...decodedRequest,
          input: inputSnapshot.value,
        };
        const actualRequestSha256 = yield* hashExecuteOperationRequest(sanitizedRequest);
        if (actualRequestSha256 !== sanitizedRequest.requestSha256) {
          return yield* new OperationRequestHashMismatchError({
            expected: sanitizedRequest.requestSha256,
            actual: actualRequestSha256,
          });
        }

        const definition = operationRegistry.get(
          `${sanitizedRequest.operationKey}@${sanitizedRequest.version}`,
        );
        if (!definition) {
          return yield* new OperationContractError({
            field: "operationKey",
            reason: "unsupported_operation",
          });
        }
        const descriptor = yield* deriveOperationDescriptor(definition);
        if (descriptor.descriptorSha256 !== sanitizedRequest.descriptorSha256) {
          return yield* new OperationDescriptorMismatchError({
            expected: descriptor.descriptorSha256,
            actual: sanitizedRequest.descriptorSha256,
          });
        }
        const validatedInput = yield* validateOperationSchema(
          definition.inputSchema,
          inputSnapshot.value,
          "input",
        );
        const executionId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const approvalSessionId = `approval:${executionId}`;
        const baseApproval = (
          policy: EffectivePolicy,
          decision: ExecuteOperationApproval["decision"],
          decidedAt?: string,
        ): ExecuteOperationApproval => ({
          decision,
          tenant,
          executionId,
          jobId: sanitizedRequest.jobId,
          operationKey: sanitizedRequest.operationKey,
          version: sanitizedRequest.version,
          descriptorSha256: sanitizedRequest.descriptorSha256,
          requestSha256: sanitizedRequest.requestSha256,
          target: descriptor.target,
          providerTransport: definition.providerTransport,
          carrier,
          policy: operationPolicy(policy),
          ...(subject !== null ? { subject: Subject.make(subject) } : {}),
          sessionId: approvalSessionId,
          ...(decidedAt !== undefined ? { decidedAt } : {}),
        });
        const baseResult = (input: {
          readonly policy: EffectivePolicy;
          readonly approval: ExecuteOperationApproval;
          readonly providerReconciliation: {
            readonly status: "matched" | "mismatch" | "unavailable" | "not_attempted";
            readonly receipt?: ProviderReceipt;
          };
          readonly status: ExecuteOperationStatus;
          readonly outputSha256?: string;
          readonly output?: unknown;
          readonly failure?: ExecuteOperationFailure;
        }): ExecuteOperationResult => {
          const completedAt = new Date().toISOString();
          return {
            schemaVersion: "executor.operation.v2",
            operationKey: sanitizedRequest.operationKey,
            version: sanitizedRequest.version,
            jobId: sanitizedRequest.jobId,
            descriptorSha256: sanitizedRequest.descriptorSha256,
            requestSha256: sanitizedRequest.requestSha256,
            carrier,
            target: descriptor.target,
            providerTransport: definition.providerTransport,
            executionId,
            policy: operationPolicy(input.policy),
            approval: input.approval,
            providerReconciliation: input.providerReconciliation,
            startedAt,
            completedAt,
            durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
            status: input.status,
            outputSha256: input.outputSha256 ?? null,
            ...(input.output !== undefined ? { output: input.output } : {}),
            ...(input.failure !== undefined ? { failure: input.failure } : {}),
          };
        };

        // Install the conservative terminal result before reserve. The
        // reserve effect may commit in a durable adapter immediately before
        // the fiber is interrupted, so acquisition and local ownership are
        // one uninterruptible scope rather than a racy yield followed by an
        // assignment.
        const pendingCancellationPolicy: EffectivePolicy = {
          action: "block",
          source: "plugin-default",
        };
        cancellationResultFactory = () =>
          baseResult({
            policy: pendingCancellationPolicy,
            approval: baseApproval(
              pendingCancellationPolicy,
              "cancelled",
              new Date().toISOString(),
            ),
            providerReconciliation:
              definition.providerTransport === "none"
                ? { status: "not_attempted" }
                : { status: "unavailable" },
            status: "cancelled",
            failure: { code: "operation_cancelled", retryable: false },
          });

        const reservation = yield* Effect.uninterruptible(
          operationReplayStore
            .reserve({
              tenant,
              subject: subject ?? undefined,
              jobId: sanitizedRequest.jobId,
              requestSha256: sanitizedRequest.requestSha256,
            })
            .pipe(
              Effect.tap((candidate) => {
                if (candidate.status !== "reserved") return Effect.void;
                reservationBinding = {
                  tenant,
                  subject,
                  jobId: sanitizedRequest.jobId,
                  requestSha256: sanitizedRequest.requestSha256,
                  reservationToken: candidate.reservationToken,
                  request: sanitizedRequest,
                  descriptor,
                  definition,
                  carrier,
                };
                return Effect.void;
              }),
            ),
        );
        if (reservation.status === "replay") {
          return yield* validateAndRebindOperationResult({
            raw: reservation.result,
            request: sanitizedRequest,
            descriptor,
            definition,
            tenant,
            subject,
            carrier,
          });
        }
        if (reservation.status === "conflict") {
          return yield* new OperationRequestHashMismatchError({
            expected: reservation.requestSha256,
            actual: sanitizedRequest.requestSha256,
          });
        }
        if (reservation.status === "in_progress") {
          return yield* new OperationContractError({
            field: "jobId",
            reason: "replay_in_progress",
          });
        }
        const reservationToken = reservation.reservationToken;
        const policy = yield* operationTargetPolicy(descriptor.target);
        const approvalContext: ExecuteOperationApprovalContext = {
          tenant,
          executionId,
          jobId: sanitizedRequest.jobId,
          operationKey: sanitizedRequest.operationKey,
          version: sanitizedRequest.version,
          requestSha256: sanitizedRequest.requestSha256,
          descriptorSha256: sanitizedRequest.descriptorSha256,
          target: descriptor.target,
          providerTransport: definition.providerTransport,
          carrier,
          policy: operationPolicy(policy),
          ...(subject !== null ? { subject } : {}),
          sessionId: approvalSessionId,
        };
        cancellationResultFactory = () =>
          baseResult({
            policy,
            approval: baseApproval(policy, "cancelled", new Date().toISOString()),
            providerReconciliation:
              definition.providerTransport === "none"
                ? { status: "not_attempted" }
                : { status: "unavailable" },
            status: "cancelled",
            failure: { code: "operation_cancelled", retryable: false },
          });
        let result: ExecuteOperationResult | undefined;
        let approvalSatisfied = false;
        if (policy.action === "block") {
          result = baseResult({
            policy,
            approval: baseApproval(policy, "not_required", new Date().toISOString()),
            providerReconciliation: { status: "not_attempted" },
            status: "blocked",
            failure: { code: "policy_blocked", retryable: false },
          });
        } else {
          if (policy.action === "require_approval") {
            // Generic elicitation (including the test/local `accept-all`
            // sentinel) is not an operation grant. A host must bind the
            // complete execution identity through an explicit adapter, or we
            // fail closed before credential resolution/provider invocation.
            if (!config.operationApproval) {
              result = baseResult({
                policy,
                approval: baseApproval(policy, "declined", new Date().toISOString()),
                providerReconciliation: { status: "not_attempted" },
                status: "blocked",
                failure: { code: "approval_handler_required", retryable: false },
              });
            } else {
              const approvalEffect = yield* Effect.try({
                try: () => config.operationApproval!(approvalContext),
                catch: () =>
                  new OperationContractError({
                    field: "approval.handler",
                    reason: "invalid_value",
                  }),
              });
              if (!Effect.isEffect(approvalEffect)) {
                return yield* new OperationContractError({
                  field: "approval.handler",
                  reason: "invalid_value",
                });
              }
              const decision = yield* approvalEffect.pipe(
                Effect.catchCause(() =>
                  Effect.fail(
                    new OperationContractError({
                      field: "approval.handler",
                      reason: "invalid_value",
                    }),
                  ),
                ),
              );
              if (!isExecuteOperationApprovalDecision(decision)) {
                return yield* new OperationContractError({
                  field: "approval.decision",
                  reason: "invalid_value",
                });
              }
              if (decision !== "approved") {
                result = baseResult({
                  policy,
                  approval: baseApproval(policy, decision, new Date().toISOString()),
                  providerReconciliation: { status: "not_attempted" },
                  status: decision === "cancelled" ? "cancelled" : "blocked",
                  failure: {
                    code: decision === "cancelled" ? "approval_cancelled" : "approval_declined",
                    retryable: false,
                  },
                });
              } else {
                approvalSatisfied = true;
              }
            }
          }
        }
        if (result === undefined) {
          const internalContext: InternalOperationContext = {
            executionId,
            jobId: sanitizedRequest.jobId,
            requestSha256: sanitizedRequest.requestSha256,
            approvalSatisfied,
          };
          const invocation = yield* executeInternal(descriptor.target, validatedInput, undefined, {
            policy,
            operation: internalContext,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ failed: true as const, error }),
              onSuccess: (value) => ({ failed: false as const, value }),
            }),
          );
          if (invocation.failed) {
            const error = invocation.error;
            const errorStatus = safeStatus(error);
            const errorTag =
              typeof error === "object" && error !== null ? dataProperty(error, "_tag") : undefined;
            const declined = errorTag === "ElicitationDeclinedError";
            const blocked = errorTag === "ToolBlockedError";
            const action =
              typeof error === "object" && error !== null
                ? dataProperty(error, "action")
                : undefined;
            const declinedAction =
              declined && (action === "decline" || action === "cancel") ? action : undefined;
            const approvalDecision = declined
              ? (declinedAction ?? "decline")
              : blocked
                ? "not_required"
                : policy.action === "require_approval"
                  ? "approved"
                  : "not_required";
            result = baseResult({
              policy,
              approval: baseApproval(
                policy,
                approvalDecision === "decline"
                  ? "declined"
                  : approvalDecision === "cancel"
                    ? "cancelled"
                    : approvalDecision,
                new Date().toISOString(),
              ),
              providerReconciliation: { status: "unavailable" },
              status: blocked
                ? "blocked"
                : declined && declinedAction === "cancel"
                  ? "cancelled"
                  : "failed",
              failure: {
                code: blocked
                  ? "policy_blocked"
                  : declined
                    ? "approval_declined"
                    : safeFailureCode(error),
                ...(errorStatus !== undefined ? { status: errorStatus } : {}),
                retryable: !blocked && !declined,
              },
            });
          } else {
            const value = invocation.value.value;
            const providerEvidence = yield* sanitizeProviderEvidence(invocation.value.provider);
            const providerReconciliation = reconcileProvider({
              expectedTransport: definition.providerTransport,
              evidence: providerEvidence,
              requestSha256: sanitizedRequest.requestSha256,
            });
            const toolResult = safeToolResultProjection(value);
            if (toolResult?.ok === "invalid") {
              return yield* new OperationContractError({
                field: "output",
                reason: "invalid_value",
              });
            }
            if (toolResult?.ok === false) {
              const error = safeToolError(toolResult.error);
              const errorStatus = safeStatus(error);
              result = baseResult({
                policy,
                approval: baseApproval(policy, invocation.value.approval, new Date().toISOString()),
                providerReconciliation,
                status: "failed",
                failure: {
                  code: safeFailureCode(error.code ?? "operation_failed"),
                  ...(errorStatus !== undefined ? { status: errorStatus } : {}),
                  ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
                },
              });
            } else {
              const publicValue = toolResult?.ok === true ? toolResult.data : value;
              const output = yield* validateOperationSchema(
                definition.outputSchema,
                publicValue,
                "output",
              ).pipe(
                Effect.match({
                  onFailure: () => ({ ok: false as const }),
                  onSuccess: (sanitizedOutput) => ({ ok: true as const, sanitizedOutput }),
                }),
              );
              if (!output.ok) {
                result = baseResult({
                  policy,
                  approval: baseApproval(
                    policy,
                    invocation.value.approval,
                    new Date().toISOString(),
                  ),
                  providerReconciliation,
                  status: "failed",
                  failure: { code: "output_schema_invalid", retryable: false },
                });
              } else {
                const outputSha256 = yield* hashOperationValue(output.sanitizedOutput).pipe(
                  Effect.match({
                    onFailure: () => undefined,
                    onSuccess: (hash) => hash,
                  }),
                );
                const reconciled = reconcileProvider({
                  expectedTransport: definition.providerTransport,
                  evidence: providerEvidence,
                  requestSha256: sanitizedRequest.requestSha256,
                  outputSha256,
                });
                const providerFailure: ExecuteOperationFailure | undefined =
                  reconciled.status === "matched" || reconciled.status === "not_attempted"
                    ? undefined
                    : {
                        code:
                          reconciled.status === "mismatch"
                            ? "provider_receipt_mismatch"
                            : "provider_receipt_unavailable",
                        retryable: reconciled.status === "unavailable",
                      };
                result = baseResult({
                  policy,
                  approval: baseApproval(
                    policy,
                    invocation.value.approval,
                    new Date().toISOString(),
                  ),
                  providerReconciliation: reconciled,
                  status: providerFailure ? "failed" : "completed",
                  outputSha256: providerFailure ? undefined : outputSha256,
                  output: providerFailure ? undefined : output.sanitizedOutput,
                  failure: providerFailure,
                });
              }
            }
          }
        }
        if (result === undefined) {
          return yield* new OperationContractError({ field: "result", reason: "invalid_value" });
        }
        const validatedResult = yield* validateAndRebindOperationResult({
          raw: result,
          request: sanitizedRequest,
          descriptor,
          definition,
          tenant,
          subject,
          carrier,
        });
        const settleStatus = yield* operationReplayStore.settle({
          tenant,
          subject: subject ?? undefined,
          jobId: sanitizedRequest.jobId,
          requestSha256: sanitizedRequest.requestSha256,
          reservationToken,
          result: validatedResult,
        });
        if (settleStatus !== "settled") {
          return yield* new OperationContractError({
            field: "reservation",
            reason: "stale_reservation",
          });
        }
        reservationSettled = true;
        return validatedResult;
      }).pipe(
        // Never let an adapter/plugin defect carry provider-owned data into
        // an observer. Typed failures retain their contract identity; defects
        // become an opaque contract error and the finalizer still settles the
        // reservation below.
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.fail(
                new OperationContractError({ field: "execution", reason: "invalid_value" }),
              )
            : Effect.failCause(cause),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            const binding = reservationBinding;
            const makeCancelled = cancellationResultFactory;
            const store = operationReplayStore;
            if (!binding || !makeCancelled || !store || reservationSettled) return Effect.void;
            return validateAndRebindOperationResult({
              raw: makeCancelled(),
              request: binding.request,
              descriptor: binding.descriptor,
              definition: binding.definition,
              tenant: binding.tenant,
              subject: binding.subject,
              carrier: binding.carrier,
            }).pipe(
              Effect.flatMap((result) =>
                store
                  .settle({
                    tenant: binding.tenant,
                    subject: binding.subject ?? undefined,
                    jobId: binding.jobId,
                    requestSha256: binding.requestSha256,
                    reservationToken: binding.reservationToken,
                    result,
                  })
                  .pipe(
                    Effect.tap((status) => {
                      if (status === "settled") reservationSettled = true;
                      return Effect.void;
                    }),
                    Effect.asVoid,
                  ),
              ),
              Effect.ignore,
            );
          }).pipe(
            Effect.flatten,
            Effect.uninterruptible,
            Effect.catchCause(() => Effect.void),
          ),
        ),
      );
    };

    // ------------------------------------------------------------------
    // close
    // ------------------------------------------------------------------

    const close = () =>
      Effect.gen(function* () {
        for (const runtime of runtimes.values()) {
          if (runtime.plugin.close) {
            yield* runtime.plugin
              .close()
              .pipe(
                Effect.mapError((cause) => pluginStorageFailure(runtime.plugin.id, "close", cause)),
              );
          }
        }
        if (closeDb) {
          const out = closeDb();
          if (Effect.isEffect(out)) {
            yield* out;
          } else if (out instanceof Promise) {
            yield* Effect.tryPromise({
              try: () => out,
              catch: (cause) =>
                new StorageError({
                  message: "Executor database close failed",
                  cause,
                }),
            });
          }
        }
      });

    const base = {
      integrations: {
        list: integrationsList,
        get: integrationsGet,
        update: integrationsUpdatePublic,
        remove: integrationsRemove,
        detect: integrationsDetect,
        healthCheck: {
          get: integrationHealthCheckGet,
          candidates: integrationHealthCheckCandidates,
          set: integrationSetHealthCheck,
        },
      },
      connections: {
        create: connectionsCreate,
        list: connectionsList,
        get: connectionsGet,
        update: connectionsUpdate,
        remove: connectionsRemove,
        refresh: connectionsRefresh,
        checkHealth: connectionCheckHealth,
        validate: connectionValidate,
      },
      oauth,
      tools: {
        list: toolsList,
        schema: toolSchema,
      },
      providers: {
        list: providersList,
        items: providersItems,
      },
      policies: {
        list: policiesList,
        create: policiesCreate,
        update: policiesUpdate,
        remove: policiesRemove,
        resolve: policiesResolve,
      },
      execute,
      operationExecutionAvailable,
      executeOperation,
      close,
    };

    const toExecutor = (value: unknown): Executor<TPlugins> => value as Executor<TPlugins>;
    return toExecutor(Object.assign(base, extensions));
  });

// Helper alias so the inline literal used for the optimistic projection in
// `produceConnectionTools` satisfies the ToolRow shape.
type ConnectionToolRow = ToolRow;
