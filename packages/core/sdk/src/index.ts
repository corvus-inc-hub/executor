// ---------------------------------------------------------------------------
// @executor-js/sdk — public surface (v2)
// ---------------------------------------------------------------------------

// Re-export the Effect/Schema/HttpApi primitives plugin authors need so a
// plugin can be written importing only from `@executor-js/sdk`.
export { Context, Effect, Layer, Schema, Data, Option } from "effect";
export {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/unstable/httpapi";

// FumaDB integration.
export { fumadb } from "@executor-js/fumadb";
export type { FumaDB } from "@executor-js/fumadb";
export type { AbstractQuery, Condition, ConditionBuilder } from "@executor-js/fumadb/query";
export { column, idColumn, schema as fumaSchema, table } from "@executor-js/fumadb/schema";
export type {
  AnyColumn,
  AnySchema,
  AnyTable,
  Column,
  Schema as FumaSchema,
} from "@executor-js/fumadb/schema";

export type {
  FumaDb,
  FumaQuery,
  FumaRow,
  FumaTables,
  IFumaClient,
  StorageFailure,
} from "./fuma-runtime";
export { StorageError, UniqueViolationError, isStorageFailure } from "./fuma-runtime";

// IDs (branded) — the v2 set.
export {
  IntegrationSlug,
  AuthTemplateSlug,
  ConnectionName,
  OAuthClientSlug,
  OAuthState,
  ProviderKey,
  ProviderItemId,
  ConnectionAddress,
  ToolAddress,
  ToolName,
  ElicitationId,
  PolicyId,
  Tenant,
  Subject,
  Owner,
} from "./ids";
export { connectionIdentifier, isConnectionIdentifier } from "./connection-name-identifier";

// Errors (tagged) — the ExecuteError set + integration lifecycle.
export {
  ToolNotFoundError,
  ToolInvocationError,
  ToolBlockedError,
  NoHandlerError,
  PluginNotLoadedError,
  IntegrationNotFoundError,
  IntegrationAlreadyExistsError,
  IntegrationRemovalNotAllowedError,
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  isUserActionableError,
  type ExecuteError,
  type ExecutorError,
  type UserActionableError,
} from "./errors";

// Integration / connection / tool domain contracts.
export type {
  AuthMethodDescriptor,
  AuthMethodOAuthDescriptor,
  AuthPlacementDescriptor,
  Integration,
  IntegrationConfig,
  IntegrationDisplayDescriptor,
  RegisterIntegrationInput,
} from "./integration";
export { freshCustomAuthSlug, mergeAuthTemplates } from "./integration";
export type {
  Connection,
  ConnectionRef,
  ConnectionValueInput,
  CreateConnectionInput,
  UpdateConnectionInput,
  ValidateConnectionInput,
} from "./connection";
export type { Tool, ToolDef, ToolListFilter, ToolAnnotations } from "./tool";

// Credential providers.
export type { CredentialProvider, ProviderEntry } from "./provider";

// Public projections / detection.
export { ToolSchemaView, IntegrationDetectionResult } from "./types";

// Health-check vocabulary (pure Schema + helpers).
export {
  HealthStatus,
  HealthCheckSpec,
  HealthCheckResult,
  HealthCheckResponseSample,
  HealthCheckCandidate,
  HealthCheckCandidateParameter,
  HealthCheckResponseField,
  classifyHttpStatus,
  extractIdentity,
  compareHealthCheckCandidates,
  candidateIdentityTier,
  sortHealthCheckCandidatesByIdentity,
  projectResponseFields,
  extractResponseFields,
  identityPathTier,
  rankResponseSample,
} from "./health-check";

// Core schema.
export {
  bigintColumn,
  boolColumn,
  coreSchema,
  coreTables,
  dateColumn,
  isToolPolicyAction,
  jsonColumn,
  keyColumn,
  nullableBigintColumn,
  nullableJsonColumn,
  nullableKeyColumn,
  nullableTextColumn,
  textColumn,
  TOOL_POLICY_ACTIONS,
  type CoreSchema,
  type IntegrationRow,
  type ConnectionRow,
  type OAuthClientRow,
  type OAuthSessionRow,
  type ToolRow,
  type ToolInvocationRow,
  type DefinitionRow,
  type ToolPolicyRow,
  type PluginStorageRow,
  type BlobRow,
  type ToolPolicyAction,
} from "./core-schema";

// Owner policy.
export {
  ORG_SUBJECT,
  executorOwnerPolicyName,
  executorUnscopedPolicyName,
  type ExecutorOwnerPolicyContext,
} from "./owner-policy";

// Tool policies.
export {
  matchPattern,
  isValidPattern,
  effectivePolicyFromSorted,
  ToolPolicyActionSchema,
  type ToolPolicy,
  type CreateToolPolicyInput,
  type UpdateToolPolicyInput,
  type RemoveToolPolicyInput,
  type PolicyMatch,
  type EffectivePolicy,
  type PolicySource,
} from "./policies";

// Elicitation.
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  ElicitationDeclinedError,
  type ElicitationRequest,
  type ElicitationHandler,
  type ElicitationContext,
  type OnElicitation,
  type InvokeOptions,
} from "./elicitation";

// Blob store — the plugin-facing contract (`BlobStore`/`PluginBlobStore`)
// plus the platform-neutral backends (`makeFumaBlobStore` default,
// `makeInMemoryBlobStore` for tests). Platform-specific backends live with
// their host (R2: `@executor-js/cloudflare/blob-store`).
export {
  pluginBlobStore,
  makeInMemoryBlobStore,
  makeFumaBlobStore,
  sha256Hex,
  type BlobStore,
  type PluginBlobStore,
  type OwnerPartitions,
} from "./blob";

// Plugin storage.
export {
  definePluginStorageCollection,
  pluginStorageId,
  type PluginStorageCollectionDefinition,
  type PluginStorageCollectionFacade,
  type PluginStorageCollectionIndexedField,
  type PluginStorageCollectionKeyInput,
  type PluginStorageCollectionListInput,
  type PluginStorageCollectionOrderBy,
  type PluginStorageCollectionPutInput,
  type PluginStorageCollectionQueryInput,
  type PluginStorageCollectionScopedKeyInput,
  type PluginStorageCollectionWhere,
  type PluginStorageConfig,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type PluginStorageIndexField,
  type PluginStorageIndexSpec,
  type PluginStorageKeyInput,
  type PluginStorageListInput,
  type PluginStoragePutInput,
  type PluginStorageRuntimeCollectionDefinition,
  type PluginStorageRuntimeIndexSpec,
  type PluginStorageSchema,
  type PluginStorageSchemaType,
  type PluginStorageScopedKeyInput,
  type PluginStorageWhereFilter,
  type PluginStorageWhereValue,
} from "./plugin-storage";

// OAuth (v2 contracts).
export {
  OAUTH2_PROVIDER_KEY,
  OAUTH2_SESSION_TTL_MS,
  decodeOAuthCallbackState,
  encodeOAuthCallbackState,
  type OAuthCallbackState,
} from "./oauth";
export {
  OAuthStartError,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
  type OAuthGrant,
  type OAuthAuthentication,
  type OAuthClient,
  type OAuthClientSummary,
  type CreateOAuthClientInput,
  type RegisterDynamicClientInput,
  type ConnectResult,
  type OAuthStartInput,
  type OAuthCompleteInput,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthService,
} from "./oauth-client";

// NOTE: the OAuth 2.1 implementation helpers (`./oauth-helpers`,
// `makeOAuthService` in `./oauth-service`, discovery in `./oauth-discovery`)
// are SDK-internal — consumed only by `createExecutor`. The hosted HTTP client
// builder is host-internal and reachable via `@executor-js/sdk/host-internal`.

export {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  DEFAULT_EXECUTOR_SERVER_USERNAME,
  EXECUTOR_ORG_SELECTOR_HEADER,
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
} from "./server-connection";

export {
  OAUTH_POPUP_MESSAGE_TYPE,
  type OAuthPopupResult,
  isOAuthPopupResult,
} from "./oauth-popup-types";

// Plugin definition.
export {
  type Plugin,
  type PluginSpec,
  type PluginCtx,
  type PluginExtensions,
  type ConfiguredPlugin,
  type AnyPlugin,
  type StorageDeps,
  type OwnerBinding,
  type ToolPolicyProvider,
  type ToolPolicyProviderRule,
  type IntegrationRecord,
  type StaticIntegrationDecl,
  type StaticToolDecl,
  type StaticToolSchema,
  type StaticToolExecuteContext,
  type StaticToolHandlerInput,
  type StaticToolInput,
  type ConfigureIntegrationHandlerInput,
  type InvokeToolInput,
  type ValidateToolArgsInput,
  type ConnectionLifecycleInput,
  type IntegrationConfigureDecl,
  type IntegrationConfigureSchema,
  type IntegrationPreset,
  type IntegrationPresetAuthentication,
  type IntegrationPresetCatalogEntry,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type ToolInvocationCredential,
  type HealthCheckInput,
  type HealthCheckCandidatesInput,
  type Elicit,
  definePlugin,
  tool,
} from "./plugin";

// Executor.
//
// `collectTables` is host/tooling-only (cli schema cmd, kernel worker,
// local/cloud DB bring-up). Its definition stays here because `createExecutor`
// uses it; the host surface (`@executor-js/api/server`) re-exports it.
export {
  type Executor,
  type ExecutorConfig,
  type ExecutorDb,
  type ExecutorDbFactory,
  type ExecutorDbInput,
  type ParsedToolAddress,
  createExecutor,
  collectTables,
  parseToolAddress,
  connectionAddress,
  toolAddress,
} from "./executor";

// CLI / runtime config.
export {
  defineExecutorConfig,
  type ExecutorCliConfig,
  type ExecutorPluginsFactory,
} from "./config";

// The one TS-preview generator plugins assert against.
export { buildToolTypeScriptPreview } from "./schema-types";

// Wire-level HTTP error schemas usable by plugin HttpApiGroup definitions.
export { InternalError } from "./api-errors";

// ToolResult — typed value-based discriminated union for tool outcomes.
export {
  ToolFileSchema,
  ToolFileJsonSchema,
  ToolResult,
  annotateToolResultOutcome,
  isToolFile,
  isToolResult,
  type ToolFile,
  type ToolFile as ToolFileValue,
  type ToolError,
  type ToolHttpMeta,
} from "./tool-result";

// Connection catalog census is a server-owned, hash-only catalog proof. The
// finalizer and hash helpers are public contract utilities; raw validation
// helpers remain private to the module boundary.
export {
  CONNECTION_CATALOG_CENSUS_MAX_CANONICAL_BYTES,
  CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS,
  CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS_PER_PAGE,
  CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTOR_BYTES,
  CONNECTION_CATALOG_CENSUS_MAX_PAGES,
  CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES,
  CONNECTION_CATALOG_CENSUS_OPERATION_KEY,
  CONNECTION_CATALOG_CENSUS_OPERATION_VERSION,
  CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION,
  CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION,
  CONNECTION_CATALOG_CENSUS_TARGET,
  ConnectionCatalogCensusDescriptor,
  ConnectionCatalogCensusError,
  ConnectionCatalogCensusFailureReason,
  ConnectionCatalogCensusInput,
  ConnectionCatalogCensusOwner,
  ConnectionCatalogCensusRequest,
  ConnectionCatalogCensusResult,
  ConnectionCatalogCensusTransport,
  canonicalizeConnectionCatalogValue,
  finalizeConnectionCatalogCensus,
  hashConnectionCatalogBinding,
  hashConnectionCatalogValue,
  type ConnectionCatalogCanonicalSnapshot,
  type ConnectionCatalogCensusBinding,
  type ConnectionCatalogCensusDescriptorInput,
  type ConnectionCatalogCensusFailureReason as ConnectionCatalogCensusFailureReasonV1,
  type ConnectionCatalogCensusPage,
  type ConnectionCatalogCensusSource,
  type ConnectionCatalogCensusResult as ConnectionCatalogCensusResultV1,
  type ConnectionCatalogCensusTransport as ConnectionCatalogCensusTransportV1,
  type ConnectionCatalogCensusOwner as ConnectionCatalogCensusOwnerV1,
  type ConnectionCatalogCensusRequest as ConnectionCatalogCensusRequestV1,
  type ConnectionCatalogCensusInput as ConnectionCatalogCensusInputV1,
  type ConnectionCatalogCensusDescriptor as ConnectionCatalogCensusDescriptorV1,
} from "./connection-catalog-census";

// Deterministic, credential-free census conformance fixture. This is test
// data only and does not register or implement a provider operation.
export {
  CONNECTION_CATALOG_CENSUS_GOLDEN_BINDING,
  CONNECTION_CATALOG_CENSUS_GOLDEN_OBSERVED_AT,
  CONNECTION_CATALOG_CENSUS_GOLDEN_REQUEST,
  CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT,
  CONNECTION_CATALOG_CENSUS_GOLDEN_SOURCE,
} from "./connection-catalog-census-fixtures";

// Stamped boot-time data-migration ledger for the libSQL-backed apps.
export {
  DataMigrationError,
  DuplicateDataMigrationError,
  runSqliteDataMigrations,
  sqliteDataMigration,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "./sqlite-data-migrations";
// Shared inline-config-field → blob-table migration body; the protocol
// plugins bind their field names and export the ledger entries.
export {
  runSqliteConfigBlobMigration,
  type SqliteConfigBlobMigrationOptions,
} from "./sqlite-config-blob-migration";
// DCR oauth_client GC + issuer backfill: shared classification predicates and
// the libSQL boot-migration body (issue #1120, Part C).
export {
  classifyOAuthClientGc,
  isDcrClassifiedRow,
  registrableOriginOfUrl,
  type OAuthClientGcDecision,
  type OAuthClientGcRow,
} from "./oauth-gc";
export {
  oauthClientGcSqliteMigration,
  runSqliteOAuthClientGcMigration,
} from "./sqlite-oauth-client-gc-migration";
export {
  authToolFailure,
  type AuthToolFailureCode,
  type AuthToolFailureInput,
} from "./auth-tool-failure";
export {
  detectInsufficientScope,
  insufficientScopeFromEmbeddedJson,
  type InsufficientScopeDetection,
} from "./insufficient-scope";
