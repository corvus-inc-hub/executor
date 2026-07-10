import { AssumeRoleCommand, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { makeAwsRoleAssumer } from "./aws-role-assumer";

const input = {
  roleArn: "arn:aws:iam::123456789012:role/executor-bedrock",
  region: "us-east-1",
  externalId: "manifest-production",
  roleSessionName: "executor-123",
  durationSeconds: 900,
};

describe("AWS role assumer", () => {
  it.effect("calls AssumeRole and decodes the complete temporary session", () =>
    Effect.gen(function* () {
      let command: AssumeRoleCommand | undefined;
      const assumeRole = makeAwsRoleAssumer(() => ({
        send: async (value) => {
          command = value;
          return {
            $metadata: {},
            Credentials: {
              AccessKeyId: "ASIA_TEMPORARY",
              SecretAccessKey: "temporary-secret",
              SessionToken: "temporary-session",
              Expiration: new Date("2026-07-10T12:15:00.000Z"),
            },
          };
        },
      }));

      const credentials = yield* assumeRole(input);
      expect(command).toBeInstanceOf(AssumeRoleCommand);
      expect(command?.input).toEqual({
        RoleArn: input.roleArn,
        RoleSessionName: input.roleSessionName,
        DurationSeconds: input.durationSeconds,
        ExternalId: input.externalId,
      });
      expect(credentials).toEqual({
        accessKeyId: "ASIA_TEMPORARY",
        secretAccessKey: "temporary-secret",
        sessionToken: "temporary-session",
        expiresAt: Date.parse("2026-07-10T12:15:00.000Z"),
      });
    }),
  );

  it.effect("fails closed on an incomplete STS response", () =>
    Effect.gen(function* () {
      const assumeRole = makeAwsRoleAssumer(() => ({
        send: async () => ({ $metadata: {} }) as AssumeRoleCommandOutput,
      }));
      const result = yield* Effect.result(assumeRole(input));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(result.failure).toMatchObject({ reason: "invalid_response" });
    }),
  );
});
