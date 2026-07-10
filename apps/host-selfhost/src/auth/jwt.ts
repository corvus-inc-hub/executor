import { Data, Effect } from "effect";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { JWKSInvalid, JWKSTimeout, JWTExpired } from "jose/errors";

export class WorkOSJwtError extends Data.TaggedError("WorkOSJwtError")<{
  readonly cause: unknown;
  readonly reason: "expired" | "invalid" | "system";
}> {}

const errorCode = (cause: unknown): string | null =>
  cause &&
  typeof cause === "object" &&
  "code" in cause &&
  typeof (cause as { code: unknown }).code === "string"
    ? (cause as { code: string }).code
    : null;

const classify = (cause: unknown): WorkOSJwtError => {
  const code = errorCode(cause);
  const reason =
    code === JWTExpired.code
      ? "expired"
      : code === JWKSTimeout.code || code === JWKSInvalid.code || code === null
        ? "system"
        : code.startsWith("ERR_J")
          ? "invalid"
          : "system";
  return new WorkOSJwtError({ cause, reason });
};

const verify = (
  token: string,
  jwks: JWTVerifyGetKey,
  options?: { issuer?: string; audience?: string | string[] },
) =>
  Effect.tryPromise({
    try: () => jwtVerify(token, jwks, options),
    catch: classify,
  });

export interface VerifiedWorkOSToken {
  readonly subject: string;
  readonly organizationId: string | null;
  readonly scopes: readonly string[];
  readonly payload: JWTPayload;
}

const scopesFromPayload = (payload: JWTPayload): readonly string[] => {
  const scope = payload.scope;
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  const scp = payload.scp;
  return Array.isArray(scp) ? scp.filter((item): item is string => typeof item === "string") : [];
};

const tokenFromPayload = (payload: JWTPayload): VerifiedWorkOSToken | null =>
  payload.sub
    ? {
        subject: payload.sub,
        organizationId: typeof payload.org_id === "string" ? payload.org_id : null,
        scopes: scopesFromPayload(payload),
        payload,
      }
    : null;

export const verifyWorkOSAccessToken = (
  token: string,
  jwks: JWTVerifyGetKey,
  options: { readonly issuer: string; readonly audience: string | string[] },
) => verify(token, jwks, options).pipe(Effect.map(({ payload }) => tokenFromPayload(payload)));

const remoteJwks = new Map<string, JWTVerifyGetKey>();

export const cachedRemoteJwks = (url: string): JWTVerifyGetKey => {
  const existing = remoteJwks.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url));
  remoteJwks.set(url, created);
  return created;
};
