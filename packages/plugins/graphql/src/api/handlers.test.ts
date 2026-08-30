// ---------------------------------------------------------------------------
// Handler-level integration test for the GraphQL group's config surface.
//
// Verifies the `getConfig` / `configure` (custom-method merge-append) HTTP
// endpoints round-trip end-to-end through the HttpApi layer: the handlers pull
// the wrapped extension from the service, the wire schemas decode/encode the
// `authenticationTemplate`, the merge dedupes by slug, and an unknown slug is a
// no-op. A backing in-memory map stands in for the extension's persistence so
// the test exercises the HTTP edge + handler wiring (not a live server).
// ---------------------------------------------------------------------------

import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import {
  AuthContext,
  CoreHandlers,
  ExecutionEngineService,
  ExecutorService,
} from "@executor-js/api/server";

import { expandGraphqlAuthMethodInputs } from "../sdk/types";
import { GraphqlManagedOAuthProfileNotConfiguredError } from "../sdk/errors";
import type { GraphqlPluginExtension } from "../sdk/plugin";
import type {
  GraphqlAuthMethod,
  GraphqlAuthMethodInput,
  GraphqlIntegrationConfig,
} from "../sdk/types";
import { GraphqlExtensionService, GraphqlHandlers } from "./handlers";
import { GraphqlGroup } from "./group";

const unused = Effect.die("unused");

// Minimal in-memory persistence for the config endpoints. Mirrors the real
// extension's merge-append semantics (slug-keyed replace; blank slug → custom_).
const makeStubExtension = (
  store: Map<string, GraphqlIntegrationConfig>,
): GraphqlPluginExtension => {
  let counter = 0;
  const merge = (
    existing: readonly GraphqlAuthMethod[],
    incoming: readonly GraphqlAuthMethodInput[],
  ): readonly GraphqlAuthMethod[] => {
    const result: GraphqlAuthMethod[] = existing.map((entry: GraphqlAuthMethod) => entry);
    const taken = new Set<string>(result.map((entry: GraphqlAuthMethod) => entry.slug));
    for (const entry of incoming) {
      const requested = entry.slug?.trim() ?? "";
      const index = result.findIndex((current: GraphqlAuthMethod) => current.slug === requested);
      if (requested.length > 0 && index >= 0) {
        result[index] = entry as GraphqlAuthMethod;
        continue;
      }
      const slug =
        requested.length > 0 && !taken.has(requested) ? requested : `custom_${counter++}`;
      taken.add(slug);
      result.push({ ...entry, slug } as GraphqlAuthMethod);
    }
    return result;
  };

  const extension: GraphqlPluginExtension = {
    addIntegration: () => unused,
    getIntegration: () => unused,
    removeIntegration: () => unused,
    configure: () => unused,
    ensureManagedOAuthProfile: () => unused,
    getConfig: (slug: string) => Effect.sync(() => store.get(slug) ?? null),
    configureAuth: (
      slug: string,
      input: { readonly authenticationTemplate: readonly GraphqlAuthMethodInput[] },
    ) =>
      Effect.sync((): readonly GraphqlAuthMethod[] => {
        const current = store.get(slug);
        if (!current) return [];
        // Mirror the real configureAuth: dialect inputs expand to canonical
        // placements before the merge (stored configs stay canonical).
        const merged = merge(
          current.authenticationTemplate,
          expandGraphqlAuthMethodInputs(input.authenticationTemplate),
        );
        store.set(slug, { ...current, authenticationTemplate: merged });
        return merged;
      }),
  };
  return extension;
};

const Api = addGroup(GraphqlGroup);
const UnusedExecutor = Layer.succeed(ExecutorService)({} as ExecutorService["Service"]);
const UnusedExecutionEngine = Layer.succeed(ExecutionEngineService)(
  {} as ExecutionEngineService["Service"],
);

const authLayer = (
  organizationId: string,
  roles: readonly string[],
  kind: "user" | "service" = "service",
  accountId = kind === "service" ? "client_manifest" : "user_manifest",
) => {
  const auth = {
    kind,
    accountId,
    organizationId,
    email: "",
    name: "Manifest service",
    avatarUrl: null,
    roles,
  };
  return Layer.succeed(AuthContext)(auth);
};

const webHandlerFor = (
  extension: GraphqlPluginExtension,
  auth = authLayer("org_target", ["service"]),
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(GraphqlHandlers),
          Layer.provide(observabilityMiddleware(Api)),
          Layer.provide(UnusedExecutor),
          Layer.provide(UnusedExecutionEngine),
          Layer.provide(auth),
          Layer.provide(Layer.succeed(GraphqlExtensionService, extension)),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const seededStore = (): Map<string, GraphqlIntegrationConfig> => {
  const store = new Map<string, GraphqlIntegrationConfig>();
  store.set("gql", {
    endpoint: "https://x.example/graphql",
    name: "GraphQL",
    authenticationTemplate: [
      { slug: "seed", kind: "apikey", placements: [{ carrier: "header", name: "X-Seed" }] },
    ],
  });
  return store;
};

const post = (
  web: { handler: (request: Request) => Promise<Response> },
  url: string,
  body: unknown,
) =>
  Effect.promise(() =>
    web.handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

const get = (web: { handler: (request: Request) => Promise<Response> }, url: string) =>
  Effect.promise(() => web.handler(new Request(url, { method: "GET" })));

describe("GraphqlHandlers — config surface", () => {
  it.effect(
    "binds a service-only ensure to the authenticated organization without a secret payload",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const result = {
          profile: "github",
          readiness: "ready" as const,
          integration: { slug: "github", action: "created" as const },
          oauthClient: {
            owner: "org" as const,
            slug: "github-prod",
            clientId: "public-client-id",
            action: "created" as const,
            credentialReferencePresent: true as const,
          },
        };
        const extension = {
          ...makeStubExtension(seededStore()),
          ensureManagedOAuthProfile: (profile: string) =>
            Effect.sync(() => {
              calls.push(profile);
              return result;
            }),
        };
        const serviceWeb = (yield* webHandlerFor(extension)) as {
          handler: (request: Request) => Promise<Response>;
        };

        const serviceResponse = yield* post(
          serviceWeb,
          "http://localhost/graphql/managed-oauth/profiles/github/ensure",
          {},
        );
        expect(serviceResponse.status).toBe(200);
        expect(yield* Effect.promise(() => serviceResponse.json())).toEqual({
          ...result,
          organizationId: "org_target",
        });
        expect(calls).toEqual(["github"]);

        const humanWeb = (yield* webHandlerFor(
          extension,
          authLayer("org_target", ["member"], "user"),
        )) as {
          handler: (request: Request) => Promise<Response>;
        };
        const humanResponse = yield* post(
          humanWeb,
          "http://localhost/graphql/managed-oauth/profiles/github/ensure",
          {},
        );
        expect(humanResponse.status).toBe(403);

        const roleCollisionWeb = (yield* webHandlerFor(
          extension,
          authLayer("org_target", ["service"], "user", "user_role_collision"),
        )) as { handler: (request: Request) => Promise<Response> };
        const roleCollisionResponse = yield* post(
          roleCollisionWeb,
          "http://localhost/graphql/managed-oauth/profiles/github/ensure",
          {},
        );
        expect(roleCollisionResponse.status).toBe(403);

        const organizationApiKeyWeb = (yield* webHandlerFor(
          extension,
          authLayer("org_target", ["service"], "user", "api-key:organization"),
        )) as { handler: (request: Request) => Promise<Response> };
        const organizationApiKeyResponse = yield* post(
          organizationApiKeyWeb,
          "http://localhost/graphql/managed-oauth/profiles/github/ensure",
          {},
        );
        expect(organizationApiKeyResponse.status).toBe(403);
        expect(calls).toEqual(["github"]);

        const attemptedOverride = yield* post(
          serviceWeb,
          "http://localhost/graphql/managed-oauth/profiles/github/ensure",
          { organizationId: "org_other" },
        );
        expect(attemptedOverride.status).toBe(200);
        expect(yield* Effect.promise(() => attemptedOverride.json())).toMatchObject({
          organizationId: "org_target",
        });
        expect(calls).toEqual(["github", "github"]);
      }),
  );

  it.effect("returns a typed 404 for an unconfigured managed OAuth profile", () =>
    Effect.gen(function* () {
      const extension = {
        ...makeStubExtension(seededStore()),
        ensureManagedOAuthProfile: (profile: string) =>
          Effect.fail(
            new GraphqlManagedOAuthProfileNotConfiguredError({
              profile,
              message: "Managed OAuth profile is not configured on this Executor host.",
            }),
          ),
      };
      const web = (yield* webHandlerFor(extension)) as {
        handler: (request: Request) => Promise<Response>;
      };

      const response = yield* post(
        web,
        "http://localhost/graphql/managed-oauth/profiles/missing/ensure",
        {},
      );

      expect(response.status).toBe(404);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "GraphqlManagedOAuthProfileNotConfiguredError",
        profile: "missing",
      });
    }),
  );

  it.effect("configure merge-appends a custom method and getConfig round-trips it", () =>
    Effect.gen(function* () {
      const store = seededStore();
      const web = (yield* webHandlerFor(makeStubExtension(store))) as {
        handler: (request: Request) => Promise<Response>;
      };

      const configureRes = yield* post(web, "http://localhost/graphql/integrations/gql/config", {
        authenticationTemplate: [
          {
            slug: "custom",
            type: "apiKey",
            queryParams: { key: [{ type: "variable", name: "token" }] },
          },
        ],
      });
      expect(configureRes.status).toBe(200);
      const configureBody = (yield* Effect.promise(() => configureRes.json())) as {
        authenticationTemplate: { slug: string; name: string }[];
      };
      expect(configureBody.authenticationTemplate.map((t) => t.slug)).toEqual(["seed", "custom"]);

      const getRes = yield* get(web, "http://localhost/graphql/integrations/gql/config");
      expect(getRes.status).toBe(200);
      const getBody = (yield* Effect.promise(() => getRes.json())) as {
        authenticationTemplate: { slug: string }[];
      };
      expect(getBody.authenticationTemplate.map((t) => t.slug)).toEqual(["seed", "custom"]);
    }),
  );

  it.effect("configure dedupes by slug — a matching slug replaces in place", () =>
    Effect.gen(function* () {
      const store = seededStore();
      const web = (yield* webHandlerFor(makeStubExtension(store))) as {
        handler: (request: Request) => Promise<Response>;
      };

      const res = yield* post(web, "http://localhost/graphql/integrations/gql/config", {
        authenticationTemplate: [
          {
            slug: "seed",
            type: "apiKey",
            headers: { "X-New": [{ type: "variable", name: "token" }] },
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (yield* Effect.promise(() => res.json())) as {
        authenticationTemplate: {
          slug: string;
          placements: { name: string }[];
        }[];
      };
      expect(body.authenticationTemplate).toHaveLength(1);
      expect(body.authenticationTemplate[0]!.slug).toBe("seed");
      expect(body.authenticationTemplate[0]!.placements[0]!.name).toBe("X-New");
    }),
  );

  it.effect("configure is a no-op for an unknown slug", () =>
    Effect.gen(function* () {
      const store = seededStore();
      const web = (yield* webHandlerFor(makeStubExtension(store))) as {
        handler: (request: Request) => Promise<Response>;
      };

      const res = yield* post(web, "http://localhost/graphql/integrations/nope/config", {
        authenticationTemplate: [
          {
            slug: "custom",
            type: "apiKey",
            queryParams: { key: [{ type: "variable", name: "token" }] },
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (yield* Effect.promise(() => res.json())) as {
        authenticationTemplate: unknown[];
      };
      expect(body.authenticationTemplate).toEqual([]);
    }),
  );

  it.effect("getConfig returns null for an unknown slug", () =>
    Effect.gen(function* () {
      const store = seededStore();
      const web = (yield* webHandlerFor(makeStubExtension(store))) as {
        handler: (request: Request) => Promise<Response>;
      };

      const res = yield* get(web, "http://localhost/graphql/integrations/nope/config");
      expect(res.status).toBe(200);
      const body = yield* Effect.promise(() => res.json());
      expect(body).toBeNull();
    }),
  );
});
