import { createHmac } from "node:crypto";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  canonicalOAuthCorrelationEnvelopePayload,
  type OAuthCorrelationEnvelope,
} from "@executor-js/sdk";

import { loadOAuthCorrelationConfig, makeOAuthCorrelationVerifier } from "./oauth-correlation";

const key = "correlation-test-key-with-at-least-32-bytes";
const audience = "mnfst-executor-oauth-v1";
const keyId = "mnfst-test";
const now = Date.parse("2026-08-25T20:00:00.000Z");

const signedEnvelope = (overrides: Partial<OAuthCorrelationEnvelope> = {}) => {
  const unsigned: OAuthCorrelationEnvelope = {
    schemaVersion: "executor.oauth-correlation.v2",
    attemptKey: "attempt_01",
    actorUserId: "user_01",
    authenticatedSubjectId: "service_01",
    organizationId: "org_01",
    workspaceId: "workspace_01",
    provider: "linear",
    keyId,
    issuedAt: "2026-08-25T19:59:00.000Z",
    expiresAt: "2026-08-25T20:04:00.000Z",
    signature: "placeholder",
    ...overrides,
  };
  return {
    ...unsigned,
    signature: createHmac("sha256", key)
      .update(audience)
      .update("\0")
      .update(canonicalOAuthCorrelationEnvelopePayload(unsigned))
      .digest("base64url"),
  };
};

const config = loadOAuthCorrelationConfig({
  EXECUTOR_OAUTH_CORRELATION_AUDIENCE: audience,
  EXECUTOR_OAUTH_CORRELATION_KEY: key,
  EXECUTOR_OAUTH_CORRELATION_KEY_ID: keyId,
});

it.effect("returns the exact signed binding", () =>
  Effect.gen(function* () {
    const binding = yield* makeOAuthCorrelationVerifier(config, () => now)(signedEnvelope());
    expect(binding).toEqual({
      schemaVersion: "executor.oauth-correlation.v2",
      attemptKey: "attempt_01",
      actorUserId: "user_01",
      authenticatedSubjectId: "service_01",
      organizationId: "org_01",
      workspaceId: "workspace_01",
      provider: "linear",
    });
  }),
);

it.effect("rejects tampering, key drift, and expired envelopes", () =>
  Effect.gen(function* () {
    const verifier = makeOAuthCorrelationVerifier(config, () => now);
    yield* Effect.flip(verifier({ ...signedEnvelope(), workspaceId: "workspace_forged" }));
    yield* Effect.flip(verifier(signedEnvelope({ keyId: "mnfst-retired" })));
    yield* Effect.flip(
      verifier(
        signedEnvelope({
          issuedAt: "2026-08-25T19:40:00.000Z",
          expiresAt: "2026-08-25T19:45:00.000Z",
        }),
      ),
    );
  }),
);

it("fails closed on absent or weak configuration", () => {
  expect(() => loadOAuthCorrelationConfig({})).toThrow();
  expect(() =>
    loadOAuthCorrelationConfig({
      EXECUTOR_OAUTH_CORRELATION_AUDIENCE: audience,
      EXECUTOR_OAUTH_CORRELATION_KEY: "weak",
      EXECUTOR_OAUTH_CORRELATION_KEY_ID: keyId,
    }),
  ).toThrow();
});
