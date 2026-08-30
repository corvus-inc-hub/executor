import type { GraphqlManagedOAuthProfile } from "@executor-js/plugin-graphql";

const CLIENT_ID_ENV = "EXECUTOR_MANAGED_GITHUB_OAUTH_CLIENT_ID";
const CLIENT_SECRET_ENV = "EXECUTOR_MANAGED_GITHUB_OAUTH_CLIENT_SECRET";

export const managedGraphqlOAuthProfilesFromEnv = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly GraphqlManagedOAuthProfile[] => {
  const clientId = environment[CLIENT_ID_ENV]?.trim() ?? "";
  const clientSecret = environment[CLIENT_SECRET_ENV]?.trim() ?? "";
  if (!clientId && !clientSecret) return [];
  if (!clientId || !clientSecret) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: partial host authority must fail at startup
    throw new Error(
      `Managed GitHub OAuth requires both ${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV}.`,
    );
  }

  return [
    {
      id: "github",
      integration: {
        slug: "github",
        endpoint: "https://api.github.com/graphql",
        name: "GitHub",
        description: "Repositories, pull requests, reviews, and delivery evidence.",
        authenticationTemplate: [{ kind: "oauth2", slug: "oauth", scopes: ["repo", "read:org"] }],
      },
      client: {
        slug: "github-prod",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        clientId,
        clientSecret,
      },
    },
  ];
};
