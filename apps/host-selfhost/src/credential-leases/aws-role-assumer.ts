import { AssumeRoleCommand, STSClient, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { Data, Effect } from "effect";

export interface AwsRoleAssumptionInput {
  readonly roleArn: string;
  readonly region: string;
  readonly externalId?: string;
  readonly roleSessionName: string;
  readonly durationSeconds: number;
}

export interface AwsRoleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: number;
}

export class AwsRoleAssumptionError extends Data.TaggedError("AwsRoleAssumptionError")<{
  readonly reason: "request_failed" | "invalid_response";
  readonly cause?: unknown;
}> {}

export type AwsRoleAssumer = (
  input: AwsRoleAssumptionInput,
) => Effect.Effect<AwsRoleCredentials, AwsRoleAssumptionError>;

export interface StsAssumeRoleClient {
  readonly send: (command: AssumeRoleCommand) => Promise<AssumeRoleCommandOutput>;
}

export type StsClientForRegion = (region: string) => StsAssumeRoleClient;

export const makeAwsRoleAssumer = (clientForRegion?: StsClientForRegion): AwsRoleAssumer => {
  const clients = new Map<string, STSClient>();
  const getClient =
    clientForRegion ??
    ((region: string) => {
      const existing = clients.get(region);
      if (existing) return existing;
      const client = new STSClient({ region });
      clients.set(region, client);
      return client;
    });

  return (input) =>
    Effect.tryPromise({
      try: () =>
        getClient(input.region).send(
          new AssumeRoleCommand({
            RoleArn: input.roleArn,
            RoleSessionName: input.roleSessionName,
            DurationSeconds: input.durationSeconds,
            ...(input.externalId === undefined ? {} : { ExternalId: input.externalId }),
          }),
        ),
      catch: (cause) => new AwsRoleAssumptionError({ reason: "request_failed", cause }),
    }).pipe(
      Effect.flatMap((response) => {
        const credentials = response.Credentials;
        const expiresAt = credentials?.Expiration?.getTime();
        if (
          !credentials?.AccessKeyId ||
          !credentials.SecretAccessKey ||
          !credentials.SessionToken ||
          expiresAt === undefined ||
          !Number.isFinite(expiresAt)
        ) {
          return Effect.fail(new AwsRoleAssumptionError({ reason: "invalid_response" }));
        }
        return Effect.succeed({
          accessKeyId: credentials.AccessKeyId,
          secretAccessKey: credentials.SecretAccessKey,
          sessionToken: credentials.SessionToken,
          expiresAt,
        });
      }),
    );
};
