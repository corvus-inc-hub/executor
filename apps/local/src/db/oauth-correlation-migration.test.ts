import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { openLocalLibsql, queryFirst } from "./libsql";

const migrationsFolder = join(import.meta.dirname, "../../drizzle");

const applyMigration = async (
  client: Awaited<ReturnType<typeof openLocalLibsql>>,
  file: string,
): Promise<void> => {
  await client.executeMultiple(readFileSync(join(migrationsFolder, file), "utf8"));
};

describe("OAuth correlation migration", () => {
  it.effect(
    "backfills the authenticated service subject without weakening new-row constraints",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-oauth-correlation-migration-"))),
            (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
          );
          const client = yield* Effect.acquireRelease(
            Effect.promise(() => openLocalLibsql(join(directory, "executor.db"))),
            (resource) => Effect.sync(() => resource.close()),
          );
          const priorMigrations = readdirSync(migrationsFolder)
            .filter((file) => /^000[0-7]_.*\.sql$/u.test(file))
            .sort();
          for (const file of priorMigrations) {
            yield* Effect.promise(() => applyMigration(client, file));
          }

          yield* Effect.promise(() =>
            client.executeMultiple(`
        INSERT INTO oauth_session (
          state, client_slug, integration, name, template, redirect_url, payload,
          expires_at, created_at, row_id, tenant, owner, subject
        ) VALUES (
          'state-1', 'client-1', 'github', 'main', 'oauth', 'https://example.test/callback',
          '{}', 1, 1, 'session-row-1', 'tenant-1', 'org', 'service-subject'
        );

        INSERT INTO oauth_attempt (
          attempt_key, state, actor_user_id, organization_id, workspace_id, provider,
          integration, execution_id, descriptor_hash, status, lease_generation,
          authorization_url, started_at, updated_at, completed_at, row_id, tenant
        ) VALUES (
          'attempt-1', 'state-1', 'human-actor', 'tenant-1', 'workspace-1', 'github',
          'github', 'execution-1', '${"a".repeat(64)}', 'completed', 1,
          'https://example.test/authorize', 1, 1, 1, 'attempt-row-1', 'tenant-1'
        );

        INSERT INTO oauth_completion_receipt (
          attempt_key, actor_user_id, organization_id, workspace_id, provider,
          execution_id, status, result_reference, connection_owner,
          connection_integration, connection_name, connection_address, request_hash,
          descriptor_hash, started_at, completed_at, duration_ms, lease_generation,
          created_at, row_id, tenant
        ) VALUES (
          'attempt-1', 'human-actor', 'tenant-1', 'workspace-1', 'github',
          'execution-1', 'completed', 'tools.github.org.main', 'org', 'github',
          'main', 'tools.github.org.main', '${"b".repeat(64)}', '${"a".repeat(64)}',
          1, 1, 0, 1, 1, 'receipt-row-1', 'tenant-1'
        );
          `),
          );

          yield* Effect.promise(() => applyMigration(client, "0008_dusty_reavers.sql"));

          const attempt = yield* Effect.promise(() =>
            queryFirst<{ authenticated_subject_id: string }>(
              client,
              "SELECT authenticated_subject_id FROM oauth_attempt WHERE attempt_key = 'attempt-1'",
            ),
          );
          const receipt = yield* Effect.promise(() =>
            queryFirst<{ authenticated_subject_id: string }>(
              client,
              "SELECT authenticated_subject_id FROM oauth_completion_receipt WHERE attempt_key = 'attempt-1'",
            ),
          );
          const session = yield* Effect.promise(() =>
            queryFirst<{ authenticated_subject_id: string | null }>(
              client,
              "SELECT authenticated_subject_id FROM oauth_session WHERE state = 'state-1'",
            ),
          );

          expect(attempt?.authenticated_subject_id).toBe("human-actor");
          expect(receipt?.authenticated_subject_id).toBe("human-actor");
          expect(session?.authenticated_subject_id).toBeNull();

          const attemptColumn = yield* Effect.promise(() =>
            queryFirst<{ notnull: number }>(
              client,
              "SELECT `notnull` FROM pragma_table_info('oauth_attempt') WHERE name = 'authenticated_subject_id'",
            ),
          );
          const receiptColumn = yield* Effect.promise(() =>
            queryFirst<{ notnull: number }>(
              client,
              "SELECT `notnull` FROM pragma_table_info('oauth_completion_receipt') WHERE name = 'authenticated_subject_id'",
            ),
          );
          expect(attemptColumn?.notnull).toBe(1);
          expect(receiptColumn?.notnull).toBe(1);
        }),
      ),
  );
});
