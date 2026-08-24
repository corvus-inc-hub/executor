// ---------------------------------------------------------------------------
// @executor-js/sdk/shared — browser-safe domain contracts.
//
// For React and plugin UI code that needs the v2 runtime ids, tagged errors,
// policy helpers, and wire contracts without importing the server/plugin SDK
// root (which pulls fumadb / node). Everything re-exported here must be
// browser-safe: pure Effect/Schema, no `fuma-runtime` / `core-schema` value
// imports. (The `ToolPolicyAction` *type* is fine — types erase at runtime.)
// ---------------------------------------------------------------------------

// Branded ids + the owner literal.
export {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  ElicitationId,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  Owner,
  PolicyId,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
export { connectionIdentifier, isConnectionIdentifier } from "./connection-name-identifier";

// Domain projections (types only — no runtime cost).
export type {
  AuthMethodDescriptor,
  AuthMethodOAuthDescriptor,
  AuthPlacementDescriptor,
  Integration,
  IntegrationConfig,
  IntegrationDisplayDescriptor,
} from "./integration";
export type {
  Connection,
  ConnectionRef,
  ConnectionValueInput,
  CreateConnectionInput,
  UpdateConnectionInput,
  ValidateConnectionInput,
} from "./connection";
export type { CredentialProvider, ProviderEntry } from "./provider";
export type { Tool, ToolDef, ToolListFilter, ToolAnnotations } from "./tool";

// Carrier-neutral operation contracts. The execution implementation remains
// server-only on Executor.executeOperation, while these schemas are safe for
// typed HTTP/MCP clients and browser-facing API definitions.
export {
  EXECUTE_OPERATION_SCHEMA_VERSION,
  ExecuteOperationApproval,
  ExecuteOperationApprovalDecision,
  ExecuteOperationCarrier,
  ExecuteOperationFailure,
  ExecuteOperationPolicy,
  ExecuteOperationPolicyDecision,
  ExecuteOperationPolicySource,
  ExecuteOperationProviderTransport,
  ExecuteOperationRequest,
  ExecuteOperationRequestCodec,
  ExecuteOperationResult,
  ExecuteOperationResultCodec,
  ExecuteOperationStatus,
  OperationContractError,
  OperationDescriptorMismatchError,
  OperationSchemaValidationError,
  OperationSecretRejectedError,
  OperationRequestHashMismatchError,
  ProviderReceipt,
  ProviderReconciliation,
  ProviderReconciliationStatus,
  canonicalExecuteOperationRequest,
  canonicalOperationJson,
  canonicalizeOperationValue,
  deriveOperationDescriptor,
  hashExecuteOperationRequest,
  hashOperationValue,
  makeInMemoryOperationReplayStore,
  validateOperationSchema,
  type CanonicalOperationSnapshot,
  type ExecuteOperationDefinition,
  type ExecuteOperationDescriptor,
  type ExecuteOperationError,
  type ExecuteOperationApprovalContext,
  type ExecuteOperationApprovalHandler,
  type ExecuteOperationReplayReservation,
  type ExecuteOperationReplayStore,
} from "./operation";

// Deterministic adapter-conformance fixture. This is a public echo contract,
// not a GitHub operation implementation; see the module documentation.
export {
  GOLDEN_OPERATION_DEFINITION,
  GOLDEN_OPERATION_DESCRIPTOR,
  GOLDEN_OPERATION_DESCRIPTOR_CANONICAL,
  GOLDEN_OPERATION_DESCRIPTOR_SHA256,
  GOLDEN_OPERATION_OUTPUT_SHA256,
  GOLDEN_OPERATION_REQUEST,
  GOLDEN_OPERATION_REQUEST_CANONICAL,
  GOLDEN_OPERATION_REQUEST_SHA256,
  GOLDEN_OPERATION_RESULT,
} from "./operation-fixtures";

// Tagged errors (Schema-based — browser-safe).
export {
  ToolNotFoundError,
  ToolInvocationError,
  ToolBlockedError,
  PluginNotLoadedError,
  NoHandlerError,
  IntegrationNotFoundError,
  IntegrationAlreadyExistsError,
  IntegrationRemovalNotAllowedError,
  ConnectionNotFoundError,
  InvalidConnectionInputError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  isUserActionableError,
  type ExecuteError,
  type ExecutorError,
  type UserActionableError,
} from "./errors";

// Elicitation wire schemas.
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  ElicitationDeclinedError,
  type ElicitationRequest,
  type ElicitationContext,
  type ElicitationHandler,
  type OnElicitation,
  type InvokeOptions,
} from "./elicitation";

// Tool-policy helpers + projections (pure functions / Schema).
export {
  matchPattern,
  isValidPattern,
  effectivePolicyFromSorted,
  comparePolicyRow,
  patternSpecificity,
  positionForNewPattern,
  ToolPolicyActionSchema,
  type ToolPolicy,
  type CreateToolPolicyInput,
  type UpdateToolPolicyInput,
  type RemoveToolPolicyInput,
  type PolicyMatch,
  type EffectivePolicy,
  type PolicySource,
} from "./policies";
export type { ToolPolicyAction } from "./core-schema";

// Schema-side views + onboarding autodetect.
export { ToolSchemaView, IntegrationDetectionResult } from "./types";

export {
  decodeOAuthCallbackState,
  encodeOAuthCallbackState,
  type OAuthCallbackState,
} from "./oauth";

// Health-check vocabulary (pure Schema + helpers).
export {
  HealthStatus,
  HealthCheckSpec,
  HealthCheckResult,
  HealthCheckCandidate,
  HealthCheckCandidateParameter,
  classifyHttpStatus,
  extractIdentity,
  compareHealthCheckCandidates,
  candidateIdentityTier,
  sortHealthCheckCandidatesByIdentity,
  identityPathTier,
  rankResponseSample,
} from "./health-check";

// OAuth wire contracts (data + tagged errors; the flow impl is server-only).
export {
  type OAuthGrant,
  type OAuthAuthentication,
  type OAuthClient,
  type OAuthClientOrigin,
  type OAuthClientSummary,
  type CreateOAuthClientInput,
  type RegisterDynamicClientInput,
  type ConnectResult,
  type OAuthStartInput,
  type OAuthCompleteInput,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthService,
  OAuthStartError,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
} from "./oauth-client";

// Wire-level HTTP error schema for plugin HttpApiGroup definitions.
export { InternalError } from "./api-errors";

// Executor server connection contracts (browser-safe).
export {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  DEFAULT_EXECUTOR_SERVER_USERNAME,
  EXECUTOR_ORG_SELECTOR_HEADER,
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  parseExecutorLocalServerManifest,
  serializeExecutorLocalServerManifest,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
  type ExecutorLocalServerKind,
  type ExecutorLocalServerManifest,
} from "./server-connection";

// OAuth popup postMessage contract (browser-safe).
export {
  OAUTH_POPUP_MESSAGE_TYPE,
  type OAuthPopupResult,
  isOAuthPopupResult,
} from "./oauth-popup-types";
