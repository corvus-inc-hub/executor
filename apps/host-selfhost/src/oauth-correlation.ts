import { createHmac, createSecretKey, type KeyObject, timingSafeEqual } from "node:crypto";

import { Effect } from "effect";

import {
  canonicalOAuthCorrelationEnvelopePayload,
  type OAuthCorrelationBinding,
  type OAuthCorrelationEnvelope,
  type OAuthCorrelationVerifier,
  StorageError,
} from "@executor-js/sdk";

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIN_KEY_BYTES = 32;
const MAX_ENVELOPE_LIFETIME_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;

type OAuthCorrelationConfig = {
  readonly audience: string;
  readonly key: KeyObject;
  readonly keyId: string;
};

const storageFailure = (message: string) => new StorageError({ message, cause: null });

const required = (value: string | undefined, name: string): string => {
  const normalized = value?.trim();
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process configuration is synchronously loaded while the host Layer boots
  if (!normalized) throw storageFailure(`${name} is required.`);
  return normalized;
};

export const loadOAuthCorrelationConfig = (
  env: NodeJS.ProcessEnv = process.env,
): OAuthCorrelationConfig => {
  const audience = required(env.EXECUTOR_OAUTH_CORRELATION_AUDIENCE, "OAuth audience");
  const keyId = required(env.EXECUTOR_OAUTH_CORRELATION_KEY_ID, "OAuth key ID");
  const key = required(env.EXECUTOR_OAUTH_CORRELATION_KEY, "OAuth correlation key");
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process configuration is synchronously loaded while the host Layer boots
  if (!KEY_ID_PATTERN.test(keyId)) throw storageFailure("OAuth key ID is invalid.");
  if (Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process configuration is synchronously loaded while the host Layer boots
    throw storageFailure("OAuth correlation key is too short.");
  }
  return { audience, key: createSecretKey(Buffer.from(key, "utf8")), keyId };
};

const signatureFor = (envelope: OAuthCorrelationEnvelope, config: OAuthCorrelationConfig): Buffer =>
  createHmac("sha256", config.key)
    .update(config.audience)
    .update("\0")
    .update(canonicalOAuthCorrelationEnvelopePayload(envelope))
    .digest();

const verifyEnvelope = (
  envelope: OAuthCorrelationEnvelope,
  config: OAuthCorrelationConfig,
  now: number,
): OAuthCorrelationBinding => {
  if (envelope.keyId !== config.keyId || !SIGNATURE_PATTERN.test(envelope.signature)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Effect.try translates the synchronous crypto verifier into StorageError
    throw storageFailure("OAuth correlation signature is invalid.");
  }
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_ENVELOPE_LIFETIME_MS ||
    issuedAt > now + CLOCK_SKEW_MS ||
    expiresAt < now - CLOCK_SKEW_MS
  ) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Effect.try translates the synchronous crypto verifier into StorageError
    throw storageFailure("OAuth correlation lifetime is invalid or expired.");
  }
  const supplied = Buffer.from(envelope.signature, "base64url");
  const expected = signatureFor(envelope, config);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Effect.try translates the synchronous crypto verifier into StorageError
    throw storageFailure("OAuth correlation signature is invalid.");
  }
  return {
    schemaVersion: envelope.schemaVersion,
    attemptKey: envelope.attemptKey,
    actorUserId: envelope.actorUserId,
    organizationId: envelope.organizationId,
    workspaceId: envelope.workspaceId,
    provider: envelope.provider,
  };
};

export const makeOAuthCorrelationVerifier =
  (config: OAuthCorrelationConfig, now: () => number = Date.now): OAuthCorrelationVerifier =>
  (envelope) =>
    Effect.try({
      try: () => verifyEnvelope(envelope, config, now()),
      catch: (cause) =>
        new StorageError({
          message: "OAuth correlation verification failed.",
          cause,
        }),
    });
