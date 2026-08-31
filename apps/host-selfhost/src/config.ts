import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  missingPublicOriginWarning,
  parseExactOrigins,
  resolvePublicOrigin,
  shouldWarnMissingPublicOrigin,
} from "@executor-js/sdk/public-origin";

export const SELF_HOST_NAMESPACE = "executor_selfhost";
export const SELF_HOST_SCHEMA_VERSION = "1.0.0";

export interface SelfHostConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly webBaseUrl: string;
  readonly allowLocalNetwork: boolean;
  readonly connectionReturnOrigins: readonly string[];
}

export interface WorkOSConfig {
  readonly apiKey: string;
  readonly clientId: string;
  readonly cookiePassword: string;
  readonly apiUrl: string | undefined;
  readonly authkitDomain: string;
  readonly redirectUri: string;
  readonly serviceOrganizationId: string;
  readonly allowedOrganizationIds: ReadonlySet<string>;
  readonly cliClientId: string | undefined;
  readonly connectAudience: string;
  readonly m2mAllowedClientIds: ReadonlySet<string>;
  readonly leaseRequiredScope: string;
  readonly leaseDefaultTtlSeconds: number;
  readonly leaseMaxTtlSeconds: number;
  readonly mcpScopes: readonly string[];
}

export const resolveDataDir = (): string =>
  process.env.EXECUTOR_DATA_DIR ?? join(process.cwd(), ".executor-selfhost");

let cachedSecretKey: string | undefined;

/** Master key for Executor's encrypted credential provider. */
export const resolveSecretKey = (): string => {
  if (cachedSecretKey) return cachedSecretKey;
  const fromEnv = process.env.EXECUTOR_SECRET_KEY?.trim();
  if (fromEnv) {
    cachedSecretKey = fromEnv;
    return fromEnv;
  }
  const keyPath = join(resolveDataDir(), "secret.key");
  if (existsSync(keyPath)) {
    cachedSecretKey = readFileSync(keyPath, "utf8").trim();
    return cachedSecretKey;
  }
  mkdirSync(resolveDataDir(), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[executor] generated a secret-encryption key at ${keyPath}. Set EXECUTOR_SECRET_KEY to manage it explicitly (and to keep secrets readable across data-dir changes).`,
  );
  cachedSecretKey = generated;
  return generated;
};

let warnedNoPublicUrl = false;

const resolveWebBaseUrl = (port: number): string => {
  const resolved = resolvePublicOrigin({
    explicit: process.env.EXECUTOR_WEB_BASE_URL,
    env: process.env,
  });
  if (resolved) return resolved;
  const fallback = `http://localhost:${port}`;
  if (!warnedNoPublicUrl && shouldWarnMissingPublicOrigin(process.env.NODE_ENV)) {
    warnedNoPublicUrl = true;
    console.warn(missingPublicOriginWarning({ varName: "EXECUTOR_WEB_BASE_URL", fallback }));
  }
  return fallback;
};

export const loadConfig = (): SelfHostConfig => {
  const port = Number.parseInt(process.env.PORT ?? "4788", 10);
  const dataDir = resolveDataDir();
  return {
    host: process.env.EXECUTOR_HOST ?? "127.0.0.1",
    port,
    dbPath: process.env.EXECUTOR_DB_PATH ?? join(dataDir, "data.db"),
    webBaseUrl: resolveWebBaseUrl(port),
    allowLocalNetwork: process.env.EXECUTOR_ALLOW_LOCAL_NETWORK === "true",
    connectionReturnOrigins: parseConnectionReturnOrigins(
      process.env.EXECUTOR_CONNECTION_RETURN_ORIGINS,
    ),
  };
};

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value) return value;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: identity configuration must fail at boot
  throw new Error(`${name} is required for the WorkOS self-host identity provider`);
};

const csv = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isSafeInteger(value) && value > 0) return value;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: invalid security limits must fail at boot
  throw new Error(`${name} must be a positive integer`);
};

const normalizedOrigin = (name: string, value: string): string => {
  if (!URL.canParse(value)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: invalid identity configuration must fail at boot
    throw new Error(`${name} must be an absolute URL`);
  }
  const parsed = new URL(value);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: an AuthKit issuer must be an origin
    throw new Error(`${name} must be an origin without a path, query, or fragment`);
  }
  return parsed.origin;
};

export const parseConnectionReturnOrigins = (value: string | undefined): readonly string[] =>
  parseExactOrigins(value, "EXECUTOR_CONNECTION_RETURN_ORIGINS");

export const loadWorkOSConfig = (selfHost = loadConfig()): WorkOSConfig => {
  const provider = process.env.EXECUTOR_AUTH_PROVIDER?.trim();
  if (provider && provider !== "workos-authkit") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: this owned fork intentionally has one identity plane
    throw new Error(
      `EXECUTOR_AUTH_PROVIDER=${JSON.stringify(provider)} is unsupported; use "workos-authkit"`,
    );
  }

  const apiKey = required("WORKOS_API_KEY");
  const clientId = required("WORKOS_CLIENT_ID");
  const cookiePassword = required("WORKOS_COOKIE_PASSWORD");
  if (cookiePassword.length < 32) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: weak session-cookie encryption must fail at boot
    throw new Error("WORKOS_COOKIE_PASSWORD must be at least 32 characters");
  }

  const maxTtl = positiveInteger("EXECUTOR_CREDENTIAL_LEASE_MAX_TTL_SECONDS", 3600);
  const defaultTtl = positiveInteger("EXECUTOR_CREDENTIAL_LEASE_DEFAULT_TTL_SECONDS", 3600);
  if (defaultTtl > maxTtl) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: invalid lease bounds must fail at boot
    throw new Error(
      "EXECUTOR_CREDENTIAL_LEASE_DEFAULT_TTL_SECONDS cannot exceed EXECUTOR_CREDENTIAL_LEASE_MAX_TTL_SECONDS",
    );
  }

  const serviceOrganizationId = required("WORKOS_SERVICE_ORGANIZATION_ID");
  if (!serviceOrganizationId.startsWith("org_")) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: invalid service-identity configuration must fail at boot
    throw new Error("WORKOS_SERVICE_ORGANIZATION_ID must be a WorkOS organization ID");
  }
  const allowedOrganizationIds = csv(process.env.WORKOS_ALLOWED_ORGANIZATION_IDS);

  return {
    apiKey,
    clientId,
    cookiePassword,
    apiUrl: process.env.WORKOS_API_URL?.trim() || undefined,
    authkitDomain: normalizedOrigin("WORKOS_AUTHKIT_DOMAIN", required("WORKOS_AUTHKIT_DOMAIN")),
    redirectUri:
      process.env.WORKOS_REDIRECT_URI?.trim() ||
      new URL("/api/auth/callback", selfHost.webBaseUrl).toString(),
    serviceOrganizationId,
    allowedOrganizationIds,
    cliClientId: process.env.WORKOS_CLI_CLIENT_ID?.trim() || undefined,
    connectAudience: process.env.WORKOS_CONNECT_AUDIENCE?.trim() || clientId,
    m2mAllowedClientIds: csv(process.env.WORKOS_M2M_ALLOWED_CLIENT_IDS),
    leaseRequiredScope: process.env.WORKOS_CREDENTIAL_LEASE_SCOPE?.trim() || "credentials:lease",
    leaseDefaultTtlSeconds: defaultTtl,
    leaseMaxTtlSeconds: maxTtl,
    mcpScopes: (process.env.WORKOS_MCP_SCOPES ?? "openid profile email offline_access")
      .split(/\s+/)
      .filter((scope) => scope.length > 0),
  };
};
