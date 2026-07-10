import { createHash, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { Data, Effect } from "effect";

import {
  ConnectionName,
  IntegrationSlug,
  type Connection,
  type ConnectionRef,
} from "@executor-js/sdk";

import type { WorkOSConfig } from "../config";
import {
  cachedRemoteJwks,
  verifyWorkOSAccessToken,
  type VerifiedWorkOSToken,
  type WorkOSJwtError,
} from "../auth/jwt";
import type { WorkOSClient } from "../auth/workos";

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const FILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_:./-]{0,127}$/;

export interface CredentialLeaseRequest {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly credential: {
    readonly integration: string;
    readonly name: string;
  };
  readonly purpose: string;
  readonly scopes: readonly string[];
  readonly ttlSeconds?: number;
  readonly delivery: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly secretFiles?: readonly {
      readonly name: string;
      readonly variable: string;
    }[];
  };
}

export interface CredentialLeaseResponse {
  readonly lease: {
    readonly id: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly serviceAccountId: string;
    readonly credential: {
      readonly owner: "org";
      readonly integration: string;
      readonly name: string;
    };
    readonly purpose: string;
    readonly scopes: readonly string[];
    readonly issuedAt: string;
    readonly disposeAfter: string;
    readonly enforcement: "sandbox_cleanup";
    readonly sourceCredentialExpiresAt: string | null;
  };
  readonly material: {
    readonly environment: Readonly<Record<string, string>>;
    readonly secretFiles: readonly {
      readonly name: string;
      readonly content: string;
      readonly mode: "0600";
    }[];
  };
  readonly receipt: {
    readonly materialHash: string;
    readonly entries: readonly {
      readonly kind: "environment" | "secret_file";
      readonly name: string;
      readonly sha256: string;
    }[];
  };
}

export class CredentialLeaseError extends Data.TaggedError("CredentialLeaseError")<{
  readonly status: 400 | 401 | 403 | 409 | 503;
  readonly code:
    | "invalid_request"
    | "unauthorized"
    | "forbidden"
    | "credential_unavailable"
    | "service_unavailable";
  readonly detail: string;
}> {}

const leaseFailure = (
  status: CredentialLeaseError["status"],
  code: CredentialLeaseError["code"],
  detail: string,
) => Effect.fail(new CredentialLeaseError({ status, code, detail }));

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmpty = (value: unknown, max = 128): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;

export const decodeCredentialLeaseRequest = (
  value: unknown,
): CredentialLeaseRequest | CredentialLeaseError => {
  const body = object(value);
  const credential = object(body?.credential);
  const organizationId = nonEmpty(body?.organizationId);
  const workspaceId = nonEmpty(body?.workspaceId);
  const runId = nonEmpty(body?.runId);
  const integration = nonEmpty(credential?.integration);
  const name = nonEmpty(credential?.name);
  const purpose = nonEmpty(body?.purpose, 256);
  if (
    !organizationId ||
    !workspaceId ||
    !runId ||
    !integration ||
    !name ||
    !purpose ||
    !ID.test(organizationId) ||
    !ID.test(workspaceId) ||
    !ID.test(runId)
  ) {
    return new CredentialLeaseError({
      status: 400,
      code: "invalid_request",
      detail: "Invalid lease identity or credential reference",
    });
  }

  if (!Array.isArray(body?.scopes) || body.scopes.length === 0 || body.scopes.length > 32) {
    return new CredentialLeaseError({
      status: 400,
      code: "invalid_request",
      detail: "At least one lease scope is required",
    });
  }
  const scopes = [
    ...new Set(body.scopes.filter((scope): scope is string => typeof scope === "string")),
  ];
  if (scopes.length !== body.scopes.length || scopes.some((scope) => !ID.test(scope))) {
    return new CredentialLeaseError({
      status: 400,
      code: "invalid_request",
      detail: "Lease scopes must be unique identifiers",
    });
  }

  let ttlSeconds: number | undefined;
  if (body.ttlSeconds !== undefined) {
    if (
      typeof body.ttlSeconds !== "number" ||
      !Number.isSafeInteger(body.ttlSeconds) ||
      body.ttlSeconds <= 0
    ) {
      return new CredentialLeaseError({
        status: 400,
        code: "invalid_request",
        detail: "ttlSeconds must be a positive integer",
      });
    }
    ttlSeconds = body.ttlSeconds;
  }

  const rawDelivery = body.delivery;
  const parsed = object(rawDelivery);
  if (!parsed) {
    return new CredentialLeaseError({
      status: 400,
      code: "invalid_request",
      detail: "An explicit credential delivery mapping is required",
    });
  }
  const rawEnvironment = object(parsed.environment);
  const environment: Record<string, string> = {};
  if (rawEnvironment) {
    for (const [destination, variable] of Object.entries(rawEnvironment)) {
      const parsedVariable = nonEmpty(variable);
      if (!ENV_NAME.test(destination) || !parsedVariable) {
        return new CredentialLeaseError({
          status: 400,
          code: "invalid_request",
          detail: "Invalid environment delivery mapping",
        });
      }
      environment[destination] = parsedVariable;
    }
  }

  const rawFiles = parsed.secretFiles;
  if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
    return new CredentialLeaseError({
      status: 400,
      code: "invalid_request",
      detail: "secretFiles must be an array",
    });
  }
  const secretFiles = (rawFiles ?? []).flatMap((item) => {
    const file = object(item);
    const fileName = nonEmpty(file?.name);
    const variable = nonEmpty(file?.variable);
    return fileName && variable ? [{ name: fileName, variable }] : [];
  });
  if (
    secretFiles.length !== (rawFiles ?? []).length ||
    secretFiles.some((file) => !FILE_NAME.test(file.name)) ||
    Object.keys(environment).length + secretFiles.length === 0 ||
    Object.keys(environment).length + secretFiles.length > 64
  ) {
    return new CredentialLeaseError({
      status: 400,
      code: "invalid_request",
      detail: "Invalid or empty credential delivery mapping",
    });
  }
  const delivery = { environment, secretFiles };

  return {
    organizationId,
    workspaceId,
    runId,
    credential: { integration, name },
    purpose,
    scopes,
    delivery,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
};

export interface ResolvedCredential {
  readonly connection: Connection;
  readonly values: Readonly<Record<string, string | null>>;
}

export interface CredentialLeaseDeps {
  readonly config: WorkOSConfig;
  readonly workos: WorkOSClient;
  readonly db: Client;
  readonly resolveCredential: (
    serviceAccountId: string,
    organizationId: string,
    ref: ConnectionRef,
  ) => Effect.Effect<ResolvedCredential | null, unknown>;
  readonly verifyM2mToken?: (
    token: string,
  ) => Effect.Effect<VerifiedWorkOSToken | null, WorkOSJwtError>;
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const requestedDelivery = (
  request: CredentialLeaseRequest,
  values: Readonly<Record<string, string>>,
) => {
  const environmentMapping = request.delivery.environment ?? {};
  const fileMapping = request.delivery.secretFiles ?? [];
  const environment: Record<string, string> = {};
  const secretFiles: Array<{ name: string; content: string; mode: "0600" }> = [];
  for (const [name, variable] of Object.entries(environmentMapping)) {
    const value = values[variable];
    if (value === undefined) return null;
    environment[name] = value;
  }
  for (const file of fileMapping) {
    const value = values[file.variable];
    if (value === undefined) return null;
    secretFiles.push({ name: file.name, content: value, mode: "0600" });
  }
  return { environment, secretFiles };
};

const materialReceipt = (material: CredentialLeaseResponse["material"]) => {
  const entries = [
    ...Object.entries(material.environment).map(([name, value]) => ({
      kind: "environment" as const,
      name,
      sha256: sha256(value),
    })),
    ...material.secretFiles.map((file) => ({
      kind: "secret_file" as const,
      name: file.name,
      sha256: sha256(file.content),
    })),
  ].sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
  return { materialHash: sha256(JSON.stringify(entries)), entries };
};

const bearer = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() || null : null;
};

export const makeCredentialLeaseService = (deps: CredentialLeaseDeps) => ({
  lease: (
    request: Request,
    input: CredentialLeaseRequest,
  ): Effect.Effect<CredentialLeaseResponse, CredentialLeaseError> =>
    Effect.gen(function* () {
      const token = bearer(request);
      if (!token || token.split(".").length !== 3) {
        return yield* leaseFailure(401, "unauthorized", "A WorkOS M2M bearer token is required");
      }
      const verifyToken =
        deps.verifyM2mToken ??
        ((value: string) =>
          verifyWorkOSAccessToken(
            value,
            cachedRemoteJwks(`${deps.config.authkitDomain}/oauth2/jwks`),
            { issuer: deps.config.authkitDomain, audience: deps.config.connectAudience },
          ));
      const verified = yield* verifyToken(token).pipe(
        Effect.mapError((error) =>
          error.reason === "system"
            ? new CredentialLeaseError({
                status: 503,
                code: "service_unavailable",
                detail: "M2M verification is unavailable",
              })
            : new CredentialLeaseError({
                status: 401,
                code: "unauthorized",
                detail: "Invalid WorkOS M2M bearer token",
              }),
        ),
      );
      if (
        !verified ||
        !verified.subject.startsWith("client_") ||
        !verified.organizationId ||
        verified.organizationId !== deps.config.serviceOrganizationId
      ) {
        return yield* leaseFailure(403, "forbidden", "M2M platform identity is not authorized");
      }
      if (
        deps.config.m2mAllowedClientIds.size === 0 ||
        !deps.config.m2mAllowedClientIds.has(verified.subject)
      ) {
        return yield* leaseFailure(
          403,
          "forbidden",
          "M2M client is not allowed to lease credentials",
        );
      }

      const application = yield* deps.workos.getConnectApplication(verified.subject).pipe(
        Effect.mapError(
          () =>
            new CredentialLeaseError({
              status: 503,
              code: "service_unavailable",
              detail: "M2M authorization is unavailable",
            }),
        ),
      );
      if (
        !application ||
        application.applicationType !== "m2m" ||
        application.organizationId !== deps.config.serviceOrganizationId ||
        application.clientId !== verified.subject
      ) {
        return yield* leaseFailure(
          403,
          "forbidden",
          "M2M application is not authorized as the platform service",
        );
      }
      const authorizationScope = deps.config.leaseRequiredScope;
      if (!application.scopes.includes(authorizationScope)) {
        return yield* leaseFailure(
          403,
          "forbidden",
          "M2M application lacks the credential lease permission",
        );
      }
      if (verified.scopes.length > 0 && !verified.scopes.includes(authorizationScope)) {
        return yield* leaseFailure(403, "forbidden", "M2M token lacks the credential lease scope");
      }

      const ttlSeconds = input.ttlSeconds ?? deps.config.leaseDefaultTtlSeconds;
      if (ttlSeconds > deps.config.leaseMaxTtlSeconds) {
        return yield* leaseFailure(
          400,
          "invalid_request",
          "Requested lease TTL exceeds the configured maximum",
        );
      }

      const ref: ConnectionRef = {
        owner: "org",
        integration: IntegrationSlug.make(input.credential.integration),
        name: ConnectionName.make(input.credential.name),
      };
      const resolved = yield* deps
        .resolveCredential(verified.subject, input.organizationId, ref)
        .pipe(
          Effect.mapError(
            () =>
              new CredentialLeaseError({
                status: 503,
                code: "service_unavailable",
                detail: "Credential resolution is unavailable",
              }),
          ),
        );
      if (!resolved) {
        return yield* leaseFailure(409, "credential_unavailable", "Credential cannot be leased");
      }
      const entries = Object.entries(resolved.values);
      if (
        entries.length === 0 ||
        entries.some(([, value]) => value === null || value.length === 0)
      ) {
        return yield* leaseFailure(
          409,
          "credential_unavailable",
          "Credential material is incomplete",
        );
      }
      const values = Object.fromEntries(entries) as Record<string, string>;
      const grantedCredentialScopes = new Set(
        (resolved.connection.oauthScope ?? "").split(/\s+/).filter(Boolean),
      );
      if (
        grantedCredentialScopes.size > 0 &&
        input.scopes.some((scope) => !grantedCredentialScopes.has(scope))
      ) {
        return yield* leaseFailure(
          403,
          "forbidden",
          "Connected credential does not grant a requested resource scope",
        );
      }
      const material = requestedDelivery(input, values);
      if (!material) {
        return yield* leaseFailure(
          409,
          "credential_unavailable",
          "Requested credential variable is unavailable",
        );
      }

      const receipt = materialReceipt(material);
      const now = (deps.now ?? (() => new Date()))();
      const issuedAt = now.toISOString();
      const requestedDisposal = now.getTime() + ttlSeconds * 1000;
      const sourceExpiration = resolved.connection.expiresAt ?? null;
      if (sourceExpiration !== null && sourceExpiration <= now.getTime()) {
        return yield* leaseFailure(409, "credential_unavailable", "Credential has expired");
      }
      const disposeAfter = new Date(
        sourceExpiration === null
          ? requestedDisposal
          : Math.min(requestedDisposal, sourceExpiration),
      ).toISOString();
      const sourceCredentialExpiresAt =
        sourceExpiration === null ? null : new Date(sourceExpiration).toISOString();
      const id = (deps.uuid ?? randomUUID)();
      yield* Effect.tryPromise({
        try: () =>
          deps.db.execute({
            sql: `INSERT INTO credential_lease_receipt (
                    id, organization_id, workspace_id, run_id, service_account_id,
                    integration, connection_name, purpose, requested_scopes_json,
                    granted_scopes_json, issued_at, dispose_after, source_expires_at, material_hash,
                    material_manifest_json
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              id,
              input.organizationId,
              input.workspaceId,
              input.runId,
              verified.subject,
              input.credential.integration,
              input.credential.name,
              input.purpose,
              JSON.stringify(input.scopes),
              JSON.stringify([...grantedCredentialScopes]),
              issuedAt,
              disposeAfter,
              sourceCredentialExpiresAt,
              receipt.materialHash,
              JSON.stringify(receipt.entries),
            ],
          }),
        catch: () =>
          new CredentialLeaseError({
            status: 503,
            code: "service_unavailable",
            detail: "Lease receipt could not be recorded",
          }),
      });

      return {
        lease: {
          id,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          serviceAccountId: verified.subject,
          credential: {
            owner: "org",
            integration: input.credential.integration,
            name: input.credential.name,
          },
          purpose: input.purpose,
          scopes: input.scopes,
          issuedAt,
          disposeAfter,
          enforcement: "sandbox_cleanup",
          sourceCredentialExpiresAt,
        },
        material,
        receipt,
      };
    }),
});
