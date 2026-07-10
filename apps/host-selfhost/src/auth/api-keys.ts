import { Data, Effect } from "effect";

import type { WorkOSClient } from "./workos";

export interface ApiKeyPrincipal {
  readonly accountId: string;
  readonly organizationId: string;
  readonly keyId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly obfuscatedValue: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
}

export interface CreatedApiKey extends ApiKeySummary {
  readonly value: string;
}

export class ApiKeyValidationError extends Data.TaggedError("ApiKeyValidationError")<{
  readonly cause: unknown;
}> {}

export class ApiKeyManagementError extends Data.TaggedError("ApiKeyManagementError")<{
  readonly cause: unknown;
}> {}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null);

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const apiKeyObject = (value: unknown): Record<string, unknown> | null => {
  const outer = record(value);
  if (!outer) return null;
  return record(outer.apiKey ?? outer.api_key ?? outer);
};

const ownerFromResponse = (value: unknown): ApiKeyPrincipal | null => {
  const apiKey = apiKeyObject(value);
  if (!apiKey) return null;
  const id = stringValue(apiKey.id);
  const owner = record(apiKey.owner);
  const ownerType = stringValue(owner?.type);
  const ownerId = stringValue(owner?.id);
  if (!id || !owner || !ownerType || !ownerId) return null;

  const permissions = stringArray(apiKey.permissions);
  if (ownerType === "organization") {
    return {
      accountId: `api-key:${id}`,
      organizationId: ownerId,
      keyId: id,
      roles: ["service"],
      permissions,
    };
  }
  if (ownerType !== "user") return null;
  const organizationId = stringValue(owner.organizationId ?? owner.organization_id);
  return organizationId
    ? {
        accountId: ownerId,
        organizationId,
        keyId: id,
        roles: [],
        permissions,
      }
    : null;
};

const summaryFromApiKey = (value: unknown): ApiKeySummary | null => {
  const apiKey = apiKeyObject(value);
  if (!apiKey) return null;
  const id = stringValue(apiKey.id);
  if (!id) return null;
  return {
    id,
    name: stringValue(apiKey.name) ?? "API key",
    obfuscatedValue: stringValue(apiKey.obfuscatedValue ?? apiKey.obfuscated_value) ?? "",
    createdAt: stringValue(apiKey.createdAt ?? apiKey.created_at) ?? "",
    updatedAt: stringValue(apiKey.updatedAt ?? apiKey.updated_at) ?? "",
    lastUsedAt: stringValue(apiKey.lastUsedAt ?? apiKey.last_used_at),
  };
};

const listFromResponse = (value: unknown): readonly ApiKeySummary[] => {
  const outer = record(value);
  if (!outer || !Array.isArray(outer.data)) return [];
  return outer.data.flatMap((item) => {
    const summary = summaryFromApiKey(item);
    return summary ? [summary] : [];
  });
};

const createdFromResponse = (value: unknown): CreatedApiKey | null => {
  const apiKey = apiKeyObject(value);
  const summary = summaryFromApiKey(value);
  const secret = stringValue(apiKey?.value);
  return summary && secret ? { ...summary, value: secret } : null;
};

export interface ApiKeyService {
  readonly validate: (
    value: string,
  ) => Effect.Effect<ApiKeyPrincipal | null, ApiKeyValidationError>;
  readonly listUserKeys: (input: {
    readonly accountId: string;
    readonly organizationId: string;
  }) => Effect.Effect<readonly ApiKeySummary[], ApiKeyManagementError>;
  readonly createUserKey: (input: {
    readonly accountId: string;
    readonly organizationId: string;
    readonly name: string;
  }) => Effect.Effect<CreatedApiKey, ApiKeyManagementError>;
  readonly revokeUserKey: (keyId: string) => Effect.Effect<void, ApiKeyManagementError>;
}

export const makeApiKeyService = (workos: WorkOSClient): ApiKeyService => ({
  validate: (value) =>
    workos.validateApiKey(value).pipe(
      Effect.map(ownerFromResponse),
      Effect.mapError((cause) => new ApiKeyValidationError({ cause })),
    ),
  listUserKeys: ({ accountId, organizationId }) =>
    workos.listUserApiKeys(accountId, organizationId).pipe(
      Effect.map(listFromResponse),
      Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
    ),
  createUserKey: ({ accountId, organizationId, name }) =>
    workos.createUserApiKey({ userId: accountId, organizationId, name }).pipe(
      Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
      Effect.flatMap((response) => {
        const created = createdFromResponse(response);
        return created
          ? Effect.succeed(created)
          : Effect.fail(new ApiKeyManagementError({ cause: "invalid_create_response" }));
      }),
    ),
  revokeUserKey: (keyId) =>
    workos
      .deleteApiKey(keyId)
      .pipe(Effect.mapError((cause) => new ApiKeyManagementError({ cause }))),
});
