import { expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  AuthTemplateSlug,
  ConnectionName,
  createExecutor,
  IntegrationSlug,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { openApiPlugin, parse } from "@executor-js/plugin-openapi";
import type { AuthenticationInput } from "@executor-js/plugin-openapi";

import { deriveGoogleDiscoveryIdentity, googleDiscoveryAdapter } from "./spec-format-adapter";
import { googleCatalog } from "./presets";

const TASKS_URL = "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest";
const GOOGLE_WORKSPACE_URLS: readonly [string, string, string, string, string] = [
  "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
  "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  "https://www.googleapis.com/discovery/v1/apis/docs/v1/rest",
  "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
  "https://www.googleapis.com/discovery/v1/apis/slides/v1/rest",
];
const GOOGLE_WORKSPACE_SCOPES: Readonly<Record<string, string>> = {
  gmail: "https://mail.google.com/",
  drive: "https://www.googleapis.com/auth/drive",
  docs: "https://www.googleapis.com/auth/documents",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
  slides: "https://www.googleapis.com/auth/presentations",
};
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const googleWorkspaceDiscoveryDocument = (service: string, version: string, scope: string) => ({
  name: service,
  version,
  title: `Google ${service}`,
  description: `Use Google ${service} in one Workspace grant.`,
  rootUrl: "https://www.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        [scope]: { description: `Use Google ${service}.` },
      },
    },
  },
  methods: {
    resourcesList: {
      id: `${service}.resources.list`,
      httpMethod: "GET",
      path: `${service}/${version}/resources`,
      scopes: [scope],
      response: { $ref: "Result" },
    },
  },
  schemas: {
    Result: {
      type: "object",
      properties: { id: { type: "string" } },
    },
  },
});

const googleWorkspaceDocuments = new Map(
  GOOGLE_WORKSPACE_URLS.map((url) => {
    const segments = new URL(url).pathname.split("/");
    const service = segments.at(-3) ?? "unknown";
    const version = segments.at(-2) ?? "v1";
    return [
      url,
      googleWorkspaceDiscoveryDocument(
        service,
        version,
        GOOGLE_WORKSPACE_SCOPES[service] ?? "openid",
      ),
    ];
  }),
);

const googleWorkspaceHttpClientLayer = (state: {
  readonly requests: string[];
  readonly unavailable: Set<string>;
}) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      state.requests.push(request.url);
      const document = googleWorkspaceDocuments.get(request.url);
      const available = document !== undefined && !state.unavailable.has(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(available ? encodeJson(document) : "not found", {
            status: available ? 200 : 404,
            headers: { "content-type": available ? "application/json" : "text/plain" },
          }),
        ),
      );
    }),
  );

const tasksDiscoveryDoc = {
  name: "tasks",
  version: "v1",
  title: "Google Tasks API",
  description: "Manage your tasks and task lists.",
  rootUrl: "https://tasks.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/tasks": {
          description: "Create, edit, organize, and delete all your tasks.",
        },
      },
    },
  },
  methods: {
    tasklistsList: {
      id: "tasks.tasklists.list",
      httpMethod: "GET",
      path: "tasks/v1/users/@me/lists",
      scopes: ["https://www.googleapis.com/auth/tasks"],
      response: { $ref: "TaskLists" },
    },
  },
  schemas: {
    TaskLists: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { $ref: "TaskList" },
        },
      },
    },
    TaskList: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
      },
    },
  },
};

const discoveryHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(encodeJson(tasksDiscoveryDoc), {
          status: request.url === TASKS_URL ? 200 : 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  ),
);

it.effect("fetches and converts a Google Discovery document", () =>
  Effect.gen(function* () {
    const converted = yield* googleDiscoveryAdapter.fetch({
      urls: [TASKS_URL],
      httpClientLayer: discoveryHttpClientLayer,
    });
    const parsed = yield* parse(converted.specText);

    expect(parsed.info.title).toBe("Google");
    expect(Object.keys(parsed.paths ?? {})).toContain("/tasks/v1/users/@me/lists");
    expect(converted.authenticationTemplate?.[0]?.kind).toBe("oauth2");
  }),
);

it("derives Google Discovery identity from the raw document", () => {
  expect(deriveGoogleDiscoveryIdentity(tasksDiscoveryDoc)).toEqual({
    slug: "google_tasks",
    name: "Google Tasks API",
    description: "Manage your tasks and task lists.",
  });
});

it.effect("adds a Google Discovery URL through the OpenAPI plugin with derived identity", () =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({
            httpClientLayer: discoveryHttpClientLayer,
            specFormats: [googleDiscoveryAdapter],
          }),
          memoryCredentialsPlugin(),
        ],
      }),
    );

    const added = yield* executor.openapi.addSpec({
      spec: { kind: "url", url: TASKS_URL },
      specFormat: "google-discovery",
    });
    const integration = yield* executor.openapi.getIntegration("google_tasks");

    expect(String(added.slug)).toBe("google_tasks");
    expect(integration?.slug).toEqual(IntegrationSlug.make("google_tasks"));
    expect(added.toolCount).toBe(1);
  }),
);

it.effect(
  "adds a Google catalog preset through OpenAPI with family, format, and default slug",
  () =>
    Effect.gen(function* () {
      const tasksPreset = googleCatalog.find((preset) => preset.defaultSlug === "google_tasks")!;
      const authTemplate: readonly AuthenticationInput[] = (tasksPreset.authTemplate ?? []).flatMap(
        (template) => (template.kind === "oauth2" ? [template] : []),
      );
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({
              httpClientLayer: discoveryHttpClientLayer,
              presets: [tasksPreset],
              specFormats: [googleDiscoveryAdapter],
            }),
            memoryCredentialsPlugin(),
          ],
        }),
      );

      const added = yield* executor.openapi.addSpec({
        spec: { kind: "url", url: tasksPreset.url! },
        slug: tasksPreset.defaultSlug,
        specFormat: tasksPreset.specFormat,
        family: tasksPreset.family,
        authenticationTemplate: authTemplate,
      });
      const config = yield* executor.openapi.getConfig("google_tasks");

      expect(String(added.slug)).toBe("google_tasks");
      expect(config?.family).toBe("google");
      expect(config?.specFormat).toBe("google-discovery");
      expect(config?.authenticationTemplate?.[0]?.kind).toBe("oauth2");
      const storedOAuthTemplates = (config?.authenticationTemplate ?? []).filter(
        (template) => template.kind === "oauth2",
      );
      expect(storedOAuthTemplates[0]?.scopes).toEqual(
        expect.arrayContaining([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/tasks",
        ]),
      );
    }),
);

it.effect("persists and atomically refreshes one five-service Google Workspace bundle", () =>
  Effect.gen(function* () {
    const state: { readonly requests: string[]; readonly unavailable: Set<string> } = {
      requests: [],
      unavailable: new Set<string>(),
    };
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({
            httpClientLayer: googleWorkspaceHttpClientLayer(state),
            specFormats: [googleDiscoveryAdapter],
          }),
          memoryCredentialsPlugin(),
        ],
      }),
    );

    const added = yield* executor.openapi.addSpec({
      spec: { kind: "urls", urls: GOOGLE_WORKSPACE_URLS },
      slug: "google",
      name: "Google Workspace",
      specFormat: "google-discovery",
      family: "google",
    });
    expect(added.toolCount).toBe(5);

    const config = yield* executor.openapi.getConfig("google");
    expect(config?.specUrl).toBeUndefined();
    expect(config?.specUrls).toEqual(GOOGLE_WORKSPACE_URLS);
    expect(config?.family).toBe("google");
    expect(config?.specFormat).toBe("google-discovery");
    const oauthTemplate = config?.authenticationTemplate?.find(
      (template) => template.kind === "oauth2",
    );
    expect(oauthTemplate?.scopes).toEqual(
      expect.arrayContaining(Object.values(GOOGLE_WORKSPACE_SCOPES)),
    );
    expect(
      oauthTemplate?.scopes.some(
        (scope) => scope.includes("/auth/admin.") || scope.includes("cloud-platform"),
      ),
    ).toBe(false);

    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("workspace"),
      integration: IntegrationSlug.make("google"),
      template: AuthTemplateSlug.make("googleOAuth2"),
      value: "test-access-token",
    });
    const toolNames = (yield* executor.tools.list())
      .filter((tool) => String(tool.address).startsWith("tools.google.org.workspace."))
      .map((tool) => String(tool.name));
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "gmail.resources.list",
        "drive.resources.list",
        "docs.resources.list",
        "sheets.resources.list",
        "slides.resources.list",
      ]),
    );

    state.requests.length = 0;
    const refreshed = yield* executor.openapi.updateSpec("google");
    expect(refreshed.toolCount).toBe(5);
    expect(refreshed.addedTools).toEqual([]);
    expect(refreshed.removedTools).toEqual([]);
    expect(new Set(state.requests)).toEqual(new Set(GOOGLE_WORKSPACE_URLS));

    const beforeFailedRefresh = yield* executor.openapi.getConfig("google");
    state.unavailable.add(GOOGLE_WORKSPACE_URLS[4]);
    const failure = yield* executor.openapi.updateSpec("google").pipe(Effect.flip);
    expect(Predicate.isTagged(failure, "OpenApiParseError")).toBe(true);
    const afterFailedRefresh = yield* executor.openapi.getConfig("google");
    expect(afterFailedRefresh?.specHash).toBe(beforeFailedRefresh?.specHash);
    expect(afterFailedRefresh?.specUrls).toEqual(GOOGLE_WORKSPACE_URLS);
  }),
);
