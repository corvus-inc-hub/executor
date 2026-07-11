import { Effect } from "effect";

import {
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  StorageError,
  definePlugin,
  type Connection,
  type IntegrationRecord,
  type PluginCtx,
  type ResolveToolsInput,
} from "@executor-js/sdk";

export const AWS_ROLE_INTEGRATION_SLUG = IntegrationSlug.make("amazonaws.com");
export const AWS_ROLE_TEMPLATE = "aws-role";
export const ENCRYPTED_PROVIDER = "encrypted";

const AWS_ROLE_CONFIG = {
  type: "aws-role",
  version: 1,
  fields: [
    {
      name: "AWS_ROLE_ARN",
      required: true,
      description: "ARN of the IAM role that Executor assumes with AWS STS.",
    },
    {
      name: "AWS_REGION",
      required: true,
      description: "AWS region used by the STS client.",
    },
    {
      name: "AWS_EXTERNAL_ID",
      required: false,
      description: "Optional external ID required by the role trust policy.",
    },
  ],
  prohibitedFields: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
} as const;

const description =
  "AWS role configuration for short-lived STS credential leases. Static AWS access keys are not accepted.";
const AWS_ROLE_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/;
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/;
const AWS_EXTERNAL_ID = /^[A-Za-z0-9_+=,.@:/-]{2,1224}$/;
const AWS_ROLE_FIELDS = new Set(["AWS_ROLE_ARN", "AWS_REGION", "AWS_EXTERNAL_ID"]);

const isCurrentConfig = (record: IntegrationRecord): boolean => {
  const config = record.config as Partial<typeof AWS_ROLE_CONFIG> | null;
  return (
    record.kind === "awsRole" &&
    record.name === "Amazon Web Services" &&
    record.description === description &&
    config?.type === AWS_ROLE_CONFIG.type &&
    config.version === AWS_ROLE_CONFIG.version
  );
};

const registerAwsRoleIntegration = (ctx: PluginCtx<unknown>) =>
  Effect.gen(function* () {
    const existing = yield* ctx.core.integrations.get(AWS_ROLE_INTEGRATION_SLUG);
    if (existing && existing.kind !== "awsRole") {
      return yield* new StorageError({
        message: "amazonaws.com is already owned by another integration plugin",
        cause: undefined,
      });
    }
    if (existing && isCurrentConfig(existing)) return;
    yield* ctx.core.integrations.register({
      slug: AWS_ROLE_INTEGRATION_SLUG,
      name: "Amazon Web Services",
      description,
      config: AWS_ROLE_CONFIG,
      canRemove: false,
      canRefresh: false,
    });
  });

const encryptedItemId = (connection: Connection, variable: string): ProviderItemId =>
  ProviderItemId.make(
    `connection:${connection.owner}:${connection.integration}:${connection.name}:${variable}`,
  );

const rejectConnection = (
  input: ResolveToolsInput<unknown>,
  ctx: PluginCtx<unknown>,
  connection: Connection | null,
  variables: readonly string[],
) =>
  Effect.gen(function* () {
    if (connection && String(connection.provider) === ENCRYPTED_PROVIDER) {
      for (const variable of variables) {
        yield* ctx.providers.remove(
          ProviderKey.make(ENCRYPTED_PROVIDER),
          encryptedItemId(connection, variable),
        );
      }
    }
    if (connection) {
      yield* ctx.connections
        .remove(input.connection)
        .pipe(Effect.catchTag("ConnectionNotFoundError", () => Effect.void));
    }
    return yield* new StorageError({
      message:
        "AWS role connections must be org-owned, encrypted, and contain only AWS_ROLE_ARN, AWS_REGION, and optional AWS_EXTERNAL_ID",
      cause: undefined,
    });
  });

const resolveAwsRoleTools = (input: ResolveToolsInput<unknown>) =>
  Effect.gen(function* () {
    const ctx = input.ctx;
    if (!ctx) {
      return yield* new StorageError({
        message: "AWS role integration requires a plugin context",
        cause: undefined,
      });
    }
    const connection = yield* ctx.connections.get(input.connection);
    const values = yield* input.getValues();
    const variables = Object.keys(values);
    const roleArn = values.AWS_ROLE_ARN;
    const region = values.AWS_REGION;
    const externalId = values.AWS_EXTERNAL_ID;
    const valid =
      connection !== null &&
      isEncryptedOrgAwsRoleConnection(connection) &&
      variables.length >= 2 &&
      variables.length <= 3 &&
      variables.every((name) => AWS_ROLE_FIELDS.has(name)) &&
      typeof roleArn === "string" &&
      AWS_ROLE_ARN.test(roleArn) &&
      typeof region === "string" &&
      AWS_REGION.test(region) &&
      (externalId === undefined ||
        (typeof externalId === "string" && AWS_EXTERNAL_ID.test(externalId)));
    if (!valid) return yield* rejectConnection(input, ctx, connection, variables);
    return { tools: [] };
  });

const describeAwsRoleAuth = (integration: IntegrationRecord) => {
  const config = integration.config as Partial<typeof AWS_ROLE_CONFIG> | null;
  if (config?.type !== AWS_ROLE_CONFIG.type || config.version !== AWS_ROLE_CONFIG.version)
    return [];
  return [
    {
      id: AWS_ROLE_TEMPLATE,
      label: "AWS role (AWS_ROLE_ARN, AWS_REGION; AWS_EXTERNAL_ID optional)",
      kind: "apikey" as const,
      template: AWS_ROLE_TEMPLATE,
      // The generic descriptor API has no optional-field marker. Declare the
      // required values here; the config above records AWS_EXTERNAL_ID as optional.
      placements: [
        {
          carrier: "env" as const,
          name: "AWS_ROLE_ARN",
          prefix: "",
          variable: "AWS_ROLE_ARN",
        },
        {
          carrier: "env" as const,
          name: "AWS_REGION",
          prefix: "",
          variable: "AWS_REGION",
        },
      ],
    },
  ];
};

export const awsRoleIntegrationPlugin = definePlugin(() => ({
  id: "awsRole" as const,
  storage: () => ({}),
  // Plugin construction is the scoped executor's boot lifecycle. This hook
  // has a typed storage-failure channel and returning null claims no policy role.
  toolPolicyProvider: (ctx: PluginCtx<unknown>) =>
    registerAwsRoleIntegration(ctx).pipe(Effect.as(null)),
  resolveTools: resolveAwsRoleTools,
  describeAuthMethods: describeAwsRoleAuth,
  describeIntegrationDisplay: () => ({ url: "https://amazonaws.com", family: "AWS" }),
}))();

export const isEncryptedOrgAwsRoleConnection = (connection: Connection): boolean =>
  connection.owner === "org" &&
  String(connection.integration) === String(AWS_ROLE_INTEGRATION_SLUG) &&
  String(connection.provider) === ENCRYPTED_PROVIDER;
