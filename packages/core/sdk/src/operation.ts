import { Effect, Schema } from "effect";

import type { StaticToolSchema } from "./plugin";
import type { OwnerBinding } from "./plugin";
import type { StorageFailure } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  Owner,
  ProviderKey,
  ToolAddress,
} from "./ids";

/**
 * Carrier-neutral operation contracts.
 *
 * An operation request contains an operation key, not a tool address. The
 * address, provider transport, and schemas are resolved from the host-owned
 * registry. This is intentional: a caller can ask for a reviewed operation,
 * but cannot redirect that operation to another tool or provider.
 */
export const EXECUTE_OPERATION_SCHEMA_VERSION = "executor.operation.v2" as const;

export const ExecuteOperationCarrier = Schema.Literals(["internal", "http", "mcp"]);
export type ExecuteOperationCarrier = typeof ExecuteOperationCarrier.Type;

export const ExecuteOperationProviderTransport = Schema.Literals([
  "none",
  "http",
  "graphql",
  "mcp",
  "unknown",
]);
export type ExecuteOperationProviderTransport = typeof ExecuteOperationProviderTransport.Type;

export const ExecuteOperationStatus = Schema.Literals([
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
export type ExecuteOperationStatus = typeof ExecuteOperationStatus.Type;

export const ExecuteOperationPolicyDecision = Schema.Literals([
  "allow",
  "require_approval",
  "deny",
]);
export type ExecuteOperationPolicyDecision = typeof ExecuteOperationPolicyDecision.Type;

export const ExecuteOperationPolicySource = Schema.Literals(["user", "plugin-default"]);
export type ExecuteOperationPolicySource = typeof ExecuteOperationPolicySource.Type;

export const ExecuteOperationApprovalDecision = Schema.Literals([
  "not_required",
  "approved",
  "declined",
  "cancelled",
]);
export type ExecuteOperationApprovalDecision = typeof ExecuteOperationApprovalDecision.Type;

/** Failure codes are a deliberately closed public vocabulary. Provider and
 * plugin-native tags stay inside the Executor and are mapped to one of these
 * stable projections before a result can cross a carrier. */
export const ExecuteOperationFailureCode = Schema.Literals([
  "operation_failed",
  "provider_error",
  "upstream_bad_request",
  "upstream_unauthorized",
  "upstream_forbidden",
  "upstream_not_found",
  "upstream_conflict",
  "upstream_rate_limited",
  "upstream_server_error",
  "tool_not_found",
  "tool_blocked",
  "credential_missing",
  "credential_invalid",
  "approval_handler_required",
  "approval_declined",
  "approval_cancelled",
  "output_schema_invalid",
  "provider_receipt_mismatch",
  "provider_receipt_unavailable",
  "operation_cancelled",
  "policy_blocked",
]);
export type ExecuteOperationFailureCode = typeof ExecuteOperationFailureCode.Type;

export const ProviderReconciliationStatus = Schema.Literals([
  "matched",
  "mismatch",
  "unavailable",
  "not_attempted",
]);
export type ProviderReconciliationStatus = typeof ProviderReconciliationStatus.Type;

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "ExecutorOperationSha256",
});

const OperationKey = Schema.NonEmptyString.annotate({ identifier: "ExecutorOperationKey" });

/** The only caller-supplied operation request fields. */
export const ExecuteOperationRequest = Schema.Struct({
  schemaVersion: Schema.Literal(EXECUTE_OPERATION_SCHEMA_VERSION),
  operationKey: OperationKey,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  jobId: Schema.NonEmptyString,
  descriptorSha256: Sha256,
  requestSha256: Sha256,
  /** Public operation input. Credentials are resolved by the executor after
   * policy and approval, and are never part of this contract. */
  input: Schema.Unknown,
}).annotate({ identifier: "ExecutorOperationRequestV2" });
export type ExecuteOperationRequest = typeof ExecuteOperationRequest.Type;

/** A reviewed operation definition owned by the Executor host. */
export interface ExecuteOperationDefinition {
  readonly operationKey: string;
  readonly version: number;
  readonly target: ToolAddress;
  readonly inputSchema: StaticToolSchema;
  readonly outputSchema: StaticToolSchema;
  readonly providerTransport: ExecuteOperationProviderTransport;
  /** Stable host-reviewed binding semantics. Function fields are deliberately
   * excluded from the descriptor, so this tuple makes a resolver change
   * visible to callers and stored requests. All three fields are required
   * together when a binding resolver is configured. */
  readonly bindingMode?: string;
  readonly bindingKey?: string;
  readonly bindingVersion?: number;
  /** Host-owned resolver for the connection/resource lineage used by this
   * operation. It receives only the executor's ambient owner and canonical
   * request/input values, never caller-selected authority or transport. */
  readonly bindingResolver?: ExecuteOperationBindingResolver;
  readonly description?: string;
}

export interface ExecuteOperationDescriptor {
  readonly schemaVersion: typeof EXECUTE_OPERATION_SCHEMA_VERSION;
  readonly operationKey: string;
  readonly version: number;
  readonly target: ToolAddress;
  readonly providerTransport: ExecuteOperationProviderTransport;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly bindingMode?: string;
  readonly bindingKey?: string;
  readonly bindingVersion?: number;
  readonly descriptorSha256: string;
}

/** The reviewed, stable implementation identity for a binding resolver. */
export interface ExecuteOperationBindingDefinition {
  readonly mode: string;
  readonly key: string;
  readonly version: number;
}

interface OperationDescriptorPayload {
  readonly schemaVersion: typeof EXECUTE_OPERATION_SCHEMA_VERSION;
  readonly operationKey: string;
  readonly version: number;
  readonly target: string;
  readonly providerTransport: ExecuteOperationProviderTransport;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly bindingMode?: string;
  readonly bindingKey?: string;
  readonly bindingVersion?: number;
}

/** Non-secret connection identity returned by a host-owned binding resolver.
 * Generation and catalog revision are opaque immutable lineage values; the
 * Executor never interprets them or exposes credentials behind them. */
export interface ExecuteOperationResolvedConnection {
  readonly address: ConnectionAddress;
  readonly owner: Owner;
  readonly integration: IntegrationSlug;
  readonly name: ConnectionName;
  readonly credentialProvider: ProviderKey;
  readonly template: AuthTemplateSlug;
  readonly generation: string;
  readonly catalogRevision: string;
  readonly sourceTransport: ExecuteOperationProviderTransport;
  readonly pluginId?: string;
}

export interface ExecuteOperationResolvedBinding {
  readonly bindingSha256: string;
  readonly connection: ExecuteOperationResolvedConnection;
}

/** The resolver receives only canonical values selected by the Executor. The
 * owner is an ambient host binding and the descriptor is host-derived, so a
 * request cannot inject tenant, subject, target, provider, or cursor state. */
export interface ExecuteOperationBindingResolverContext {
  readonly owner: Readonly<OwnerBinding>;
  readonly request: Readonly<ExecuteOperationRequest>;
  readonly descriptor: Readonly<ExecuteOperationDescriptor>;
  readonly input: unknown;
}

export type ExecuteOperationBindingResolver = (
  context: ExecuteOperationBindingResolverContext,
) => Effect.Effect<ExecuteOperationResolvedBinding, OperationContractError | StorageFailure>;

export const ExecuteOperationPolicy = Schema.Struct({
  decision: ExecuteOperationPolicyDecision,
  source: ExecuteOperationPolicySource,
  pattern: Schema.optional(Schema.String),
  policyId: Schema.optional(Schema.String),
}).annotate({ identifier: "ExecutorOperationPolicyV2" });
export type ExecuteOperationPolicy = typeof ExecuteOperationPolicy.Type;

const OperationTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
  Schema.isMaxLength(24),
).annotate({ identifier: "ExecutorOperationTimestamp" });

export const ExecuteOperationApproval = Schema.Struct({
  decision: ExecuteOperationApprovalDecision,
  tenant: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  jobId: Schema.NonEmptyString,
  operationKey: OperationKey,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  descriptorSha256: Sha256,
  requestSha256: Sha256,
  target: ToolAddress,
  providerTransport: ExecuteOperationProviderTransport,
  carrier: ExecuteOperationCarrier,
  policy: ExecuteOperationPolicy,
  /** Present only for operations with a host-owned binding resolver. */
  bindingSha256: Schema.optional(Sha256),
  /** Non-secret connection address associated with the approval. */
  connectionAddress: Schema.optional(ConnectionAddress),
  subject: Schema.optional(Schema.NonEmptyString),
  sessionId: Schema.NonEmptyString,
  decidedAt: Schema.optional(OperationTimestamp),
}).annotate({ identifier: "ExecutorOperationApprovalV2" });
export type ExecuteOperationApproval = typeof ExecuteOperationApproval.Type;

/** Provider facts are typed, bounded, and deliberately exclude raw headers,
 * bodies, query strings, and provider error messages. */
export const ProviderReceipt = Schema.Struct({
  transport: ExecuteOperationProviderTransport,
  /** Executor-stamped hash of the exact operation request that was invoked. */
  operationRequestSha256: Sha256,
  /** Optional provider-native request hash, if the adapter exposes one. */
  requestId: Schema.optional(
    Schema.NonEmptyString.check(
      Schema.isMaxLength(256),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
    ),
  ),
  providerRequestSha256: Schema.optional(Sha256),
  responseSha256: Schema.optional(Sha256),
  status: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
  ),
  observedAt: OperationTimestamp,
}).annotate({ identifier: "ExecutorOperationProviderReceiptV2" });
export type ProviderReceipt = typeof ProviderReceipt.Type;

export const ProviderReconciliation = Schema.Struct({
  status: ProviderReconciliationStatus,
  receipt: Schema.optional(ProviderReceipt),
}).annotate({ identifier: "ExecutorOperationProviderReconciliationV2" });
export type ProviderReconciliation = typeof ProviderReconciliation.Type;

/** Public failure projection. Never expose raw provider messages/details. */
export const ExecuteOperationFailure = Schema.Struct({
  code: ExecuteOperationFailureCode,
  status: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
  ),
  retryable: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ExecutorOperationFailureV2" });
export type ExecuteOperationFailure = typeof ExecuteOperationFailure.Type;

/** The authoritative result transported by every carrier. */
export const ExecuteOperationResult = Schema.Struct({
  schemaVersion: Schema.Literal(EXECUTE_OPERATION_SCHEMA_VERSION),
  operationKey: OperationKey,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  jobId: Schema.NonEmptyString,
  descriptorSha256: Sha256,
  requestSha256: Sha256,
  carrier: ExecuteOperationCarrier,
  target: ToolAddress,
  providerTransport: ExecuteOperationProviderTransport,
  executionId: Schema.NonEmptyString,
  policy: ExecuteOperationPolicy,
  approval: ExecuteOperationApproval,
  providerReconciliation: ProviderReconciliation,
  startedAt: OperationTimestamp,
  completedAt: OperationTimestamp,
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  status: ExecuteOperationStatus,
  outputSha256: Schema.NullOr(Sha256),
  output: Schema.optional(Schema.Unknown),
  failure: Schema.optional(ExecuteOperationFailure),
}).annotate({ identifier: "ExecutorOperationResultV2" });
export type ExecuteOperationResult = typeof ExecuteOperationResult.Type;

export const ExecuteOperationRequestCodec = {
  decode: Schema.decodeUnknownEffect(ExecuteOperationRequest),
  decodeResult: Schema.decodeUnknownResult(ExecuteOperationRequest),
  decodeSync: Schema.decodeUnknownSync(ExecuteOperationRequest),
  encode: Schema.encodeUnknownEffect(ExecuteOperationRequest),
  encodeResult: Schema.encodeUnknownResult(ExecuteOperationRequest),
  encodeSync: Schema.encodeUnknownSync(ExecuteOperationRequest),
} as const;

export const ExecuteOperationResultCodec = {
  decode: Schema.decodeUnknownEffect(ExecuteOperationResult),
  decodeResult: Schema.decodeUnknownResult(ExecuteOperationResult),
  decodeSync: Schema.decodeUnknownSync(ExecuteOperationResult),
  encode: Schema.encodeUnknownEffect(ExecuteOperationResult),
  encodeResult: Schema.encodeUnknownResult(ExecuteOperationResult),
  encodeSync: Schema.encodeUnknownSync(ExecuteOperationResult),
} as const;

export class OperationContractError extends Schema.TaggedErrorClass<OperationContractError>()(
  "OperationContractError",
  {
    field: Schema.String,
    reason: Schema.Literals([
      "invalid_request",
      "invalid_value",
      "unsupported_carrier",
      "unsupported_operation",
      "replay_in_progress",
      "schema_validation",
      "cycle",
      "too_deep",
      "too_large",
      "unsupported_object",
      "accessor_property",
      "non_enumerable_property",
      "symbol_property",
      "stale_reservation",
    ]),
  },
) {
  override get message(): string {
    return `Invalid Executor operation contract (${this.field}: ${this.reason}).`;
  }
}

export class OperationRequestHashMismatchError extends Schema.TaggedErrorClass<OperationRequestHashMismatchError>()(
  "OperationRequestHashMismatchError",
  {
    expected: Sha256,
    actual: Sha256,
  },
) {
  override get message(): string {
    return "Executor operation request hash does not match the canonical request.";
  }
}

export class OperationDescriptorMismatchError extends Schema.TaggedErrorClass<OperationDescriptorMismatchError>()(
  "OperationDescriptorMismatchError",
  {
    expected: Sha256,
    actual: Sha256,
  },
) {
  override get message(): string {
    return "Executor operation descriptor hash does not match the reviewed operation.";
  }
}

export class OperationSecretRejectedError extends Schema.TaggedErrorClass<OperationSecretRejectedError>()(
  "OperationSecretRejectedError",
  {
    field: Schema.String,
  },
) {
  override get message(): string {
    return `Executor operation rejected a credential or authorization field at ${this.field}.`;
  }
}

export class OperationSchemaValidationError extends Schema.TaggedErrorClass<OperationSchemaValidationError>()(
  "OperationSchemaValidationError",
  {
    field: Schema.Literals(["input", "output"]),
  },
) {
  override get message(): string {
    return `Executor operation ${this.field} did not satisfy its reviewed schema.`;
  }
}

export type ExecuteOperationError =
  | OperationContractError
  | OperationRequestHashMismatchError
  | OperationDescriptorMismatchError
  | OperationSecretRejectedError
  | OperationSchemaValidationError;

/**
 * The operation lifecycle is deliberately host-pluggable. The Executor
 * requires a host-provided store keyed by `(tenant, jobId)` whenever an
 * operation registry is configured; there is no implicit process-local
 * fallback. A reservation is the atomic boundary that prevents two carriers
 * from invoking the same provider operation concurrently.
 */
export type ExecuteOperationReplayReservation =
  | { readonly status: "reserved"; readonly reservationToken: string }
  | { readonly status: "replay"; readonly result: ExecuteOperationResult }
  | { readonly status: "in_progress" }
  | {
      readonly status: "conflict";
      readonly requestSha256: string;
      readonly bindingSha256?: string;
    };

export const ExecuteOperationReplaySettleStatus = Schema.Literals(["settled", "stale"]);
export type ExecuteOperationReplaySettleStatus = typeof ExecuteOperationReplaySettleStatus.Type;

export interface ExecuteOperationReplayStore<E = never> {
  /**
   * Durable stores are required for cloud operation registries. The
   * process-local implementation is exported only for tests and explicitly
   * local development, and is rejected by createExecutor by default.
   */
  readonly durability: "durable" | "process-local";
  /**
   * A durable implementation must make reserve/settle atomic across
   * instances and define recovery for a reservation that never settles (for
   * example, an owner token with a lease or an explicit reconciliation path).
   * This SDK deliberately does not pretend to provide that cloud protocol.
   */
  readonly reserve: (input: {
    readonly tenant: string;
    /** Subject is part of replay identity when the executor is user-scoped. */
    readonly subject?: string;
    readonly jobId: string;
    readonly requestSha256: string;
    /** Optional for byte-compatible unbound operations. Bound operations must
     * include the resolver's immutable lineage hash in the replay identity. */
    readonly bindingSha256?: string;
  }) => Effect.Effect<ExecuteOperationReplayReservation, E>;
  readonly settle: (input: {
    readonly tenant: string;
    readonly subject?: string;
    readonly jobId: string;
    readonly requestSha256: string;
    readonly bindingSha256?: string;
    readonly reservationToken: string;
    readonly result: ExecuteOperationResult;
  }) => Effect.Effect<ExecuteOperationReplaySettleStatus, E>;
}

/**
 * The context an operation-specific approval adapter must bind before it can
 * grant a provider invocation. This is separate from generic elicitation:
 * this identity is what a host persists when it pauses an operation.
 */
export interface ExecuteOperationApprovalContext {
  readonly tenant: string;
  readonly executionId: string;
  readonly jobId: string;
  readonly operationKey: string;
  readonly version: number;
  readonly requestSha256: string;
  readonly descriptorSha256: string;
  readonly target: ToolAddress;
  readonly providerTransport: ExecuteOperationProviderTransport;
  readonly carrier: ExecuteOperationCarrier;
  readonly policy: ExecuteOperationPolicy;
  /** Present only for operations with a host-owned binding resolver. */
  readonly bindingSha256?: string;
  /** Non-secret connection address associated with the approval. */
  readonly connectionAddress?: ConnectionAddress;
  readonly subject?: string;
  readonly sessionId: string;
}

export type ExecuteOperationApprovalHandler = (
  context: ExecuteOperationApprovalContext,
) => Effect.Effect<"approved" | "declined" | "cancelled">;

/**
 * Reference store for tests and explicitly local hosts. Production hosts must
 * provide a durable implementation to `createExecutor`; exporting this
 * helper keeps that choice explicit in tests rather than hiding a process
 * local ledger behind the default.
 */
export const makeInMemoryOperationReplayStore = (): ExecuteOperationReplayStore => {
  type Entry = {
    readonly requestSha256: string;
    readonly bindingSha256?: string;
    readonly reservationToken: string;
    readonly result?: ExecuteOperationResult;
  };
  const entries = new Map<string, Entry>();
  return {
    durability: "process-local" as const,
    reserve: ({ tenant, subject, jobId, requestSha256, bindingSha256 }) =>
      Effect.sync(() => {
        const key = JSON.stringify([tenant, subject ?? null, jobId, bindingSha256 ?? null]);
        const existing = entries.get(key);
        if (!existing) {
          const reservationToken = crypto.randomUUID();
          entries.set(key, { requestSha256, bindingSha256, reservationToken });
          return { status: "reserved" as const, reservationToken };
        }
        if (existing.requestSha256 !== requestSha256) {
          if (existing.bindingSha256 === undefined) {
            return { status: "conflict" as const, requestSha256: existing.requestSha256 };
          }
          return {
            status: "conflict" as const,
            requestSha256: existing.requestSha256,
            bindingSha256: existing.bindingSha256,
          };
        }
        return existing.result
          ? { status: "replay" as const, result: existing.result }
          : { status: "in_progress" as const };
      }),
    settle: ({ tenant, subject, jobId, requestSha256, bindingSha256, reservationToken, result }) =>
      Effect.sync(() => {
        const key = JSON.stringify([tenant, subject ?? null, jobId, bindingSha256 ?? null]);
        const existing = entries.get(key);
        if (
          existing?.requestSha256 === requestSha256 &&
          existing.bindingSha256 === bindingSha256 &&
          existing.reservationToken === reservationToken
        ) {
          entries.set(key, { requestSha256, bindingSha256, reservationToken, result });
          return "settled" as const;
        }
        return "stale" as const;
      }),
  };
};

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface CanonicalOperationSnapshot {
  readonly value: JsonValue;
  readonly canonical: string;
}

const MAX_OPERATION_DEPTH = 32;
const MAX_OPERATION_NODES = 10_000;
const MAX_OPERATION_BYTES = 1_000_000;

/* These names are intentionally conservative. Operation schemas are the
 * primary credential boundary; this scanner is defense in depth and rejects
 * common aliases that should never cross a public operation boundary. */
const SECRET_FIELD =
  /access.?token|access.?key|admin.?key|api.?key|authorization|auth.?header|credential|client.?secret|password|passwd|private.?key|refresh.?token|secret|github.?pat|personal.?access.?token|aws.?access.?key.?id|aws.?secret|aws.?session|token/i;

const isSecretField = (key: string): boolean => SECRET_FIELD.test(key.trim().replace(/[-_]/g, ""));

const pathForKey = (path: string, key: string): string =>
  path === "$" ? `$.${key}` : `${path}.${key}`;

const reflectContract = <A>(
  field: string,
  read: () => A,
): Effect.Effect<A, OperationContractError> =>
  Effect.try({
    try: read,
    catch: () => new OperationContractError({ field, reason: "invalid_value" }),
  });

const freezeDeep = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const child of value) freezeDeep(child);
  } else {
    for (const child of Object.values(value)) freezeDeep(child);
  }
  Object.freeze(value);
};

const ownEnumerableDataKeys = (
  value: object,
  path: string,
): Effect.Effect<
  readonly { readonly key: string; readonly descriptor: PropertyDescriptor }[],
  OperationContractError
> =>
  Effect.gen(function* () {
    // Array `length` is an intrinsic non-enumerable property, not caller data.
    // It is validated separately against the enumerable numeric indices below.
    const isArray = yield* reflectContract(path, () => Array.isArray(value));
    const names = yield* reflectContract(path, () => Object.getOwnPropertyNames(value));
    const symbols = yield* reflectContract(path, () => Object.getOwnPropertySymbols(value));
    if (symbols.length > 0) {
      return yield* new OperationContractError({ field: path, reason: "symbol_property" });
    }
    const entries: { key: string; descriptor: PropertyDescriptor }[] = [];
    for (const key of names) {
      if (isArray && key === "length") continue;
      const descriptor = yield* reflectContract(pathForKey(path, key), () =>
        Object.getOwnPropertyDescriptor(value, key),
      );
      if (!descriptor) {
        return yield* new OperationContractError({
          field: pathForKey(path, key),
          reason: "invalid_value",
        });
      }
      if (!descriptor.enumerable) {
        return yield* new OperationContractError({
          field: pathForKey(path, key),
          reason: "non_enumerable_property",
        });
      }
      if (!("value" in descriptor)) {
        return yield* new OperationContractError({
          field: pathForKey(path, key),
          reason: "accessor_property",
        });
      }
      entries.push({ key, descriptor });
    }
    return entries.sort((left, right) => left.key.localeCompare(right.key));
  });

const toJsonValue = (
  value: unknown,
  path: string,
  stack: Set<object>,
  state: { nodes: number },
  depth: number,
): Effect.Effect<JsonValue, OperationContractError | OperationSecretRejectedError> =>
  Effect.gen(function* () {
    state.nodes += 1;
    if (state.nodes > MAX_OPERATION_NODES) {
      return yield* new OperationContractError({ field: path, reason: "too_large" });
    }
    if (depth > MAX_OPERATION_DEPTH) {
      return yield* new OperationContractError({ field: path, reason: "too_deep" });
    }
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      return Number.isFinite(value)
        ? value
        : yield* new OperationContractError({ field: path, reason: "invalid_value" });
    }
    if (typeof value !== "object") {
      return yield* new OperationContractError({ field: path, reason: "invalid_value" });
    }
    if (stack.has(value)) {
      return yield* new OperationContractError({ field: path, reason: "cycle" });
    }

    const checkedPrototype = yield* reflectContract(path, () => Object.getPrototypeOf(value));
    const checkedIsArray = yield* reflectContract(path, () => Array.isArray(value));
    if (!checkedIsArray && checkedPrototype !== Object.prototype && checkedPrototype !== null) {
      return yield* new OperationContractError({ field: path, reason: "unsupported_object" });
    }

    stack.add(value);
    const result = checkedIsArray
      ? Effect.gen(function* () {
          const entries = yield* ownEnumerableDataKeys(value, path);
          const keys = entries.map(({ key }) => key);
          const indexes = entries
            .filter(({ key }) => /^\d+$/.test(key))
            .sort((left, right) => Number(left.key) - Number(right.key));
          const length = yield* reflectContract(path, () => Reflect.get(value, "length"));
          if (
            typeof length !== "number" ||
            keys.length !== length ||
            indexes.length !== keys.length ||
            indexes.some(({ key }, i) => Number(key) !== i)
          ) {
            return yield* new OperationContractError({ field: path, reason: "invalid_value" });
          }
          const array: JsonValue[] = [];
          for (let index = 0; index < length; index += 1) {
            const descriptor = indexes[index]?.descriptor;
            if (!descriptor || !("value" in descriptor)) {
              return yield* new OperationContractError({ field: path, reason: "invalid_value" });
            }
            array.push(
              yield* toJsonValue(descriptor.value, `${path}[${index}]`, stack, state, depth + 1),
            );
          }
          return array;
        })
      : Effect.gen(function* () {
          const entries = yield* ownEnumerableDataKeys(value, path);
          const object = Object.create(null) as Record<string, JsonValue>;
          for (const { key, descriptor } of entries) {
            if (isSecretField(key)) {
              return yield* new OperationSecretRejectedError({ field: pathForKey(path, key) });
            }
            object[key] = yield* toJsonValue(
              descriptor.value,
              pathForKey(path, key),
              stack,
              state,
              depth + 1,
            );
          }
          return object;
        });

    return yield* Effect.ensuring(
      result as Effect.Effect<JsonValue, OperationContractError | OperationSecretRejectedError>,
      Effect.sync(() => {
        stack.delete(value);
      }),
    );
  });

/**
 * Clone, freeze, and canonicalize a public JSON value. The recursion stack,
 * rather than a global seen set, permits repeated references while rejecting
 * true cycles. This is the codec used for all operation hashes and wire
 * snapshots, so carrier adapters cannot invent a second JSON interpretation.
 */
export const canonicalizeOperationValue = (
  value: unknown,
): Effect.Effect<
  CanonicalOperationSnapshot,
  OperationContractError | OperationSecretRejectedError
> =>
  Effect.gen(function* () {
    const state = { nodes: 0 };
    const json = yield* toJsonValue(value, "$", new Set<object>(), state, 0);
    const canonical = JSON.stringify(json);
    if (new TextEncoder().encode(canonical).byteLength > MAX_OPERATION_BYTES) {
      return yield* new OperationContractError({ field: "$", reason: "too_large" });
    }
    freezeDeep(json);
    return { value: json, canonical };
  });

/** Canonical JSON for a public value. */
export const canonicalOperationJson = (
  value: unknown,
): Effect.Effect<string, OperationContractError | OperationSecretRejectedError> =>
  canonicalizeOperationValue(value).pipe(Effect.map((snapshot) => snapshot.canonical));

const standardSchemaRoot = (schema: StaticToolSchema, side: "input" | "output"): unknown => {
  const standard = schema["~standard"] as unknown;
  if (typeof standard !== "object" || standard === null) return schema;
  const jsonSchema = (standard as { readonly jsonSchema?: unknown }).jsonSchema;
  if (typeof jsonSchema !== "object" || jsonSchema === null) return schema;
  const materialize = (jsonSchema as { readonly input?: unknown; readonly output?: unknown })[side];
  return typeof materialize === "function"
    ? (materialize as (options: { readonly target: "draft-07" }) => unknown)({ target: "draft-07" })
    : jsonSchema;
};

const OPERATION_BINDING_IDENTIFIER = /^[a-z][a-z0-9._-]*$/;
const OPERATION_BINDING_IDENTIFIER_MAX_LENGTH = 128;

const OperationBindingIdentifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(OPERATION_BINDING_IDENTIFIER_MAX_LENGTH),
  Schema.isPattern(OPERATION_BINDING_IDENTIFIER),
).annotate({ identifier: "ExecutorOperationBindingIdentifier" });

const OperationBindingVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
  identifier: "ExecutorOperationBindingVersion",
});

const OperationBindingFieldsSchema = Schema.Struct({
  mode: Schema.optional(OperationBindingIdentifier),
  key: Schema.optional(OperationBindingIdentifier),
  version: Schema.optional(OperationBindingVersion),
}).annotate({ identifier: "ExecutorOperationBindingFields" });
type OperationBindingFields = typeof OperationBindingFieldsSchema.Type;

const operationBindingFields = (
  definition: ExecuteOperationDefinition,
): OperationBindingFields => ({
  mode: definition.bindingMode,
  key: definition.bindingKey,
  version: definition.bindingVersion,
});

const hasOperationBindingField = (definition: ExecuteOperationDefinition): boolean => {
  const fields = operationBindingFields(definition);
  return fields.mode !== undefined || fields.key !== undefined || fields.version !== undefined;
};

const validateOperationBindingDefinition = (
  definition: ExecuteOperationDefinition,
): Effect.Effect<ExecuteOperationBindingDefinition | undefined, OperationContractError> =>
  Effect.gen(function* () {
    if (!hasOperationBindingField(definition)) return undefined;
    const fields = yield* Schema.decodeUnknownEffect(OperationBindingFieldsSchema)(
      operationBindingFields(definition),
    ).pipe(
      Effect.mapError(
        () => new OperationContractError({ field: "binding", reason: "invalid_value" }),
      ),
    );
    if (fields.mode === undefined || fields.key === undefined || fields.version === undefined) {
      return yield* new OperationContractError({ field: "binding", reason: "invalid_value" });
    }
    return {
      mode: fields.mode,
      key: fields.key,
      version: fields.version,
    };
  });

const descriptorPayload = (
  definition: ExecuteOperationDefinition,
  binding?: ExecuteOperationBindingDefinition,
): OperationDescriptorPayload => {
  const payload = {
    schemaVersion: EXECUTE_OPERATION_SCHEMA_VERSION,
    operationKey: definition.operationKey,
    version: definition.version,
    target: String(definition.target),
    providerTransport: definition.providerTransport,
    inputSchema: standardSchemaRoot(definition.inputSchema, "input"),
    outputSchema: standardSchemaRoot(definition.outputSchema, "output"),
  };
  if (binding === undefined) return payload;
  return {
    ...payload,
    bindingMode: binding.mode,
    bindingKey: binding.key,
    bindingVersion: binding.version,
  };
};

const hashCanonicalJson = (
  canonical: string,
  field: string,
): Effect.Effect<string, OperationContractError> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
    catch: () => new OperationContractError({ field, reason: "invalid_value" }),
  }).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

/** Derive the immutable descriptor hash from the host-owned registry entry. */
export const deriveOperationDescriptor = (
  definition: ExecuteOperationDefinition,
): Effect.Effect<
  ExecuteOperationDescriptor,
  OperationContractError | OperationSecretRejectedError
> =>
  Effect.gen(function* () {
    if (!/^[a-z][a-z0-9._-]*$/.test(definition.operationKey)) {
      return yield* new OperationContractError({ field: "operationKey", reason: "invalid_value" });
    }
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      return yield* new OperationContractError({ field: "version", reason: "invalid_value" });
    }
    const binding = yield* validateOperationBindingDefinition(definition);
    const payload = descriptorPayload(definition, binding);
    const canonical = yield* canonicalOperationJson(payload);
    const descriptorSha256 = yield* hashCanonicalJson(canonical, "descriptorSha256");
    const descriptorBase = {
      schemaVersion: EXECUTE_OPERATION_SCHEMA_VERSION,
      operationKey: definition.operationKey,
      version: definition.version,
      target: definition.target,
      providerTransport: definition.providerTransport,
      inputSchema: payload.inputSchema,
      outputSchema: payload.outputSchema,
      descriptorSha256,
    } satisfies ExecuteOperationDescriptor;
    if (binding === undefined) return descriptorBase;
    return {
      ...descriptorBase,
      bindingMode: binding.mode,
      bindingKey: binding.key,
      bindingVersion: binding.version,
    };
  });

const requestHashPayload = (request: ExecuteOperationRequest): Record<string, unknown> => ({
  schemaVersion: request.schemaVersion,
  operationKey: request.operationKey,
  version: request.version,
  jobId: request.jobId,
  descriptorSha256: request.descriptorSha256,
  input: request.input,
});

/** Canonical request bytes covered by `requestSha256`. */
export const canonicalExecuteOperationRequest = (
  request: ExecuteOperationRequest,
): Effect.Effect<string, OperationContractError | OperationSecretRejectedError> =>
  canonicalOperationJson(requestHashPayload(request));

export const hashOperationValue = (
  value: unknown,
): Effect.Effect<string, OperationContractError | OperationSecretRejectedError> =>
  canonicalOperationJson(value).pipe(
    Effect.flatMap((canonical) => hashCanonicalJson(canonical, "value")),
  );

export const hashExecuteOperationRequest = (
  request: ExecuteOperationRequest,
): Effect.Effect<string, OperationContractError | OperationSecretRejectedError> =>
  canonicalExecuteOperationRequest(request).pipe(
    Effect.flatMap((canonical) => hashCanonicalJson(canonical, "requestSha256")),
  );

/** Public schema validation is the primary boundary. The strict codec runs
 * before and after validation so validators cannot observe a mutable caller
 * object or return an unbounded/non-JSON value. */
export const validateOperationSchema = (
  schema: StaticToolSchema,
  value: unknown,
  field: "input" | "output",
): Effect.Effect<
  unknown,
  OperationContractError | OperationSecretRejectedError | OperationSchemaValidationError
> =>
  Effect.gen(function* () {
    const snapshot = yield* canonicalizeOperationValue(value);
    const decoded = yield* Effect.tryPromise({
      try: () => Promise.resolve(schema["~standard"].validate(snapshot.value)),
      catch: () => new OperationSchemaValidationError({ field }),
    });
    const decodedValue = yield* Effect.try({
      try: () => {
        if (typeof decoded !== "object" || decoded === null) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(decoded, "value");
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
      },
      catch: () => new OperationContractError({ field, reason: "invalid_value" }),
    });
    if (decodedValue === undefined) return yield* new OperationSchemaValidationError({ field });
    const checked = yield* canonicalizeOperationValue(decodedValue);
    return checked.value;
  });
