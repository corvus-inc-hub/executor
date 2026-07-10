import type { Client } from "@libsql/client";
import { generateOrgSlug } from "@executor-js/api";
import { Data, Effect } from "effect";

export interface StoredOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export class OrganizationStoreError extends Data.TaggedError("OrganizationStoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const query = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrganizationStoreError({ operation, cause }),
  });

const organizationFromRow = (row: Record<string, unknown> | undefined): StoredOrganization | null =>
  row && typeof row.id === "string" && typeof row.name === "string" && typeof row.slug === "string"
    ? { id: row.id, name: row.name, slug: row.slug }
    : null;

export const ensureWorkOSIdentityTables = (
  client: Client,
): Effect.Effect<void, OrganizationStoreError> =>
  query("ensure_workos_identity_tables", async () => {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS workos_organization (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credential_lease_receipt (
        id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL,
        integration TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        requested_scopes_json TEXT NOT NULL,
        granted_scopes_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        dispose_after TEXT NOT NULL,
        source_expires_at TEXT,
        material_hash TEXT NOT NULL,
        material_manifest_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS credential_lease_receipt_org_run_idx
        ON credential_lease_receipt (organization_id, run_id, issued_at);
    `);
  }).pipe(Effect.asVoid);

export interface OrganizationStore {
  readonly getById: (
    id: string,
  ) => Effect.Effect<StoredOrganization | null, OrganizationStoreError>;
  readonly getBySlug: (
    slug: string,
  ) => Effect.Effect<StoredOrganization | null, OrganizationStoreError>;
  readonly upsert: (organization: {
    readonly id: string;
    readonly name: string;
  }) => Effect.Effect<StoredOrganization, OrganizationStoreError>;
}

export const makeOrganizationStore = (client: Client): OrganizationStore => {
  const getById = (id: string) =>
    query("get_organization_by_id", async () => {
      const result = await client.execute({
        sql: "SELECT id, name, slug FROM workos_organization WHERE id = ? LIMIT 1",
        args: [id],
      });
      return organizationFromRow(result.rows[0] as Record<string, unknown> | undefined);
    });

  const getBySlug = (slug: string) =>
    query("get_organization_by_slug", async () => {
      const result = await client.execute({
        sql: "SELECT id, name, slug FROM workos_organization WHERE slug = ? LIMIT 1",
        args: [slug],
      });
      return organizationFromRow(result.rows[0] as Record<string, unknown> | undefined);
    });

  const slugTaken = (slug: string): Promise<boolean> =>
    client
      .execute({
        sql: "SELECT 1 FROM workos_organization WHERE slug = ? LIMIT 1",
        args: [slug],
      })
      .then((result) => result.rows.length > 0);

  const upsert = (organization: { readonly id: string; readonly name: string }) =>
    Effect.gen(function* () {
      const existing = yield* getById(organization.id);
      const now = new Date().toISOString();
      if (existing) {
        yield* query("update_organization", () =>
          client.execute({
            sql: "UPDATE workos_organization SET name = ?, updated_at = ? WHERE id = ?",
            args: [organization.name, now, organization.id],
          }),
        );
        return { ...existing, name: organization.name };
      }

      for (let attempt = 0; attempt < 4; attempt++) {
        const slug = yield* query("generate_organization_slug", () =>
          generateOrgSlug(organization.name, slugTaken),
        );
        const inserted = yield* query("insert_organization", () =>
          client.execute({
            sql: `INSERT INTO workos_organization (id, name, slug, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?)`,
            args: [organization.id, organization.name, slug, now, now],
          }),
        ).pipe(
          Effect.as(true),
          Effect.catchTag("OrganizationStoreError", () => Effect.succeed(false)),
        );
        if (inserted) return { ...organization, slug };
        const concurrent = yield* getById(organization.id);
        if (concurrent) return concurrent;
      }

      return yield* new OrganizationStoreError({
        operation: "upsert_organization",
        cause: `Unable to allocate a slug for WorkOS organization ${organization.id}`,
      });
    });

  return { getById, getBySlug, upsert };
};
