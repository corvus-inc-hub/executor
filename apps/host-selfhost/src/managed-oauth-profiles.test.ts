import { describe, expect, it } from "@effect/vitest";

import { managedGraphqlOAuthProfilesFromEnv } from "./managed-oauth-profiles";

describe("managedGraphqlOAuthProfilesFromEnv", () => {
  it("keeps managed GitHub OAuth disabled when no host credential is configured", () => {
    expect(managedGraphqlOAuthProfilesFromEnv({})).toEqual([]);
  });

  it("builds the canonical GitHub GraphQL profile from a complete host credential", () => {
    const profiles = managedGraphqlOAuthProfilesFromEnv({
      EXECUTOR_MANAGED_GITHUB_OAUTH_CLIENT_ID: " github-client-id ",
      EXECUTOR_MANAGED_GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
    });

    expect(profiles).toEqual([
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
          clientId: "github-client-id",
          clientSecret: "github-client-secret",
        },
      },
    ]);
  });

  it.each([
    { EXECUTOR_MANAGED_GITHUB_OAUTH_CLIENT_ID: "client-only" },
    { EXECUTOR_MANAGED_GITHUB_OAUTH_CLIENT_SECRET: "secret-only" },
  ])("fails host startup for a partial managed GitHub credential", (environment) => {
    expect(() => managedGraphqlOAuthProfilesFromEnv(environment)).toThrow(
      "Managed GitHub OAuth requires both",
    );
  });
});
