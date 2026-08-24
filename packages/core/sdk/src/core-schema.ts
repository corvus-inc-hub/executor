import { column, idColumn, table, type AnyColumn, type AnyTable } from "@executor-js/fumadb/schema";
import type { Condition, ConditionBuilder } from "@executor-js/fumadb/query";

import { StorageError, type FumaRow } from "./fuma-runtime";
import {
  assertOwnerPatch,
  assertOwnerWritable,
  executorOwnerPolicyName,
  executorTenantPolicyName,
  executorUnscopedPolicyName,
  ownerVisibilityCondition,
  type ExecutorOwnerPolicyContext,
} from "./owner-policy";

type UserColumns = Record<string, AnyColumn>;
type AnyConditionBuilder = ConditionBuilder<Record<string, AnyColumn>>;

// Column helpers. Index-participating columns use `varchar(255)` so unique
// indexes stay portable (TEXT can't be indexed without a prefix length on
// MySQL); free-form columns use `string` (TEXT).
export const textColumn = (name: string) => column(name, "string");
export const nullableTextColumn = (name: string) => column(name, "string").nullable();
export const keyColumn = (name: string) => column(name, "varchar(255)");
export const nullableKeyColumn = (name: string) => column(name, "varchar(255)").nullable();
export const boolColumn = (name: string, defaultValue: boolean) =>
  column(name, "bool").defaultTo(defaultValue);
export const bigintColumn = (name: string) => column(name, "bigint");
export const nullableBigintColumn = (name: string) => column(name, "bigint").nullable();
export const jsonColumn = (name: string) => column(name, "json");
export const nullableJsonColumn = (name: string) => column(name, "json").nullable();
export const dateColumn = (name: string) => column(name, "timestamp");
export const nullableDateColumn = (name: string) => column(name, "timestamp").nullable();

// The policy callback hands us a `ConditionBuilder` typed to the specific table's
// columns; it isn't assignable to the generic `Record<string, AnyColumn>` builder
// (column-name positions are contravariant), so accept it loosely and re-narrow.
const ownerVisibility = (builder: unknown, context: ExecutorOwnerPolicyContext) =>
  ownerVisibilityCondition(builder as AnyConditionBuilder, context) as Condition | boolean;

/** A truly global table (the blob store). Isolation is carried in the row's
 *  `namespace` (which encodes the owner partition + plugin id), not a policy. */
const unscopedExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    id: keyColumn("id"),
  });
  out.unique(`${name}_id_uidx`, ["id"]);
  return out.policy({ name: executorUnscopedPolicyName });
};

/** A tenant-shared table (catalog / blobs) — partitioned only by `tenant`. */
const tenantExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
  uniqueKey: readonly string[],
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    tenant: keyColumn("tenant"),
  });
  out.unique(`${name}_uidx`, [...uniqueKey]);
  return out.policy<ExecutorOwnerPolicyContext>({
    name: executorTenantPolicyName,
    onRead: ({ builder, context }) => builder("tenant", "=", context.tenant),
    onCreate: ({ values, context }) => {
      if (values.tenant !== context.tenant) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB table policy callbacks are promise callbacks, not Effect effects
        throw new StorageError({
          message: `Storage write on table "${name}" is outside the executor tenant.`,
          cause: undefined,
        });
      }
    },
    onUpdate: ({ builder, context }) => builder("tenant", "=", context.tenant),
    onDelete: ({ builder, context }) => builder("tenant", "=", context.tenant),
  });
};

/** An owner-scoped table — partitioned by `(tenant, owner, subject)`, guarded by
 *  the executor owner policy. `uniqueKey` must include those three columns. */
const ownedExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
  uniqueKey: readonly string[],
  additionalUniqueKeys: readonly {
    readonly name: string;
    readonly columns: readonly string[];
  }[] = [],
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    tenant: keyColumn("tenant"),
    owner: keyColumn("owner"),
    subject: keyColumn("subject"),
  });
  out.unique(`${name}_uidx`, [...uniqueKey]);
  for (const key of additionalUniqueKeys) {
    out.unique(key.name, [...key.columns]);
  }
  return out.policy<ExecutorOwnerPolicyContext>({
    name: executorOwnerPolicyName,
    onRead: ({ builder, context }) => ownerVisibility(builder, context),
    onCreate: ({ values, context }) => assertOwnerWritable(name, values, context),
    onUpdate: ({ builder, set, create, context }) => {
      assertOwnerPatch(name, set, context);
      assertOwnerPatch(name, create, context);
      return ownerVisibility(builder, context);
    },
    onDelete: ({ builder, context }) => ownerVisibility(builder, context),
  });
};

const defineTables = <const TTables extends Record<string, AnyTable>>(tables: TTables): TTables =>
  tables;

export const coreTables = defineTables({
  // The catalog — tenant-shared integration definitions. `config` is the owning
  // plugin's opaque blob (openapi auth templates + spec; mcp url). Core never
  // parses it.
  integration: tenantExecutorTable(
    "integration",
    {
      slug: keyColumn("slug"),
      plugin_id: textColumn("plugin_id"),
      // Display name. The pre-split field: `description` used to hold the
      // name, so cloud backfills `name` from it (migration 0006) and other
      // hosts fall back at read time (see rowToIntegration). Nullable because
      // SQLite boot-ensure hosts cannot add a NOT NULL column to existing
      // tables, so the column stays nullable even though it is always present
      // in practice.
      name: nullableTextColumn("name"),
      // Actual prose description, now distinct from the name. Nullable: absent
      // until a user/spec supplies one (cloud clears the old duplicated title
      // to NULL in 0006).
      description: nullableTextColumn("description"),
      config: nullableJsonColumn("config"),
      // The declared health check (HealthCheckSpec JSON): which authenticated
      // operation a connection runs to prove its credential is alive and whose
      // account it is. CORE-owned, deliberately NOT inside `config`, so no
      // plugin's config decode/re-encode cycle can silently strip it and no
      // plugin schema has to declare it. Null = no check declared.
      health_check: nullableJsonColumn("health_check"),
      // Epoch ms of the last tool-affecting config change (spec update, auth
      // template edit). Compared against each connection's `tools_synced_at`
      // so OTHER subjects' connections — whose tool rows the updater cannot
      // write under the owner policy — lazily rebuild on their next read.
      config_revised_at: nullableBigintColumn("config_revised_at"),
      can_remove: boolColumn("can_remove", true),
      can_refresh: boolColumn("can_refresh", false),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "slug"],
  ),

  // THE saved credential, one per (owner, integration, name). Resolves each named
  // input via `provider` + the `item_ids` map (variable → provider item id). A
  // single-secret connection is `{ "token": <id> }`; an apiKey method with two
  // distinct inputs (e.g. Datadog) carries one entry per variable. All of a
  // connection's inputs share the one `provider`. OAuth fields null for static.
  connection: ownedExecutorTable(
    "connection",
    {
      integration: keyColumn("integration"),
      name: keyColumn("name"),
      template: textColumn("template"),
      provider: textColumn("provider"),
      item_ids: jsonColumn("item_ids"),
      identity_label: nullableTextColumn("identity_label"),
      // User-curated, agent-visible "what is this connection for". Settable at
      // create, editable after; never reset by OAuth re-mints.
      description: nullableTextColumn("description"),
      // Last health-check outcome (HealthCheckResult JSON: status, httpStatus,
      // checkedAt, identity, detail). Written by every checkHealth run so the
      // accounts list shows alive/expired AT A GLANCE (the customer ask)
      // instead of only after a per-row manual probe. Null = never checked.
      last_health: nullableJsonColumn("last_health"),
      // Epoch ms of the last tool (re)production for this connection. Stale
      // vs the integration's `config_revised_at` → re-produced on next read.
      tools_synced_at: nullableBigintColumn("tools_synced_at"),
      oauth_client: nullableTextColumn("oauth_client"),
      // The OWNER of `oauth_client` (a Personal connection may be minted through
      // a shared Workspace app), set together with `oauth_client`; null for
      // static creds. Stored so every deref (refresh/complete/reconnect) reads it
      // verbatim instead of re-deriving it via a sharing rule.
      oauth_client_owner: nullableTextColumn("oauth_client_owner"),
      refresh_item_id: nullableTextColumn("refresh_item_id"),
      expires_at: nullableBigintColumn("expires_at"),
      oauth_scope: nullableTextColumn("oauth_scope"),
      // Per-connection token endpoint override. Set only when the code was
      // redeemed at a region other than the oauth_client's configured token host
      // (multi-site providers like Datadog signal the org's region on the
      // callback). Null means refresh uses the oauth_client's `token_url`.
      oauth_token_url: nullableTextColumn("oauth_token_url"),
      provider_state: nullableJsonColumn("provider_state"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "integration", "name"],
  ),

  // A registered OAuth app — owner-scoped (shared org app or a member's BYO app).
  // A registered OAuth app — pure app identity (id/secret + endpoints). It carries
  // NO scopes: what to request is the integration's concern, so the same app can
  // back any integration. The granted scope is recorded per-connection
  // (`connection.oauth_scope`).
  oauth_client: ownedExecutorTable(
    "oauth_client",
    {
      slug: keyColumn("slug"),
      authorization_url: textColumn("authorization_url"),
      token_url: textColumn("token_url"),
      grant: textColumn("grant"),
      client_id: textColumn("client_id"),
      // The client secret is NOT stored inline — it's a provider `item_id` that
      // resolves to the value via the default writable credential provider
      // (WorkOS Vault on cloud, the local store on desktop). Null for public /
      // PKCE clients (no secret). Keeps secrets out of plaintext columns.
      client_secret_item_id: nullableTextColumn("client_secret_item_id"),
      // RFC 8707 Resource Indicator (MCP). Sent on the refresh request so the
      // re-minted access token stays bound to the same resource. Null when the
      // provider doesn't use resource indicators.
      resource: nullableTextColumn("resource"),
      // Where this oauth_client came from. Null in old databases is treated as
      // "manual" by the service layer.
      origin_kind: nullableTextColumn("origin_kind"),
      origin_integration: nullableTextColumn("origin_integration"),
      // Authorization-server issuer that owns a DCR client, keying per-AS reuse.
      // For a NEW DCR registration this is the DISCOVERED OIDC issuer (real
      // information from the AS metadata, which can legitimately differ from what
      // token_url would suggest). For a BACKFILLED legacy row it is instead a
      // derived registrable-origin of token_url (a cache of the pure
      // `registrableOriginOfUrl`, since no discovered issuer was ever recorded).
      // Null for manual clients and legacy rows not yet backfilled.
      origin_issuer: nullableTextColumn("origin_issuer"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "owner", "subject", "slug"],
  ),

  // In-flight OAuth authorization-code flow, keyed by the minted `state`.
  oauth_session: ownedExecutorTable(
    "oauth_session",
    {
      state: keyColumn("state"),
      client_slug: textColumn("client_slug"),
      integration: textColumn("integration"),
      name: textColumn("name"),
      template: textColumn("template"),
      redirect_url: textColumn("redirect_url"),
      pkce_verifier: nullableTextColumn("pkce_verifier"),
      identity_label: nullableTextColumn("identity_label"),
      payload: jsonColumn("payload"),
      // Correlated attempts are first-class on the session row; payload is
      // reserved for legacy scope/client metadata and is not the authority.
      attempt_key: nullableKeyColumn("attempt_key"),
      actor_user_id: nullableKeyColumn("actor_user_id"),
      workspace_id: nullableKeyColumn("workspace_id"),
      provider: nullableKeyColumn("provider"),
      descriptor_hash: nullableKeyColumn("descriptor_hash"),
      execution_id: nullableKeyColumn("execution_id"),
      correlation_envelope: nullableJsonColumn("correlation_envelope"),
      expires_at: bigintColumn("expires_at"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "state"],
    // Correlated sessions are first-class by attempt key as well as provider
    // state. Nullable legacy rows remain valid, while a tenant cannot hold two
    // sessions for one durable attempt.
    [{ name: "oauth_session_attempt_uidx", columns: ["tenant", "attempt_key"] }],
  ),

  // Durable attempt reservation and exchange claim. This row survives session
  // deletion, so duplicate attempt keys and crashed exchanges are recoverable.
  // It contains no OAuth code, token, or client secret.
  oauth_attempt: tenantExecutorTable(
    "oauth_attempt",
    {
      attempt_key: keyColumn("attempt_key"),
      state: keyColumn("state"),
      actor_user_id: keyColumn("actor_user_id"),
      organization_id: keyColumn("organization_id"),
      workspace_id: keyColumn("workspace_id"),
      provider: keyColumn("provider"),
      integration: keyColumn("integration"),
      execution_id: keyColumn("execution_id"),
      descriptor_hash: keyColumn("descriptor_hash"),
      status: keyColumn("status"),
      lease_token: nullableKeyColumn("lease_token"),
      lease_expires_at: nullableBigintColumn("lease_expires_at"),
      authorization_url: textColumn("authorization_url"),
      started_at: dateColumn("started_at"),
      updated_at: dateColumn("updated_at"),
      completed_at: nullableDateColumn("completed_at"),
    },
    ["tenant", "attempt_key"],
  ),

  // External credential writes are represented by a metadata-only intent. The
  // provider item ids are deterministic and the hashes let a recovery process
  // detect a write that completed before the Executor process crashed.
  oauth_credential_intent: tenantExecutorTable(
    "oauth_credential_intent",
    {
      attempt_key: keyColumn("attempt_key"),
      owner: keyColumn("owner"),
      integration: keyColumn("integration"),
      name: keyColumn("name"),
      template: keyColumn("template"),
      provider_key: keyColumn("provider_key"),
      item_id: textColumn("item_id"),
      refresh_item_id: nullableTextColumn("refresh_item_id"),
      oauth_client: keyColumn("oauth_client"),
      oauth_client_owner: keyColumn("oauth_client_owner"),
      oauth_token_url: nullableTextColumn("oauth_token_url"),
      identity_label: nullableTextColumn("identity_label"),
      expires_at: nullableBigintColumn("expires_at"),
      oauth_scope: nullableTextColumn("oauth_scope"),
      missing_oauth_scopes: nullableJsonColumn("missing_oauth_scopes"),
      access_token_hash: keyColumn("access_token_hash"),
      refresh_token_hash: nullableKeyColumn("refresh_token_hash"),
      status: keyColumn("status"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
      stored_at: nullableDateColumn("stored_at"),
      committed_at: nullableDateColumn("committed_at"),
    },
    ["tenant", "attempt_key"],
  ),

  // Immutable, tenant-scoped evidence that an authorization-code completion
  // minted a connection. This is Executor evidence only: `provider` is the
  // verified integration/provider identity, never a provider-native receipt.
  // Credential values, OAuth codes, client secrets, and refresh material are
  // intentionally absent. The attempt key is unique per tenant so a lost
  // callback can be recovered without re-running the provider exchange.
  oauth_completion_receipt: tenantExecutorTable(
    "oauth_completion_receipt",
    {
      attempt_key: keyColumn("attempt_key"),
      actor_user_id: keyColumn("actor_user_id"),
      organization_id: keyColumn("organization_id"),
      workspace_id: keyColumn("workspace_id"),
      provider: keyColumn("provider"),
      execution_id: keyColumn("execution_id"),
      status: keyColumn("status"),
      result_reference: textColumn("result_reference"),
      connection_owner: keyColumn("connection_owner"),
      connection_integration: keyColumn("connection_integration"),
      connection_name: keyColumn("connection_name"),
      connection_address: textColumn("connection_address"),
      request_hash: keyColumn("request_hash"),
      descriptor_hash: keyColumn("descriptor_hash"),
      started_at: dateColumn("started_at"),
      completed_at: dateColumn("completed_at"),
      duration_ms: bigintColumn("duration_ms"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "attempt_key"],
  ),

  // Persisted, per-connection tools (option C). Address is derived from
  // (integration, owner, connection, name).
  tool: ownedExecutorTable(
    "tool",
    {
      integration: keyColumn("integration"),
      connection: keyColumn("connection"),
      plugin_id: textColumn("plugin_id"),
      name: keyColumn("name"),
      description: textColumn("description"),
      input_schema: nullableJsonColumn("input_schema"),
      output_schema: nullableJsonColumn("output_schema"),
      annotations: nullableJsonColumn("annotations"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "integration", "connection", "name"],
  ),

  // Shared JSON-schema $defs, per-connection (mirrors `tool`).
  definition: ownedExecutorTable(
    "definition",
    {
      integration: keyColumn("integration"),
      connection: keyColumn("connection"),
      plugin_id: textColumn("plugin_id"),
      name: keyColumn("name"),
      schema: jsonColumn("schema"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "owner", "subject", "integration", "connection", "name"],
  ),

  // User-authored tool policies (approve / require_approval / block).
  tool_policy: ownedExecutorTable(
    "tool_policy",
    {
      id: keyColumn("id"),
      pattern: textColumn("pattern"),
      action: textColumn("action"),
      position: textColumn("position"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "id"],
  ),

  // Host-owned plugin storage (shared `plugin_storage` table, owner-scoped).
  plugin_storage: ownedExecutorTable(
    "plugin_storage",
    {
      plugin_id: keyColumn("plugin_id"),
      collection: keyColumn("collection"),
      key: keyColumn("key"),
      data: jsonColumn("data"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "plugin_id", "collection", "key"],
  ),

  // Opaque blob store, global. Isolation is carried in `namespace` (which
  // encodes the owner partition + plugin id), so this table is unscoped.
  blob: unscopedExecutorTable("blob", {
    namespace: keyColumn("namespace"),
    key: keyColumn("key"),
    value: textColumn("value"),
  }),
});

export const coreSchema = coreTables;
export type CoreSchema = typeof coreTables;

export type IntegrationRow = FumaRow<CoreSchema["integration"]>;
export type ConnectionRow = FumaRow<CoreSchema["connection"]>;
export type OAuthClientRow = FumaRow<CoreSchema["oauth_client"]>;
export type OAuthSessionRow = FumaRow<CoreSchema["oauth_session"]>;
export type OAuthAttemptRow = FumaRow<CoreSchema["oauth_attempt"]>;
export type OAuthCredentialIntentRow = FumaRow<CoreSchema["oauth_credential_intent"]>;
export type OAuthCompletionReceiptRow = FumaRow<CoreSchema["oauth_completion_receipt"]>;
export type ToolRow = FumaRow<CoreSchema["tool"]>;
/** The tool-row projection the invoke/list hot paths load: everything except
 *  the heavy `input_schema`/`output_schema` JSON, which only `tools.schema`
 *  (describe) needs. Plugin `invokeTool` receives this shape — operation
 *  details ride in plugin storage or `annotations`, not the row schemas. */
export type ToolInvocationRow = Omit<ToolRow, "input_schema" | "output_schema">;
/** The columns backing {@link ToolInvocationRow}, for `select` projections. */
export const TOOL_INVOCATION_COLUMNS = [
  "tenant",
  "owner",
  "subject",
  "integration",
  "connection",
  "plugin_id",
  "name",
  "description",
  "annotations",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof ToolRow)[];
export type DefinitionRow = FumaRow<CoreSchema["definition"]>;
export type ToolPolicyRow = FumaRow<CoreSchema["tool_policy"]>;
export type PluginStorageRow = FumaRow<CoreSchema["plugin_storage"]>;
export type BlobRow = FumaRow<CoreSchema["blob"]>;

export type ToolPolicyAction = "approve" | "require_approval" | "block";

export const TOOL_POLICY_ACTIONS = [
  "approve",
  "require_approval",
  "block",
] as const satisfies readonly ToolPolicyAction[];

export const isToolPolicyAction = (value: unknown): value is ToolPolicyAction =>
  typeof value === "string" && (TOOL_POLICY_ACTIONS as readonly string[]).includes(value);
