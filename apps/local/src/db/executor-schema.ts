// ---------------------------------------------------------------------------
// Drizzle schema for the v2 executor core tables.
//
// This file exists ONLY to drive `drizzle-kit generate` for the committed
// migration baseline (`apps/local/drizzle`). It is NOT used at runtime: the
// local server brings its SQLite schema up directly from the FumaDB
// `coreTables` definition via `createDrizzleRuntimeSchemaSqlFromTables`
// (see `./sqlite-fumadb.ts`). It mirrors the column set FumaDB derives from
// `@executor-js/sdk`'s `coreTables` so the generated baseline matches the
// runtime schema. Keep it in sync if `coreTables` changes.
// ---------------------------------------------------------------------------

import { sqliteTable, text, integer, blob, uniqueIndex } from "drizzle-orm/sqlite-core";

export const integration = sqliteTable(
  "integration",
  {
    slug: text("slug").notNull(),
    plugin_id: text("plugin_id").notNull(),
    description: text("description").notNull(),
    config: text("config"),
    can_remove: integer("can_remove").notNull().default(1),
    can_refresh: integer("can_refresh").notNull().default(0),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
  },
  (table) => [uniqueIndex("integration_uidx").on(table.tenant, table.slug)],
);

export const connection = sqliteTable(
  "connection",
  {
    integration: text("integration").notNull(),
    name: text("name").notNull(),
    template: text("template").notNull(),
    provider: text("provider").notNull(),
    item_ids: text("item_ids").notNull(),
    identity_label: text("identity_label"),
    oauth_client: text("oauth_client"),
    oauth_client_owner: text("oauth_client_owner"),
    refresh_item_id: text("refresh_item_id"),
    expires_at: blob("expires_at"),
    oauth_scope: text("oauth_scope"),
    oauth_token_url: text("oauth_token_url"),
    provider_state: text("provider_state"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("connection_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.integration,
      table.name,
    ),
  ],
);

export const oauth_client = sqliteTable(
  "oauth_client",
  {
    slug: text("slug").notNull(),
    authorization_url: text("authorization_url").notNull(),
    token_url: text("token_url").notNull(),
    grant: text("grant").notNull(),
    client_id: text("client_id").notNull(),
    client_secret_item_id: text("client_secret_item_id"),
    resource: text("resource"),
    origin_kind: text("origin_kind"),
    origin_integration: text("origin_integration"),
    origin_issuer: text("origin_issuer"),
    created_at: integer("created_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("oauth_client_uidx").on(table.tenant, table.owner, table.subject, table.slug),
  ],
);

export const oauth_session = sqliteTable(
  "oauth_session",
  {
    state: text("state").notNull(),
    client_slug: text("client_slug").notNull(),
    integration: text("integration").notNull(),
    name: text("name").notNull(),
    template: text("template").notNull(),
    redirect_url: text("redirect_url").notNull(),
    pkce_verifier: text("pkce_verifier"),
    identity_label: text("identity_label"),
    payload: text("payload").notNull(),
    attempt_key: text("attempt_key"),
    actor_user_id: text("actor_user_id"),
    workspace_id: text("workspace_id"),
    provider: text("provider"),
    descriptor_hash: text("descriptor_hash"),
    execution_id: text("execution_id"),
    correlation_envelope: text("correlation_envelope"),
    expires_at: blob("expires_at").notNull(),
    created_at: integer("created_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("oauth_session_uidx").on(table.tenant, table.state),
    uniqueIndex("oauth_session_attempt_uidx").on(table.tenant, table.attempt_key),
  ],
);

export const oauth_attempt = sqliteTable(
  "oauth_attempt",
  {
    attempt_key: text("attempt_key").notNull(),
    state: text("state").notNull(),
    actor_user_id: text("actor_user_id").notNull(),
    organization_id: text("organization_id").notNull(),
    workspace_id: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    integration: text("integration").notNull(),
    execution_id: text("execution_id").notNull(),
    descriptor_hash: text("descriptor_hash").notNull(),
    status: text("status").notNull(),
    lease_token: text("lease_token"),
    lease_generation: integer("lease_generation"),
    lease_expires_at: integer("lease_expires_at"),
    authorization_url: text("authorization_url").notNull(),
    started_at: integer("started_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    completed_at: integer("completed_at"),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
  },
  (table) => [uniqueIndex("oauth_attempt_uidx").on(table.tenant, table.attempt_key)],
);

export const oauth_credential_intent = sqliteTable(
  "oauth_credential_intent",
  {
    attempt_key: text("attempt_key").notNull(),
    owner: text("owner").notNull(),
    integration: text("integration").notNull(),
    name: text("name").notNull(),
    template: text("template").notNull(),
    provider_key: text("provider_key").notNull(),
    item_id: text("item_id").notNull(),
    refresh_item_id: text("refresh_item_id"),
    oauth_client: text("oauth_client").notNull(),
    oauth_client_owner: text("oauth_client_owner").notNull(),
    oauth_token_url: text("oauth_token_url"),
    identity_label: text("identity_label"),
    expires_at: integer("expires_at"),
    oauth_scope: text("oauth_scope"),
    missing_oauth_scopes: text("missing_oauth_scopes"),
    access_token_hash: text("access_token_hash").notNull(),
    refresh_token_hash: text("refresh_token_hash"),
    status: text("status").notNull(),
    lease_token: text("lease_token"),
    lease_generation: integer("lease_generation"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    stored_at: integer("stored_at"),
    committed_at: integer("committed_at"),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
  },
  (table) => [uniqueIndex("oauth_credential_intent_uidx").on(table.tenant, table.attempt_key)],
);

export const oauth_exchange_intent = sqliteTable(
  "oauth_exchange_intent",
  {
    attempt_key: text("attempt_key").notNull(),
    state: text("state").notNull(),
    provider: text("provider").notNull(),
    client_slug: text("client_slug").notNull(),
    code_hash: text("code_hash").notNull(),
    provider_transaction_key: text("provider_transaction_key").notNull(),
    status: text("status").notNull(),
    lease_token: text("lease_token"),
    lease_generation: integer("lease_generation"),
    access_token_hash: text("access_token_hash"),
    refresh_token_hash: text("refresh_token_hash"),
    started_at: integer("started_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    completed_at: integer("completed_at"),
    failure_code: text("failure_code"),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
  },
  (table) => [uniqueIndex("oauth_exchange_intent_uidx").on(table.tenant, table.attempt_key)],
);

export const oauth_credential_item = sqliteTable(
  "oauth_credential_item",
  {
    attempt_key: text("attempt_key").notNull(),
    item_kind: text("item_kind").notNull(),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    provider_key: text("provider_key").notNull(),
    item_id: text("item_id").notNull(),
    token_hash: text("token_hash").notNull(),
    status: text("status").notNull(),
    lease_token: text("lease_token"),
    lease_generation: integer("lease_generation"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    stored_at: integer("stored_at"),
    compensated_at: integer("compensated_at"),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
  },
  (table) => [
    uniqueIndex("oauth_credential_item_uidx").on(table.tenant, table.attempt_key, table.item_kind),
  ],
);

export const oauth_completion_receipt = sqliteTable(
  "oauth_completion_receipt",
  {
    attempt_key: text("attempt_key").notNull(),
    actor_user_id: text("actor_user_id").notNull(),
    organization_id: text("organization_id").notNull(),
    workspace_id: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    execution_id: text("execution_id").notNull(),
    status: text("status").notNull(),
    result_reference: text("result_reference").notNull(),
    connection_owner: text("connection_owner").notNull(),
    connection_integration: text("connection_integration").notNull(),
    connection_name: text("connection_name").notNull(),
    connection_address: text("connection_address").notNull(),
    request_hash: text("request_hash").notNull(),
    descriptor_hash: text("descriptor_hash").notNull(),
    started_at: integer("started_at").notNull(),
    completed_at: integer("completed_at").notNull(),
    duration_ms: integer("duration_ms").notNull(),
    lease_token: text("lease_token"),
    lease_generation: integer("lease_generation"),
    created_at: integer("created_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
  },
  (table) => [uniqueIndex("oauth_completion_receipt_uidx").on(table.tenant, table.attempt_key)],
);

export const tool = sqliteTable(
  "tool",
  {
    integration: text("integration").notNull(),
    connection: text("connection").notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    input_schema: text("input_schema"),
    output_schema: text("output_schema"),
    annotations: text("annotations"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("tool_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.integration,
      table.connection,
      table.name,
    ),
  ],
);

export const definition = sqliteTable(
  "definition",
  {
    integration: text("integration").notNull(),
    connection: text("connection").notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name").notNull(),
    schema: text("schema").notNull(),
    created_at: integer("created_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("definition_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.integration,
      table.connection,
      table.name,
    ),
  ],
);

export const tool_policy = sqliteTable(
  "tool_policy",
  {
    id: text("id").notNull(),
    pattern: text("pattern").notNull(),
    action: text("action").notNull(),
    position: text("position").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("tool_policy_uidx").on(table.tenant, table.owner, table.subject, table.id),
  ],
);

export const plugin_storage = sqliteTable(
  "plugin_storage",
  {
    plugin_id: text("plugin_id").notNull(),
    collection: text("collection").notNull(),
    key: text("key").notNull(),
    data: text("data").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("plugin_storage_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.plugin_id,
      table.collection,
      table.key,
    ),
  ],
);

export const blob_table = sqliteTable(
  "blob",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    id: text("id").notNull(),
  },
  (table) => [uniqueIndex("blob_id_uidx").on(table.id)],
);
