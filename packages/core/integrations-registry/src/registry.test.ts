import { describe, expect, it } from "@effect/vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";

import {
  IntegrationsRegistry,
  buildUserAgent,
  decodeIntegrationsCatalog,
  isFetchDisabled,
  layer as integrationsRegistryLayer,
} from "./registry";

const TEST_USER_AGENT = "executor/dev/test/cli";

// Records every outgoing request so tests can assert on URL + headers.
const makeRecordingHttpClient = (
  body: () => string = () => `{}`,
): Effect.Effect<{
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: Ref.Ref<ReadonlyArray<{ url: string; userAgent: string }>>;
}> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ url: string; userAgent: string }>>([]);
    const layer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (xs) => [
            ...xs,
            { url: request.url, userAgent: request.headers["user-agent"] ?? "" },
          ]);
          return HttpClientResponse.fromWeb(
            request,
            new Response(body(), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    return { layer, requests };
  });

describe("buildUserAgent", () => {
  it("formats executor/<channel>/<version>/<client>", () => {
    expect(buildUserAgent({ channel: "stable", version: "1.2.3", client: "cli" })).toBe(
      "executor/stable/1.2.3/cli",
    );
    expect(buildUserAgent({ channel: "beta", version: "1.2.3-beta.0", client: "local" })).toBe(
      "executor/beta/1.2.3-beta.0/local",
    );
  });

  it("contains the substring 'executor' so the worker filter matches", () => {
    const ua = buildUserAgent({ channel: "dev", version: "0.0.0", client: "cli" });
    expect(ua.includes("executor")).toBe(true);
  });
});

describe("isFetchDisabled", () => {
  it("honors DO_NOT_TRACK", () => {
    expect(isFetchDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(isFetchDisabled({ DO_NOT_TRACK: "true" })).toBe(true);
    expect(isFetchDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
  });

  it("honors EXECUTOR_DISABLE_INTEGRATIONS_FETCH", () => {
    expect(isFetchDisabled({ EXECUTOR_DISABLE_INTEGRATIONS_FETCH: "1" })).toBe(true);
    expect(isFetchDisabled({ EXECUTOR_DISABLE_INTEGRATIONS_FETCH: "yes" })).toBe(true);
  });

  it("defaults to enabled when neither env var is set", () => {
    expect(isFetchDisabled({})).toBe(false);
  });
});

const withTempCache = <A, E, R>(
  body: (cacheDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "integrations-registry-test-"))),
    body,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

describe("IntegrationsRegistry", () => {
  it("admits typed catalog metadata without exposing provider auth instructions", () => {
    const catalog = decodeIntegrationsCatalog({
      version: 1,
      generatedAt: "2026-08-31T00:07:11.718Z",
      data: [
        {
          id: "curated/posthog-com-mcp",
          kind: "mcp",
          slug: "posthog-com",
          name: "PostHog",
          description: "Product analytics",
          icon: "https://example.test/posthog.png",
          domain: "posthog.com",
          categories: ["analytics", "developer-tools"],
          feeds: ["curated"],
          connectUrl: "https://mcp.posthog.com/mcp",
          auth: {
            kind: "api_key",
            header: "Authorization: Bearer {secret}",
          },
        },
      ],
    });

    expect(catalog).toEqual({
      version: 1,
      generatedAt: "2026-08-31T00:07:11.718Z",
      integrations: [
        {
          id: "curated/posthog-com-mcp",
          kind: "mcp",
          slug: "posthog-com",
          name: "PostHog",
          description: "Product analytics",
          icon: "https://example.test/posthog.png",
          domain: "posthog.com",
          categories: ["analytics", "developer-tools"],
          feeds: ["curated"],
          connectUrl: "https://mcp.posthog.com/mcp",
          authKind: "api_key",
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("Authorization");
    expect(JSON.stringify(catalog)).not.toContain("{secret}");
  });

  it("rejects a malformed registry payload instead of returning an untyped escape hatch", () => {
    expect(
      decodeIntegrationsCatalog({
        version: 1,
        generatedAt: "2026-08-31T00:07:11.718Z",
        data: [{ id: "missing-required-fields" }],
      }),
    ).toBeUndefined();
  });

  it("admits catalog rows whose optional presentation metadata is absent or null", () => {
    expect(
      decodeIntegrationsCatalog({
        version: 1,
        generatedAt: "2026-08-31T00:07:11.718Z",
        data: [
          {
            id: "community/no-icon",
            kind: "openapi",
            slug: "no-icon",
            name: "No Icon",
            description: "Valid catalog row",
            domain: "example.test",
            categories: [],
            feeds: ["community"],
            url: null,
            popularity: null,
          },
        ],
      }),
    ).toMatchObject({
      integrations: [
        {
          id: "community/no-icon",
          name: "No Icon",
        },
      ],
    });
  });

  it.effect("disabled flag short-circuits — no network, empty registry", () =>
    withTempCache((cacheDir) =>
      Effect.gen(function* () {
        const { layer: httpLayer, requests } = yield* makeRecordingHttpClient();

        const program = Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          return yield* registry.search();
        });

        const result = yield* program.pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              disabled: true,
              cacheDir,
            }).pipe(Layer.provide(httpLayer), Layer.provide(NodeFileSystem.layer)),
          ),
        );

        expect(result).toEqual([]);
        const sent = yield* Ref.get(requests);
        expect(sent).toHaveLength(0);
      }),
    ),
  );

  it.effect("happy path — fetches, parses, sends User-Agent header", () =>
    withTempCache((cacheDir) =>
      Effect.gen(function* () {
        const payload = {
          version: 1,
          generatedAt: "2026-08-31T00:07:11.718Z",
          data: [
            {
              id: "curated/github-com-graphql",
              kind: "graphql",
              slug: "github-com",
              name: "GitHub",
              description: "GitHub GraphQL API",
              icon: "https://example.test/github.png",
              domain: "github.com",
              categories: ["developer-tools"],
              feeds: ["curated"],
              connectUrl: "https://api.github.com/graphql",
              auth: { kind: "oauth", authorizationUrl: "https://github.com/login/oauth" },
            },
            {
              id: "curated/gitlab-com-graphql",
              kind: "graphql",
              slug: "gitlab-com",
              name: "GitLab",
              description: "GitLab GraphQL API",
              icon: "https://example.test/gitlab.png",
              domain: "gitlab.com",
              categories: ["developer-tools"],
              feeds: ["curated"],
              connectUrl: "https://gitlab.com/api/graphql",
              auth: { kind: "oauth" },
            },
          ],
        };
        const { layer: httpLayer, requests } = yield* makeRecordingHttpClient(() =>
          JSON.stringify(payload),
        );

        const program = Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          const exact = yield* registry.get("curated/github-com-graphql");
          const matches = yield* registry.search({ query: "github developer", limit: 1 });
          return { exact, matches };
        });

        const result = yield* program.pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              cacheDir,
              url: "https://integrations.test/api.json",
            }).pipe(Layer.provide(httpLayer), Layer.provide(NodeFileSystem.layer)),
          ),
        );

        expect(result.exact).toMatchObject({
          id: "curated/github-com-graphql",
          kind: "graphql",
          name: "GitHub",
          authKind: "oauth",
        });
        expect(result.matches.map((item) => item.id)).toEqual(["curated/github-com-graphql"]);
        const sent = yield* Ref.get(requests);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe("https://integrations.test/api.json");
        expect(sent[0]?.userAgent).toBe(TEST_USER_AGENT);
      }),
    ),
  );

  it.effect("cache hit — second get returns cached value without re-fetching", () =>
    withTempCache((cacheDir) =>
      Effect.gen(function* () {
        const { layer: httpLayer, requests } = yield* makeRecordingHttpClient(() =>
          JSON.stringify({ version: 1, generatedAt: "2026-08-31T00:07:11.718Z", data: [] }),
        );

        const program = Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          const first = yield* registry.search({ query: "anything" });
          const second = yield* registry.search({ query: "anything" });
          return { first, second };
        });

        const { first, second } = yield* program.pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              cacheDir,
              url: "https://integrations.test/api.json",
            }).pipe(Layer.provide(httpLayer), Layer.provide(NodeFileSystem.layer)),
          ),
        );

        expect(first).toEqual([]);
        expect(second).toEqual([]);
        const sent = yield* Ref.get(requests);
        // Either 0 (disk hit) or 1 (network), but never 2 — the second
        // `get()` is served by the in-memory cached effect.
        expect(sent.length).toBeLessThanOrEqual(1);
      }),
    ),
  );

  it.effect("does not admit or persist a malformed provider response", () =>
    withTempCache((cacheDir) =>
      Effect.gen(function* () {
        const malformedClient = yield* makeRecordingHttpClient(() =>
          JSON.stringify({ version: 1, generatedAt: "now", data: [{ id: "partial" }] }),
        );
        const first = yield* Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          return yield* registry.search();
        }).pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              cacheDir,
              recurring: false,
            }).pipe(Layer.provide(malformedClient.layer), Layer.provide(NodeFileSystem.layer)),
          ),
        );
        expect(first).toEqual([]);
        const malformedWasPersisted = yield* Effect.promise(() =>
          access(join(cacheDir, "integrations.json")).then(
            () => true,
            () => false,
          ),
        );
        expect(malformedWasPersisted).toBe(false);

        const validClient = yield* makeRecordingHttpClient(() =>
          JSON.stringify({
            version: 1,
            generatedAt: "2026-08-31T00:07:11.718Z",
            data: [
              {
                id: "curated/github",
                kind: "graphql",
                slug: "github",
                name: "GitHub",
                description: "GitHub API",
                icon: "https://example.test/github.png",
                domain: "github.com",
                categories: ["developer-tools"],
                feeds: ["curated"],
              },
            ],
          }),
        );
        const second = yield* Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          return yield* registry.get("curated/github");
        }).pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              cacheDir,
              recurring: false,
            }).pipe(Layer.provide(validClient.layer), Layer.provide(NodeFileSystem.layer)),
          ),
        );
        expect(second?.name).toBe("GitHub");
        expect(yield* Ref.get(validClient.requests)).toHaveLength(1);
      }),
    ),
  );
});
