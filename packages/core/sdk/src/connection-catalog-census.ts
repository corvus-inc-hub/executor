import {
  Effect,
  Match,
  Option,
  Predicate,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

/** Fixed, server-owned operation identity. */
export const CONNECTION_CATALOG_CENSUS_OPERATION_KEY =
  "executor.connection.catalog.census.v1" as const;
export const CONNECTION_CATALOG_CENSUS_OPERATION_VERSION = 1 as const;
export const CONNECTION_CATALOG_CENSUS_TARGET = "executor.connection.catalog.census" as const;
export const CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION =
  "executor.connection-catalog-census-request.v1" as const;
export const CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION =
  "executor.connection-catalog-census-result.v1" as const;

export const CONNECTION_CATALOG_CENSUS_MAX_PAGES = 100;
export const CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS = 10_000;
export const CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS_PER_PAGE = 1_000;
export const CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES = 4_096;
export const CONNECTION_CATALOG_CENSUS_MAX_CANONICAL_BYTES = 2_000_000;
export const CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTOR_BYTES = 1_000_000;

export const ConnectionCatalogCensusTransport = Schema.Literals(["http", "graphql", "mcp", "none"]);
export type ConnectionCatalogCensusTransport = typeof ConnectionCatalogCensusTransport.Type;

export const ConnectionCatalogCensusOwner = Schema.Literals(["org", "user"]);
export type ConnectionCatalogCensusOwner = typeof ConnectionCatalogCensusOwner.Type;

const CensusNonEmptyString = Schema.NonEmptyString.check(
  Schema.isMaxLength(CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES),
);

const CensusSha256 = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
  Schema.isMaxLength(64),
).annotate({ identifier: "ConnectionCatalogCensusSha256" });

const RFC3339_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

const isValidUtcTimestamp = (value: string): boolean => {
  const match = RFC3339_UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  return day <= daysInMonth;
};

const CensusTimestamp = Schema.String.check(
  Schema.isPattern(RFC3339_UTC_TIMESTAMP),
  Schema.isMaxLength(24),
  Schema.makeFilter((value) => (isValidUtcTimestamp(value) ? undefined : "invalid timestamp")),
).annotate({ identifier: "ConnectionCatalogCensusTimestamp" });

const CensusPageCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(CONNECTION_CATALOG_CENSUS_MAX_PAGES),
);

const CensusToolCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS),
);

const SAFE_SCHEMA_PATH_KEYS = new Set([
  "schemaVersion",
  "connectionAddress",
  "expectedIntegration",
  "expectedCredentialProvider",
  "refresh",
  "address",
  "owner",
  "integration",
  "name",
  "credentialProvider",
  "bindingSha256",
  "sourceTransport",
  "complete",
  "observedAt",
  "sourcePageCount",
  "sourceTerminalCursor",
  "toolCount",
  "descriptors",
  "descriptorHashes",
  "catalogSha256",
  "descriptionSha256",
  "annotationsSha256",
  "inputSchemaSha256",
  "outputSchemaSha256",
  "definitionsSha256",
  "descriptorSha256",
]);

const sanitizeSchemaPath = (path: ReadonlyArray<PropertyKey>): readonly PropertyKey[] =>
  path.map((segment) => {
    if (
      Predicate.isNumber(segment) &&
      Number.isSafeInteger(segment) &&
      segment >= 0 &&
      segment <= CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS
    ) {
      return segment;
    }
    return Predicate.isString(segment) && SAFE_SCHEMA_PATH_KEYS.has(segment)
      ? segment
      : "<unknown>";
  });

type SafeSchemaIssueDetail = Readonly<{
  path: readonly PropertyKey[];
  reason: string;
}>;

const collectSafeSchemaIssueDetails = (
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[] = [],
): readonly SafeSchemaIssueDetail[] =>
  Match.value(issue).pipe(
    Match.tag("Pointer", (current) =>
      collectSafeSchemaIssueDetails(current.issue, [...path, ...current.path]),
    ),
    Match.tag("Filter", (current) => collectSafeSchemaIssueDetails(current.issue, path)),
    Match.tag("Encoding", (current) => collectSafeSchemaIssueDetails(current.issue, path)),
    Match.tag("Composite", (current) =>
      current.issues.flatMap((child) => collectSafeSchemaIssueDetails(child, path)),
    ),
    Match.tag("AnyOf", (current) =>
      current.issues.length === 0
        ? [{ path: sanitizeSchemaPath(path), reason: "invalid_union" }]
        : current.issues.flatMap((child) => collectSafeSchemaIssueDetails(child, path)),
    ),
    Match.tag("InvalidType", () => [{ path: sanitizeSchemaPath(path), reason: "invalid_type" }]),
    Match.tag("InvalidValue", () => [{ path: sanitizeSchemaPath(path), reason: "invalid_value" }]),
    Match.tag("MissingKey", () => [{ path: sanitizeSchemaPath(path), reason: "missing_field" }]),
    Match.tag("UnexpectedKey", () => [
      { path: sanitizeSchemaPath(path), reason: "unexpected_field" },
    ]),
    Match.tag("Forbidden", () => [{ path: sanitizeSchemaPath(path), reason: "forbidden" }]),
    Match.tag("OneOf", () => [{ path: sanitizeSchemaPath(path), reason: "ambiguous_value" }]),
    Match.exhaustive,
  );

const safeSchemaIssue = (error: Schema.SchemaError): SchemaIssue.Issue => {
  const details = collectSafeSchemaIssueDetails(error.issue);
  const safeIssues = details.map(
    ({ path, reason }) =>
      new SchemaIssue.Pointer(
        path,
        new SchemaIssue.InvalidValue(Option.none(), { message: reason }),
      ),
  );
  const [first, ...rest] = safeIssues;
  if (!first) {
    return new SchemaIssue.InvalidValue(Option.none(), { message: "invalid_schema" });
  }
  if (rest.length === 0) return first;
  return new SchemaIssue.Composite(Schema.Unknown.ast, Option.none(), [first, ...rest]);
};

const strictStandardSchema = <S extends Schema.Decoder<unknown, never>>(
  base: S,
  allowedKeys: readonly string[],
) => {
  const allowedKeySet = new Set(allowedKeys);
  const exactObject = Schema.Unknown.check(
    Schema.makeFilter((value) => {
      if (!Predicate.isReadonlyObject(value)) return "Unexpected fields";
      if (Object.getOwnPropertySymbols(value).length > 0) return "Unexpected fields";
      const propertyNames = Object.getOwnPropertyNames(value);
      return propertyNames.length === allowedKeySet.size &&
        propertyNames.every((name) => allowedKeySet.has(name))
        ? undefined
        : "Unexpected fields";
    }),
  );
  const strictBase = Schema.decodeTo(base)(exactObject);
  const structuralSchema = Schema.toType(base);
  const safeSchema = Schema.declareConstructor<S["Type"], unknown>()(
    [structuralSchema],
    () => (input, _self, options) =>
      Schema.decodeUnknownEffect(strictBase)(input, {
        ...options,
        onExcessProperty: "error",
      }).pipe(Effect.mapError(safeSchemaIssue)),
    {
      toCodec: ([structuralSchema]) =>
        Schema.link<S["Type"]>()(structuralSchema, SchemaTransformation.passthrough<S["Type"]>()),
    },
  );
  return Schema.toStandardSchemaV1(safeSchema, {
    parseOptions: { onExcessProperty: "error" },
    leafHook: ({ _tag }) => (_tag === "InvalidValue" ? "invalid_value" : "invalid_schema"),
    checkHook: () => "invalid_schema",
  });
};

/** Caller request. Authority and execution-target fields are intentionally absent. */
const ConnectionCatalogCensusRequestBase = Schema.Struct({
  schemaVersion: Schema.Literal(CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION),
  connectionAddress: CensusNonEmptyString,
  expectedIntegration: CensusNonEmptyString,
  expectedCredentialProvider: CensusNonEmptyString,
  refresh: Schema.Literal(true),
}).annotate({ identifier: "ConnectionCatalogCensusRequestV1" });
export const ConnectionCatalogCensusRequest = strictStandardSchema(
  ConnectionCatalogCensusRequestBase,
  [
    "schemaVersion",
    "connectionAddress",
    "expectedIntegration",
    "expectedCredentialProvider",
    "refresh",
  ],
);
export type ConnectionCatalogCensusRequest = typeof ConnectionCatalogCensusRequest.Type;

export const ConnectionCatalogCensusInput = ConnectionCatalogCensusRequest;
export type ConnectionCatalogCensusInput = typeof ConnectionCatalogCensusInput.Type;

/** Exact executor-bound identity used to derive the binding hash. */
export type ConnectionCatalogCensusBinding = Readonly<{
  address: string;
  owner: ConnectionCatalogCensusOwner;
  integration: string;
  name: string;
  credentialProvider: string;
  tenant: string;
  subject: string | null;
  template: string;
  generation: string;
  catalogRevision: string;
  sourceTransport: ConnectionCatalogCensusTransport;
  pluginId?: string;
}>;

/** Raw source descriptor accepted only behind the pure finalizer seam. */
export type ConnectionCatalogCensusDescriptorInput = Readonly<{
  address: string;
  name: string;
  description?: string | null;
  annotations?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  definitions?: unknown;
  static?: boolean;
  connectionAddress: string;
  owner: string;
  integration: string;
  pluginId?: string;
}>;

/** Hashed, non-secret descriptor projection. Raw schemas and descriptions never cross this seam. */
const ConnectionCatalogCensusDescriptorBase = Schema.Struct({
  address: CensusNonEmptyString,
  name: CensusNonEmptyString,
  descriptionSha256: CensusSha256,
  annotationsSha256: CensusSha256,
  inputSchemaSha256: CensusSha256,
  outputSchemaSha256: CensusSha256,
  definitionsSha256: CensusSha256,
  descriptorSha256: CensusSha256,
}).annotate({ identifier: "ConnectionCatalogCensusDescriptorV1" });
export const ConnectionCatalogCensusDescriptor = strictStandardSchema(
  ConnectionCatalogCensusDescriptorBase,
  [
    "address",
    "name",
    "descriptionSha256",
    "annotationsSha256",
    "inputSchemaSha256",
    "outputSchemaSha256",
    "definitionsSha256",
    "descriptorSha256",
  ],
);
export type ConnectionCatalogCensusDescriptor = typeof ConnectionCatalogCensusDescriptor.Type;

/** One source page. `cursor` is executor-owned pagination state, never request input. */
export type ConnectionCatalogCensusPage = Readonly<{
  cursor: string | null;
  nextCursor: string | null;
  generation: string;
  catalogRevision: string;
  sourceTransport: ConnectionCatalogCensusTransport;
  descriptors: readonly ConnectionCatalogCensusDescriptorInput[];
  sourcePageCount?: number;
  sourceTerminalCursor?: string | null;
}>;

/** The one small interface consumed by the pure finalizer. */
export type ConnectionCatalogCensusSource = Readonly<{
  binding: ConnectionCatalogCensusBinding;
  complete: boolean;
  pages: readonly ConnectionCatalogCensusPage[];
  sourcePageCount?: number;
  sourceTerminalCursor?: string | null;
}>;

/** Result proof. A successful census is always terminal and complete. */
/** A complete terminal catalog may intentionally contain zero tools. */
const ConnectionCatalogCensusResultBase = Schema.Struct({
  schemaVersion: Schema.Literal(CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION),
  address: CensusNonEmptyString,
  owner: ConnectionCatalogCensusOwner,
  integration: CensusNonEmptyString,
  name: CensusNonEmptyString,
  credentialProvider: CensusNonEmptyString,
  bindingSha256: CensusSha256,
  sourceTransport: ConnectionCatalogCensusTransport,
  complete: Schema.Literal(true),
  observedAt: CensusTimestamp,
  sourcePageCount: CensusPageCount,
  sourceTerminalCursor: Schema.Null,
  toolCount: CensusToolCount,
  descriptors: Schema.Array(ConnectionCatalogCensusDescriptor).check(
    Schema.isMaxLength(CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS),
  ),
  descriptorHashes: Schema.Array(CensusSha256).check(
    Schema.isMaxLength(CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS),
  ),
  catalogSha256: CensusSha256,
}).annotate({ identifier: "ConnectionCatalogCensusResultV1" });
export const ConnectionCatalogCensusResult = strictStandardSchema(
  ConnectionCatalogCensusResultBase,
  [
    "schemaVersion",
    "address",
    "owner",
    "integration",
    "name",
    "credentialProvider",
    "bindingSha256",
    "sourceTransport",
    "complete",
    "observedAt",
    "sourcePageCount",
    "sourceTerminalCursor",
    "toolCount",
    "descriptors",
    "descriptorHashes",
    "catalogSha256",
  ],
);
export type ConnectionCatalogCensusResult = typeof ConnectionCatalogCensusResult.Type;

export const ConnectionCatalogCensusFailureReason = Schema.Literals([
  "invalid_input",
  "invalid_binding",
  "connection_not_found",
  "tenant_mismatch",
  "subject_mismatch",
  "integration_mismatch",
  "credential_provider_mismatch",
  "provider_transport_mismatch",
  "credential_resolution_failed",
  "refresh_failed",
  "incomplete",
  "repeated_cursor",
  "nonterminal_page_cap",
  "malformed_entry",
  "duplicate_entry",
  "schema_lookup_failure",
  "drift",
  "bounds_overflow",
  "invalid_timestamp",
  "secret_rejected",
  "canonicalization_failure",
]);
export type ConnectionCatalogCensusFailureReason = typeof ConnectionCatalogCensusFailureReason.Type;

/** Closed, value-free failure projection for the census seam. */
export class ConnectionCatalogCensusError extends Schema.TaggedErrorClass<ConnectionCatalogCensusError>()(
  "ConnectionCatalogCensusError",
  {
    field: Schema.String,
    reason: ConnectionCatalogCensusFailureReason,
  },
) {
  override get message(): string {
    return `Connection catalog census failed (${this.reason}).`;
  }
}

type CatalogJson =
  | null
  | string
  | boolean
  | number
  | readonly CatalogJson[]
  | { readonly [key: string]: CatalogJson };

type CatalogRecord = { readonly [key: string]: CatalogJson };

export type ConnectionCatalogCanonicalSnapshot = Readonly<{
  readonly value: CatalogJson;
  readonly canonical: string;
}>;

const isCatalogRecord = (value: CatalogJson): value is CatalogRecord => Predicate.isObject(value);

const isExecutorCredentialValue = (value: string): boolean =>
  /(?:bearer\s+\S{4,}|basic\s+\S{4,}|(?:sk|gh[pousr]|github_pat|xox[bpras])[-_][-\w]{6,}|ghp_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{8,}|-----BEGIN)/i.test(
    value,
  );

const isWeakSecretValue = (value: string): boolean =>
  /(?:api[-_ ]?key|authorization|auth[-_ ]?header|client[-_ ]?secret|refresh[-_ ]?token|access[-_ ]?token|password|passwd|private[-_ ]?key|credential|secret|token)\s*[:=]\s*\S+|(?:credential|secret)[-_ ]?(?:sentinel|material|value|placeholder|test)|(?:test|fixture|fake)[-_ ]?(?:secret|token|credential)/i.test(
    value,
  );

const isSensitiveKey = (key: string): boolean =>
  /^(?:default|example|examples|description)$/i.test(key);

type OwnEntry = readonly [string, PropertyDescriptor];

/** Compare UTF-16 code units directly so hashes do not depend on locale data. */
const compareDeterministicStrings = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodeUnit = left.charCodeAt(index);
    const rightCodeUnit = right.charCodeAt(index);
    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit - rightCodeUnit;
  }
  return left.length - right.length;
};

const ownDataEntries = <Value extends object>(
  value: Value,
  path: string,
): Effect.Effect<readonly OwnEntry[], ConnectionCatalogCensusError> =>
  Effect.try({
    try: () => {
      const names = Object.getOwnPropertyNames(value);
      if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
      const entries: OwnEntry[] = [];
      for (const name of names) {
        if (Array.isArray(value) && name === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
        entries.push([name, descriptor]);
      }
      return entries.sort((left, right) => compareDeterministicStrings(left[0], right[0]));
    },
    catch: () =>
      new ConnectionCatalogCensusError({ reason: "canonicalization_failure", field: path }),
  }).pipe(
    Effect.flatMap((entries) =>
      entries === undefined
        ? Effect.fail(
            new ConnectionCatalogCensusError({ reason: "canonicalization_failure", field: path }),
          )
        : Effect.succeed(entries),
    ),
  );

const canonicalizeCatalogNode = <Value>(
  value: Value,
  path: string,
  stack: ReadonlySet<object>,
  state: { nodes: number },
  sensitive: boolean,
): Effect.Effect<CatalogJson, ConnectionCatalogCensusError> =>
  Effect.gen(function* () {
    state.nodes += 1;
    if (state.nodes > CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS * 16) {
      return yield* new ConnectionCatalogCensusError({ reason: "bounds_overflow", field: path });
    }
    if (Predicate.isNull(value)) return null;
    if (Predicate.isString(value)) {
      if (new TextEncoder().encode(value).byteLength > CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES) {
        return yield* new ConnectionCatalogCensusError({ reason: "bounds_overflow", field: path });
      }
      if (isExecutorCredentialValue(value) || (sensitive && isWeakSecretValue(value))) {
        return yield* new ConnectionCatalogCensusError({ reason: "secret_rejected", field: path });
      }
      return value;
    }
    if (Predicate.isBoolean(value)) return value;
    if (Predicate.isNumber(value)) {
      return Number.isFinite(value)
        ? value
        : yield* new ConnectionCatalogCensusError({
            reason: "canonicalization_failure",
            field: path,
          });
    }
    if (!Predicate.isObjectOrArray(value)) {
      return yield* new ConnectionCatalogCensusError({
        reason: "canonicalization_failure",
        field: path,
      });
    }
    if (stack.has(value)) {
      return yield* new ConnectionCatalogCensusError({
        reason: "canonicalization_failure",
        field: path,
      });
    }
    const prototype = yield* Effect.try({
      try: () => Object.getPrototypeOf(value),
      catch: () =>
        new ConnectionCatalogCensusError({ reason: "canonicalization_failure", field: path }),
    });
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
      return yield* new ConnectionCatalogCensusError({
        reason: "canonicalization_failure",
        field: path,
      });
    }
    const entries = yield* ownDataEntries(value, path);
    const nextStack = new Set(stack);
    nextStack.add(value);
    if (Array.isArray(value)) {
      const arrayEntries = [...entries].sort((left, right) => Number(left[0]) - Number(right[0]));
      if (
        arrayEntries.length !== value.length ||
        arrayEntries.some(([name], index) => !/^\d+$/.test(name) || Number(name) !== index)
      ) {
        return yield* new ConnectionCatalogCensusError({
          reason: "canonicalization_failure",
          field: path,
        });
      }
      const result: CatalogJson[] = [];
      for (const [name, descriptor] of arrayEntries) {
        result.push(
          yield* canonicalizeCatalogNode(
            descriptor.value,
            `${path}[${name}]`,
            nextStack,
            state,
            sensitive,
          ),
        );
      }
      return result;
    }
    // SAFETY: every inserted value is recursively canonicalized CatalogJson.
    const result: Record<string, CatalogJson> = Object.create(null) as Record<string, CatalogJson>;
    for (const [name, descriptor] of entries) {
      result[name] = yield* canonicalizeCatalogNode(
        descriptor.value,
        `${path}.${name}`,
        nextStack,
        state,
        sensitive || isSensitiveKey(name),
      );
    }
    return result;
  });

const freezeCatalogValue = (value: CatalogJson): void => {
  if (!Predicate.isObjectOrArray(value) || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) freezeCatalogValue(item);
  } else {
    for (const item of Object.values(value)) freezeCatalogValue(item);
  }
  Object.freeze(value);
};

/** Canonicalize a JSON value without rejecting schema property names such as
 * `token` or `$ref`. Concrete credential-shaped values in sensitive metadata
 * fields are rejected before any value can enter a hash or error message. */
export const canonicalizeConnectionCatalogValue = <Value>(
  value: Value,
): Effect.Effect<ConnectionCatalogCanonicalSnapshot, ConnectionCatalogCensusError> =>
  Effect.gen(function* () {
    const state = { nodes: 0 };
    const json = yield* canonicalizeCatalogNode(value, "$", new Set(), state, false);
    const canonical = JSON.stringify(json);
    if (canonical === undefined) {
      return yield* new ConnectionCatalogCensusError({
        reason: "canonicalization_failure",
        field: "$",
      });
    }
    if (
      new TextEncoder().encode(canonical).byteLength > CONNECTION_CATALOG_CENSUS_MAX_CANONICAL_BYTES
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "bounds_overflow", field: "$" });
    }
    freezeCatalogValue(json);
    return { value: json, canonical };
  });

const hashCanonical = (
  canonical: string,
  field: string,
): Effect.Effect<string, ConnectionCatalogCensusError> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
    catch: () => new ConnectionCatalogCensusError({ reason: "canonicalization_failure", field }),
  }).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

/** Hash a canonical catalog value without exposing it. */
export const hashConnectionCatalogValue = <Value>(
  value: Value,
): Effect.Effect<string, ConnectionCatalogCensusError> =>
  canonicalizeConnectionCatalogValue(value).pipe(
    Effect.flatMap((snapshot) => hashCanonical(snapshot.canonical, "hash")),
  );

const hashBindingPayload = (binding: ConnectionCatalogCensusBinding) => {
  const payload = {
    address: binding.address,
    owner: binding.owner,
    integration: binding.integration,
    name: binding.name,
    credentialProvider: binding.credentialProvider,
    tenant: binding.tenant,
    subject: binding.subject,
    template: binding.template,
    generation: binding.generation,
    catalogRevision: binding.catalogRevision,
    sourceTransport: binding.sourceTransport,
  };
  if (binding.pluginId !== undefined) return { ...payload, pluginId: binding.pluginId };
  return payload;
};

/** Hash the complete authenticated connection binding, including generation,
 * revision, and the actual catalog transport. */
export const hashConnectionCatalogBinding = (
  binding: ConnectionCatalogCensusBinding,
): Effect.Effect<string, ConnectionCatalogCensusError> =>
  hashConnectionCatalogValue(hashBindingPayload(binding));

/**
 * Census ref policy: only same-document JSON Pointers rooted at `$defs` or
 * `definitions` are supported. External URIs, other local roots, malformed
 * escapes, and missing targets are rejected because this pure seam has no
 * external schema resolver. Cyclic named definitions remain valid.
 */
const hasCompleteSchemaReferences = (
  inputSchema: CatalogJson,
  outputSchema: CatalogJson,
  definitions: CatalogJson,
): boolean => {
  if (!isCatalogRecord(definitions)) return false;

  const available = new Map<string, CatalogJson>();
  const visitedDefinitionContainers = new Set<object>();

  const decodePointerToken = (token: string): string | undefined => {
    let decoded = "";
    for (let index = 0; index < token.length; index += 1) {
      const character = token[index];
      if (character !== "~") {
        decoded += character;
        continue;
      }
      const escape = token[index + 1];
      if (escape !== "0" && escape !== "1") return undefined;
      decoded += escape === "0" ? "~" : "/";
      index += 1;
    }
    return decoded;
  };

  const parseLocalPointer = (ref: string): readonly string[] | undefined => {
    if (!ref.startsWith("#/")) return undefined;
    const decoded = ref
      .slice(2)
      .split("/")
      .map((token) => decodePointerToken(token));
    const tokens = decoded.filter(Predicate.isNotUndefined);
    if (tokens.length !== decoded.length) return undefined;
    const [namespace, definitionName, ...path] = tokens;
    if (
      (namespace !== "$defs" && namespace !== "definitions") ||
      definitionName === undefined ||
      definitionName.length === 0
    ) {
      return undefined;
    }
    return [definitionName, ...path];
  };

  const addDefinition = (name: string, definition: CatalogJson): boolean => {
    const previous = available.get(name);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(definition)) {
      return false;
    }
    available.set(name, definition);
    return true;
  };

  for (const [name, definition] of Object.entries(definitions)) {
    if (!addDefinition(name, definition)) return false;
  }

  const collectLocalDefinitions = (node: CatalogJson): boolean => {
    if (!Predicate.isObjectOrArray(node)) return true;
    if (visitedDefinitionContainers.has(node)) return true;
    visitedDefinitionContainers.add(node);
    if (Array.isArray(node)) {
      return node.every((item) => collectLocalDefinitions(item));
    }
    if (!isCatalogRecord(node)) return false;
    for (const key of ["$defs", "definitions"] as const) {
      const container = node[key];
      if (container !== undefined) {
        if (!isCatalogRecord(container)) return false;
        for (const [name, definition] of Object.entries(container)) {
          if (!addDefinition(name, definition)) return false;
          if (!collectLocalDefinitions(definition)) return false;
        }
      }
    }
    return Object.values(node).every((value) => collectLocalDefinitions(value));
  };

  if (
    !collectLocalDefinitions(inputSchema) ||
    !collectLocalDefinitions(outputSchema) ||
    !collectLocalDefinitions(definitions)
  ) {
    return false;
  }

  const visitedNodes = new Set<object>();
  const resolvePointer = (pointer: readonly string[]): CatalogJson | undefined => {
    let current = available.get(pointer[0]);
    if (current === undefined) return undefined;
    for (const segment of pointer.slice(1)) {
      if (Array.isArray(current)) {
        if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
        const index = Number(segment);
        if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
        const resolved: CatalogJson | undefined = current[index];
        if (resolved === undefined) return undefined;
        current = resolved;
        continue;
      }
      if (current === undefined || !isCatalogRecord(current) || !Object.hasOwn(current, segment)) {
        return undefined;
      }
      const resolved: CatalogJson | undefined = current[segment];
      if (resolved === undefined) return undefined;
      current = resolved;
    }
    return current;
  };

  const hasMissingReference = (node: CatalogJson): boolean => {
    if (!Predicate.isObjectOrArray(node)) return false;
    if (visitedNodes.has(node)) return false;
    visitedNodes.add(node);
    if (Array.isArray(node)) return node.some((item) => hasMissingReference(item));
    if (!isCatalogRecord(node)) return false;
    if (Object.hasOwn(node, "$ref")) {
      if (!Predicate.isString(node.$ref)) return true;
      const pointer = parseLocalPointer(node.$ref);
      if (pointer === undefined || resolvePointer(pointer) === undefined) return true;
    }
    return Object.values(node).some((value) => hasMissingReference(value));
  };

  return ![inputSchema, outputSchema, definitions, ...available.values()].some((root) =>
    hasMissingReference(root),
  );
};

const readString = (record: CatalogRecord, key: string): string | undefined => {
  const value = record[key];
  return Predicate.isString(value) ? value : undefined;
};

const readNonEmptyString = (record: CatalogRecord, key: string): string | undefined => {
  const value = readString(record, key);
  return Predicate.isNotUndefined(value) && value.length > 0 ? value : undefined;
};

const isTransport = Schema.is(ConnectionCatalogCensusTransport);

const isOwner = Schema.is(ConnectionCatalogCensusOwner);

const validConnectionAddress = (value: string): boolean => {
  const segments = value.split(".");
  return (
    segments.length >= 4 &&
    segments[0] === "tools" &&
    segments[1] !== "" &&
    isOwner(segments[2]) &&
    segments.slice(3).join(".").length > 0
  );
};

const validTimestamp = isValidUtcTimestamp;

const exactInputKeys = new Set([
  "schemaVersion",
  "connectionAddress",
  "expectedIntegration",
  "expectedCredentialProvider",
  "refresh",
]);

/** Validate authority-free census input before an operation schema decoder can strip fields. */
export const validateConnectionCatalogCensusInput = <Value>(
  value: Value,
): Effect.Effect<ConnectionCatalogCensusInput, ConnectionCatalogCensusError> =>
  Effect.gen(function* () {
    const snapshot = yield* canonicalizeConnectionCatalogValue(value);
    if (!isCatalogRecord(snapshot.value)) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_input", field: "$" });
    }
    const keys = Object.keys(snapshot.value);
    if (keys.length !== exactInputKeys.size || keys.some((key) => !exactInputKeys.has(key))) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_input", field: "$" });
    }
    if (
      snapshot.value.schemaVersion !== CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION ||
      snapshot.value.refresh !== true
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_input", field: "$" });
    }
    const connectionAddress = readNonEmptyString(snapshot.value, "connectionAddress");
    const expectedIntegration = readNonEmptyString(snapshot.value, "expectedIntegration");
    const expectedCredentialProvider = readNonEmptyString(
      snapshot.value,
      "expectedCredentialProvider",
    );
    if (!connectionAddress || !expectedIntegration || !expectedCredentialProvider) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_input", field: "$" });
    }
    if (!validConnectionAddress(connectionAddress)) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_input", field: "$" });
    }
    return {
      schemaVersion: CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION,
      connectionAddress,
      expectedIntegration,
      expectedCredentialProvider,
      refresh: true,
    };
  });

const validateBinding = (
  value: CatalogJson,
  request: ConnectionCatalogCensusInput,
): Effect.Effect<ConnectionCatalogCensusBinding, ConnectionCatalogCensusError> =>
  Effect.gen(function* () {
    if (!isCatalogRecord(value)) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
    }
    const address = readNonEmptyString(value, "address");
    const owner = value.owner;
    const integration = readNonEmptyString(value, "integration");
    const name = readNonEmptyString(value, "name");
    const credentialProvider = readNonEmptyString(value, "credentialProvider");
    const tenant = readNonEmptyString(value, "tenant");
    const template = readNonEmptyString(value, "template");
    const generation = readNonEmptyString(value, "generation");
    const catalogRevision = readNonEmptyString(value, "catalogRevision");
    const subject = value.subject;
    const sourceTransport = value.sourceTransport;
    const pluginId = value.pluginId;
    if (!address || !isOwner(owner) || !integration || !name || !credentialProvider || !tenant) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
    }
    if (!template || !generation || !catalogRevision || !isTransport(sourceTransport)) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
    }
    if (!validConnectionAddress(address) || address !== `tools.${integration}.${owner}.${name}`) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
    }
    let normalizedSubject: string | null;
    if (owner === "org") {
      if (subject !== null) {
        return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
      }
      normalizedSubject = null;
    } else {
      if (!Predicate.isString(subject) || subject.length === 0) {
        return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
      }
      normalizedSubject = subject;
    }
    if (
      Predicate.isNotUndefined(pluginId) &&
      (!Predicate.isString(pluginId) || pluginId.length === 0)
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
    }
    if (address !== request.connectionAddress) {
      return yield* new ConnectionCatalogCensusError({ reason: "drift", field: "$" });
    }
    if (integration !== request.expectedIntegration) {
      return yield* new ConnectionCatalogCensusError({
        reason: "integration_mismatch",
        field: "$",
      });
    }
    if (credentialProvider !== request.expectedCredentialProvider) {
      return yield* new ConnectionCatalogCensusError({
        reason: "credential_provider_mismatch",
        field: "$",
      });
    }
    const normalizedBinding = {
      address,
      owner,
      integration,
      name,
      credentialProvider,
      tenant,
      subject: normalizedSubject,
      template,
      generation,
      catalogRevision,
      sourceTransport,
    };
    if (pluginId !== undefined) return { ...normalizedBinding, pluginId };
    return normalizedBinding;
  });

const normalizeDescriptor = (
  raw: CatalogRecord,
  binding: ConnectionCatalogCensusBinding,
  pageIndex: number,
  descriptorIndex: number,
): Effect.Effect<ConnectionCatalogCensusDescriptor, ConnectionCatalogCensusError> =>
  Effect.gen(function* () {
    const field = `pages[${pageIndex}].descriptors[${descriptorIndex}]`;
    const address = readNonEmptyString(raw, "address");
    const name = readNonEmptyString(raw, "name");
    if (!address || !name) {
      return yield* new ConnectionCatalogCensusError({ reason: "malformed_entry", field });
    }
    if (
      new TextEncoder().encode(address).byteLength > CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES ||
      new TextEncoder().encode(name).byteLength > CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "bounds_overflow", field });
    }
    if (
      !Predicate.isString(raw.connectionAddress) ||
      !Predicate.isString(raw.owner) ||
      !Predicate.isString(raw.integration)
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "malformed_entry", field });
    }
    if (raw.static === true) {
      return yield* new ConnectionCatalogCensusError({ reason: "malformed_entry", field });
    }
    if (raw.connectionAddress !== binding.address) {
      return yield* new ConnectionCatalogCensusError({ reason: "drift", field });
    }
    if (raw.owner !== binding.owner) {
      return yield* new ConnectionCatalogCensusError({ reason: "drift", field });
    }
    if (raw.integration !== binding.integration) {
      return yield* new ConnectionCatalogCensusError({ reason: "drift", field });
    }
    if (
      (binding.pluginId === undefined && raw.pluginId !== undefined) ||
      (binding.pluginId !== undefined && raw.pluginId !== binding.pluginId)
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "drift", field });
    }
    if (address !== `${binding.address}.${name}`) {
      return yield* new ConnectionCatalogCensusError({ reason: "drift", field });
    }
    if (raw.inputSchema === undefined || raw.inputSchema === null) {
      return yield* new ConnectionCatalogCensusError({
        reason: "schema_lookup_failure",
        field: `${field}.inputSchema`,
      });
    }
    if (raw.outputSchema === undefined || raw.outputSchema === null) {
      return yield* new ConnectionCatalogCensusError({
        reason: "schema_lookup_failure",
        field: `${field}.outputSchema`,
      });
    }
    const description =
      raw.description === undefined || raw.description === null ? "" : raw.description;
    if (!Predicate.isString(description)) {
      return yield* new ConnectionCatalogCensusError({
        reason: "malformed_entry",
        field: `${field}.description`,
      });
    }
    const annotations =
      raw.annotations === undefined || raw.annotations === null ? {} : raw.annotations;
    if (!isCatalogRecord(annotations))
      return yield* new ConnectionCatalogCensusError({
        reason: "malformed_entry",
        field: `${field}.annotations`,
      });
    const definitions = raw.definitions === undefined ? {} : raw.definitions;
    if (!isCatalogRecord(definitions))
      return yield* new ConnectionCatalogCensusError({
        reason: "schema_lookup_failure",
        field: `${field}.definitions`,
      });

    const inputSchemaSnapshot = yield* canonicalizeConnectionCatalogValue(raw.inputSchema);
    const outputSchemaSnapshot = yield* canonicalizeConnectionCatalogValue(raw.outputSchema);
    const definitionsSnapshot = yield* canonicalizeConnectionCatalogValue(definitions);
    if (
      !hasCompleteSchemaReferences(
        inputSchemaSnapshot.value,
        outputSchemaSnapshot.value,
        definitionsSnapshot.value,
      )
    ) {
      return yield* new ConnectionCatalogCensusError({
        reason: "schema_lookup_failure",
        field: `${field}.schema`,
      });
    }
    const descriptionSha256 = yield* hashConnectionCatalogValue(description);
    const annotationsSha256 = yield* hashConnectionCatalogValue(annotations);
    const inputSchemaSha256 = yield* hashCanonical(
      inputSchemaSnapshot.canonical,
      `${field}.inputSchemaSha256`,
    );
    const outputSchemaSha256 = yield* hashCanonical(
      outputSchemaSnapshot.canonical,
      `${field}.outputSchemaSha256`,
    );
    const definitionsSha256 = yield* hashCanonical(
      definitionsSnapshot.canonical,
      `${field}.definitionsSha256`,
    );
    const descriptorPayload = {
      address,
      name,
      descriptionSha256,
      annotationsSha256,
      inputSchemaSha256,
      outputSchemaSha256,
      definitionsSha256,
      generation: binding.generation,
      catalogRevision: binding.catalogRevision,
      sourceTransport: binding.sourceTransport,
    };
    const descriptorCanonical = yield* canonicalizeConnectionCatalogValue(descriptorPayload);
    if (
      new TextEncoder().encode(descriptorCanonical.canonical).byteLength >
      CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTOR_BYTES
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "bounds_overflow", field });
    }
    const descriptorSha256 = yield* hashCanonical(
      descriptorCanonical.canonical,
      `${field}.descriptorSha256`,
    );
    return {
      address,
      name,
      descriptionSha256,
      annotationsSha256,
      inputSchemaSha256,
      outputSchemaSha256,
      definitionsSha256,
      descriptorSha256,
    };
  });

/** Finalize a refreshed source snapshot into a hash-only census result. */
export const finalizeConnectionCatalogCensus = (input: {
  readonly request: unknown;
  readonly source: unknown;
  readonly observedAt: string;
}): Effect.Effect<ConnectionCatalogCensusResult, ConnectionCatalogCensusError> =>
  Effect.gen(function* () {
    const request = yield* validateConnectionCatalogCensusInput(input.request);
    if (!validTimestamp(input.observedAt)) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_timestamp", field: "$" });
    }
    const sourceSnapshot = yield* canonicalizeConnectionCatalogValue(input.source);
    if (!isCatalogRecord(sourceSnapshot.value)) {
      return yield* new ConnectionCatalogCensusError({ reason: "invalid_binding", field: "$" });
    }
    if (sourceSnapshot.value.complete !== true) {
      return yield* new ConnectionCatalogCensusError({ reason: "incomplete", field: "$" });
    }
    const binding = yield* validateBinding(sourceSnapshot.value.binding, request);
    const pagesValue = sourceSnapshot.value.pages;
    if (!Array.isArray(pagesValue) || pagesValue.length === 0) {
      return yield* new ConnectionCatalogCensusError({ reason: "incomplete", field: "$" });
    }
    if (pagesValue.length > CONNECTION_CATALOG_CENSUS_MAX_PAGES) {
      return yield* new ConnectionCatalogCensusError({
        reason: "nonterminal_page_cap",
        field: "$",
      });
    }
    const sourceTerminalCursor = sourceSnapshot.value.sourceTerminalCursor;
    if (Predicate.isNotNullish(sourceTerminalCursor)) {
      return yield* new ConnectionCatalogCensusError({ reason: "incomplete", field: "$" });
    }
    let reportedPageCount = sourceSnapshot.value.sourcePageCount;
    if (
      Predicate.isNotUndefined(reportedPageCount) &&
      (!Predicate.isNumber(reportedPageCount) ||
        !Number.isInteger(reportedPageCount) ||
        reportedPageCount < 1 ||
        reportedPageCount > CONNECTION_CATALOG_CENSUS_MAX_PAGES)
    ) {
      return yield* new ConnectionCatalogCensusError({ reason: "bounds_overflow", field: "$" });
    }

    let expectedCursor: string | null = null;
    const consumedCursors = new Set<string>();
    const seenAddresses = new Set<string>();
    const seenNames = new Set<string>();
    const descriptors: ConnectionCatalogCensusDescriptor[] = [];

    for (let pageIndex = 0; pageIndex < pagesValue.length; pageIndex += 1) {
      const page = pagesValue[pageIndex];
      if (!isCatalogRecord(page) || !Array.isArray(page.descriptors)) {
        return yield* new ConnectionCatalogCensusError({
          reason: "malformed_entry",
          field: `pages[${pageIndex}]`,
        });
      }
      const cursor = page.cursor;
      const nextCursor = page.nextCursor;
      if (
        (cursor !== null && !Predicate.isString(cursor)) ||
        (nextCursor !== null && !Predicate.isString(nextCursor))
      ) {
        return yield* new ConnectionCatalogCensusError({
          reason: "malformed_entry",
          field: `pages[${pageIndex}].cursor`,
        });
      }
      if (cursor !== expectedCursor || (cursor !== null && consumedCursors.has(cursor))) {
        return yield* new ConnectionCatalogCensusError({
          reason: "repeated_cursor",
          field: `pages[${pageIndex}].cursor`,
        });
      }
      if (cursor !== null) consumedCursors.add(cursor);
      if (
        page.generation !== binding.generation ||
        page.catalogRevision !== binding.catalogRevision ||
        page.sourceTransport !== binding.sourceTransport
      ) {
        return yield* new ConnectionCatalogCensusError({
          reason: "drift",
          field: `pages[${pageIndex}]`,
        });
      }
      if (Predicate.isNotNullish(page.sourceTerminalCursor)) {
        return yield* new ConnectionCatalogCensusError({
          reason: "incomplete",
          field: `pages[${pageIndex}].sourceTerminalCursor`,
        });
      }
      if (Predicate.isNotUndefined(page.sourcePageCount)) {
        if (
          !Predicate.isNumber(page.sourcePageCount) ||
          !Number.isInteger(page.sourcePageCount) ||
          page.sourcePageCount < 1 ||
          page.sourcePageCount > CONNECTION_CATALOG_CENSUS_MAX_PAGES
        ) {
          return yield* new ConnectionCatalogCensusError({
            reason: "bounds_overflow",
            field: `pages[${pageIndex}].sourcePageCount`,
          });
        }
        if (reportedPageCount !== undefined && reportedPageCount !== page.sourcePageCount) {
          return yield* new ConnectionCatalogCensusError({
            reason: "drift",
            field: `pages[${pageIndex}].sourcePageCount`,
          });
        }
        reportedPageCount = page.sourcePageCount;
      }
      if (page.descriptors.length > CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS_PER_PAGE) {
        return yield* new ConnectionCatalogCensusError({
          reason: "bounds_overflow",
          field: `pages[${pageIndex}].descriptors`,
        });
      }
      for (
        let descriptorIndex = 0;
        descriptorIndex < page.descriptors.length;
        descriptorIndex += 1
      ) {
        if (descriptors.length >= CONNECTION_CATALOG_CENSUS_MAX_DESCRIPTORS) {
          return yield* new ConnectionCatalogCensusError({
            reason: "bounds_overflow",
            field: "toolCount",
          });
        }
        const raw = page.descriptors[descriptorIndex];
        if (!isCatalogRecord(raw))
          return yield* new ConnectionCatalogCensusError({
            reason: "malformed_entry",
            field: `pages[${pageIndex}].descriptors`,
          });
        const descriptor = yield* normalizeDescriptor(raw, binding, pageIndex, descriptorIndex);
        if (seenAddresses.has(descriptor.address) || seenNames.has(descriptor.name)) {
          return yield* new ConnectionCatalogCensusError({
            reason: "duplicate_entry",
            field: `pages[${pageIndex}].descriptors`,
          });
        }
        seenAddresses.add(descriptor.address);
        seenNames.add(descriptor.name);
        descriptors.push(descriptor);
      }
      if (nextCursor === null) {
        if (pageIndex !== pagesValue.length - 1) {
          return yield* new ConnectionCatalogCensusError({ reason: "incomplete", field: "$" });
        }
      } else {
        if (nextCursor.length === 0) {
          return yield* new ConnectionCatalogCensusError({
            reason: "malformed_entry",
            field: `pages[${pageIndex}].nextCursor`,
          });
        }
        if (nextCursor === cursor || consumedCursors.has(nextCursor)) {
          return yield* new ConnectionCatalogCensusError({
            reason: "repeated_cursor",
            field: `pages[${pageIndex}].nextCursor`,
          });
        }
        if (pageIndex === CONNECTION_CATALOG_CENSUS_MAX_PAGES - 1) {
          return yield* new ConnectionCatalogCensusError({
            reason: "nonterminal_page_cap",
            field: `pages[${pageIndex}].nextCursor`,
          });
        }
        expectedCursor = nextCursor;
      }
    }
    const lastPage = pagesValue[pagesValue.length - 1];
    if (!isCatalogRecord(lastPage) || lastPage.nextCursor !== null) {
      return yield* new ConnectionCatalogCensusError({
        reason:
          pagesValue.length >= CONNECTION_CATALOG_CENSUS_MAX_PAGES
            ? "nonterminal_page_cap"
            : "incomplete",
        field: "$",
      });
    }
    if (Predicate.isNotUndefined(reportedPageCount) && reportedPageCount !== pagesValue.length) {
      return yield* new ConnectionCatalogCensusError({
        reason: "drift",
        field: "sourcePageCount",
      });
    }
    const sourcePageCount = reportedPageCount ?? pagesValue.length;
    const sortedDescriptors = [...descriptors].sort((left, right) =>
      compareDeterministicStrings(left.address, right.address),
    );
    const descriptorHashes = sortedDescriptors.map((descriptor) => descriptor.descriptorSha256);
    const bindingSha256 = yield* hashConnectionCatalogBinding(binding);
    const catalogPayload = {
      schemaVersion: CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION,
      address: binding.address,
      owner: binding.owner,
      integration: binding.integration,
      name: binding.name,
      credentialProvider: binding.credentialProvider,
      bindingSha256,
      sourceTransport: binding.sourceTransport,
      generation: binding.generation,
      catalogRevision: binding.catalogRevision,
      complete: true,
      sourcePageCount,
      sourceTerminalCursor: null,
      toolCount: sortedDescriptors.length,
      descriptors: sortedDescriptors,
      descriptorHashes,
    };
    const catalogSha256 = yield* hashConnectionCatalogValue(catalogPayload);
    return {
      schemaVersion: CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION,
      address: binding.address,
      owner: binding.owner,
      integration: binding.integration,
      name: binding.name,
      credentialProvider: binding.credentialProvider,
      bindingSha256,
      sourceTransport: binding.sourceTransport,
      complete: true,
      observedAt: input.observedAt,
      sourcePageCount,
      sourceTerminalCursor: null,
      toolCount: sortedDescriptors.length,
      descriptors: sortedDescriptors,
      descriptorHashes,
      catalogSha256,
    };
  });
