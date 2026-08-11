import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { googleDiscoveryAdapter } from "@executor-js/plugin-openapi/providers/google";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([
  openApiHttpPlugin({ specFormats: [googleDiscoveryAdapter] }),
] as const);

const SERVICES = [
  {
    name: "gmail",
    url: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
    scope: "https://mail.google.com/",
  },
  {
    name: "drive",
    url: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    scope: "https://www.googleapis.com/auth/drive",
  },
  {
    name: "docs",
    url: "https://www.googleapis.com/discovery/v1/apis/docs/v1/rest",
    scope: "https://www.googleapis.com/auth/documents",
  },
  {
    name: "sheets",
    url: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
    scope: "https://www.googleapis.com/auth/spreadsheets",
  },
  {
    name: "slides",
    url: "https://www.googleapis.com/discovery/v1/apis/slides/v1/rest",
    scope: "https://www.googleapis.com/auth/presentations",
  },
] as const;

const GOOGLE_WORKSPACE_URLS: readonly [string, string, string, string, string] = [
  SERVICES[0].url,
  SERVICES[1].url,
  SERVICES[2].url,
  SERVICES[3].url,
  SERVICES[4].url,
];

scenario(
  "Google Workspace · one personal grant serves Gmail, Drive, Docs, Sheets, and Slides",
  { timeout: 300_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const integration = IntegrationSlug.make(
        `google_workspace_${randomBytes(4).toString("hex")}`,
      );
      const connection = ConnectionName.make("personal");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const added = yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "urls", urls: GOOGLE_WORKSPACE_URLS },
              slug: integration,
              name: "Google Workspace",
              family: "google",
              specFormat: "google-discovery",
            },
          });
          expect(
            added.toolCount,
            "the bundle exposes operations across five services",
          ).toBeGreaterThan(100);

          const config = yield* client.openapi.getConfig({ params: { slug: integration } });
          expect(config?.specUrl, "the bundle is not collapsed to one source").toBeUndefined();
          expect(config?.specUrls, "all five source URLs persist in order").toEqual(
            GOOGLE_WORKSPACE_URLS,
          );
          const oauth = config?.authenticationTemplate?.find(
            (template) => template.kind === "oauth2",
          );
          expect(oauth?.scopes, "one OAuth template spans all five services").toEqual(
            expect.arrayContaining(SERVICES.map((service) => service.scope)),
          );

          yield* client.connections.create({
            payload: {
              owner: "user",
              name: connection,
              integration,
              template: AuthTemplateSlug.make("googleOAuth2"),
              value: "test-access-token",
            },
          });
          const toolNames = () =>
            Effect.map(client.tools.list({ query: { integration, connection } }), (tools) =>
              tools.map((tool) => tool.name).sort(),
            );
          const beforeRefresh = yield* toolNames();
          for (const service of SERVICES) {
            expect(
              beforeRefresh.some((name) => name.startsWith(`${service.name}.`)),
              `${service.name} tools are available through the same connection`,
            ).toBe(true);
          }

          const refreshed = yield* client.openapi.updateSpec({
            params: { slug: integration },
            payload: {},
          });
          expect(refreshed.toolCount).toBe(added.toolCount);
          expect(yield* toolNames(), "refresh preserves the five-service catalog").toEqual(
            beforeRefresh,
          );

          const failure = yield* client.openapi
            .updateSpec({
              params: { slug: integration },
              payload: {
                spec: {
                  kind: "urls",
                  urls: [
                    GOOGLE_WORKSPACE_URLS[0],
                    GOOGLE_WORKSPACE_URLS[1],
                    GOOGLE_WORKSPACE_URLS[2],
                    GOOGLE_WORKSPACE_URLS[3],
                    "https://example.com/not-a-google-discovery-document",
                  ],
                },
              },
            })
            .pipe(Effect.flip);
          expect(
            Predicate.isTagged(failure, "OpenApiParseError"),
            "an invalid bundle never replaces the live catalog",
          ).toBe(true);
          expect(yield* toolNames(), "the prior five-service catalog stays live").toEqual(
            beforeRefresh,
          );
          const afterFailure = yield* client.openapi.getConfig({
            params: { slug: integration },
          });
          expect(afterFailure?.specUrls, "the stored source bundle remains intact").toEqual(
            GOOGLE_WORKSPACE_URLS,
          );
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: { owner: "user", integration, name: connection },
            })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
