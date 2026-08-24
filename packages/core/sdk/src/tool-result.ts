// ---------------------------------------------------------------------------
// ToolResult — typed value-based discriminated union returned by tool
// handlers and `invokeTool`. Domain success and expected failure both
// resolve through Effect's success channel; only true infra defects use
// the Effect failure channel.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

export const ToolErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  details: Schema.optional(Schema.Unknown),
  retryable: Schema.optional(Schema.Boolean),
});

export type ToolError = typeof ToolErrorSchema.Type;

export const ToolHttpMetaSchema = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
});

/**
 * Transport metadata for HTTP-backed tools (OpenAPI). Kept beside `data`
 * rather than wrapped around it: `data` stays the upstream payload, while
 * cross-cutting transport facts (pagination Link headers, rate-limit
 * headers) remain reachable for callers that need them.
 */
export type ToolHttpMeta = typeof ToolHttpMetaSchema.Type;

/** Provider facts that are safe to carry into an operation attestation. Raw
 * headers, bodies, query strings, and provider error messages stay out of the
 * public receipt. The optional provider request hash is provider-native
 * evidence; the Executor stamps its own operation request hash onto the
 * public receipt. */
export const ToolProviderEvidenceSchema = Schema.Struct({
  transport: Schema.Literals(["http", "graphql", "mcp", "unknown"]),
  requestId: Schema.optional(
    Schema.NonEmptyString.check(
      Schema.isMaxLength(256),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
    ),
  ),
  /** Provider-native request hash; the Executor-stamped operation hash is a
   * separate field on ProviderReceipt. */
  providerRequestSha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  responseSha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  status: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
  ),
  observedAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

export type ToolProviderEvidence = typeof ToolProviderEvidenceSchema.Type;

export const ToolFileSchema = Schema.TaggedStruct("ToolFile", {
  name: Schema.optional(Schema.String),
  mimeType: Schema.String,
  encoding: Schema.Literal("base64"),
  data: Schema.String.annotate({
    description: "Base64-encoded file bytes.",
    contentEncoding: "base64",
  }),
  byteLength: Schema.Int.annotate({
    description: "Raw file size in bytes before base64 encoding.",
  }),
});

export type ToolFile = typeof ToolFileSchema.Type;

export const ToolFileJsonSchema = Schema.toJsonSchemaDocument(ToolFileSchema).schema;

const matchesToolFileSchema = Schema.is(ToolFileSchema);

export const isToolFile = (value: unknown): value is ToolFile => matchesToolFileSchema(value);

export type ToolResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly http?: ToolHttpMeta;
      readonly provider?: ToolProviderEvidence;
    }
  | { readonly ok: false; readonly error: ToolError; readonly provider?: ToolProviderEvidence };

export const ToolResult = {
  ok: <T>(
    data: T,
    meta?: { readonly http?: ToolHttpMeta; readonly provider?: ToolProviderEvidence },
  ): ToolResult<T> => ({
    ok: true,
    data,
    ...(meta?.http ? { http: meta.http } : {}),
    ...(meta?.provider ? { provider: meta.provider } : {}),
  }),
  fail: <T = never>(
    error: ToolError,
    meta?: { readonly provider?: ToolProviderEvidence },
  ): ToolResult<T> => ({
    ok: false,
    error,
    ...(meta?.provider ? { provider: meta.provider } : {}),
  }),
} as const;

const ToolResultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Unknown,
    http: Schema.optional(ToolHttpMetaSchema),
    provider: Schema.optional(ToolProviderEvidenceSchema),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: ToolErrorSchema,
    provider: Schema.optional(ToolProviderEvidenceSchema),
  }),
]);

const isUnknownToolResult = Schema.is(ToolResultSchema);

export const isToolResult = (value: unknown): value is ToolResult<unknown> =>
  isUnknownToolResult(value);

/**
 * Annotate the current span with the outcome of a tool invocation.
 *
 * `ToolResult.fail` rides the Effect *success* channel by design (expected
 * failures are values, not defects), which means the tracer records those
 * spans as healthy. Without this, "user keeps hitting 4xx walls" is invisible
 * to telemetry — the exact class of signal that lets us catch product issues
 * before they're reported. Stamped attributes:
 *
 *   - `executor.tool.outcome`      — "ok" | "fail" (always, on ToolResults)
 *   - `executor.tool.error_code`   — ToolError.code (fail only)
 *   - `executor.tool.error_status` — upstream HTTP status (fail, when present)
 *
 * Codes/statuses are enumerable identifiers, never user content — safe span
 * attributes. Non-ToolResult values (raw success payloads) annotate "ok".
 */
export const annotateToolResultOutcome = (value: unknown): Effect.Effect<void> => {
  if (isToolResult(value) && !value.ok) {
    return Effect.annotateCurrentSpan({
      "executor.tool.outcome": "fail",
      "executor.tool.error_code": value.error.code,
      ...(value.error.status != null ? { "executor.tool.error_status": value.error.status } : {}),
    });
  }
  return Effect.annotateCurrentSpan({ "executor.tool.outcome": "ok" });
};
