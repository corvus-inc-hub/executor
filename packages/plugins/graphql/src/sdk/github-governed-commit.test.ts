import { createHash } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import type { GraphqlStore } from "./store";
import { graphqlPlugin } from "./plugin";
import {
  GITHUB_GOVERNED_COMMIT_TOOL,
  pushCommitArtifact,
  sha256Canonical,
  type PushCommitArtifactInput,
} from "./github-governed-commit";

const BASE_COMMIT = "1111111111111111111111111111111111111111";
const BASE_TREE = "2222222222222222222222222222222222222222";
const HEAD_TREE = "3333333333333333333333333333333333333333";
const HEAD_COMMIT = "4444444444444444444444444444444444444444";
const IDEMPOTENCY_KEY = "a".repeat(64);
const HEAD_BRANCH = `mnfst/${IDEMPOTENCY_KEY.slice(0, 16)}`;
const CONTENT = Buffer.from("hello\n", "utf8");
const CONTENT_BASE64 = CONTENT.toString("base64");
const CONTENT_SHA256 = createHash("sha256").update(CONTENT).digest("hex");
const BLOB_SHA = createHash("sha1")
  .update(`blob ${CONTENT.byteLength}\0`)
  .update(CONTENT)
  .digest("hex");

const makeStore = () => {
  const governed = new Map<string, unknown>();
  const store: GraphqlStore = {
    replaceOperations: () => Effect.void,
    getOperation: () => Effect.succeed(null),
    listOperations: () => Effect.succeed([]),
    removeOperations: () => Effect.void,
    putIntrospection: () => Effect.void,
    getIntrospection: () => Effect.succeed(null),
    getGovernedEffect: (key) => Effect.succeed(governed.get(key) ?? null),
    putGovernedEffect: (key, value) => Effect.sync(() => governed.set(key, value)),
  };
  return store;
};

const makeInput = Effect.fn("test.makeGovernedCommitInput")(function* () {
  const policy = {
    schemaVersion: "mnfst.repository-delivery-policy.v1",
    repository: { owner: "mnfst", name: "app" },
    baseBranch: "main",
    headBranchPrefix: "mnfst/",
    allowForcePush: false,
    requiredChecks: ["test"],
  } satisfies PushCommitArtifactInput["policy"];
  const artifact = {
    schemaVersion: "mnfst.commit-artifact.v1",
    base: { branch: "main", commitSha: BASE_COMMIT, treeSha: BASE_TREE },
    head: {
      branch: HEAD_BRANCH,
      commitSha: HEAD_COMMIT,
      treeSha: HEAD_TREE,
      message: "feat: add greeting",
      author: { name: "Manifest", email: "manifest@example.com", date: "2026-07-19T12:00:00Z" },
      committer: {
        name: "Manifest",
        email: "manifest@example.com",
        date: "2026-07-19T12:00:00Z",
      },
    },
    files: [
      {
        path: "greeting.txt",
        mode: "100644",
        operation: "add",
        blobSha: BLOB_SHA,
        contentBase64: CONTENT_BASE64,
        contentSha256: CONTENT_SHA256,
      },
    ],
  } satisfies PushCommitArtifactInput["artifact"];
  const [policySha256, artifactSha256] = yield* Effect.all([
    sha256Canonical(policy),
    sha256Canonical(artifact),
  ]);
  return {
    schemaVersion: "mnfst.executor.push-commit-artifact.v1",
    idempotencyKey: IDEMPOTENCY_KEY,
    artifactSha256,
    policySha256,
    repository: { owner: "mnfst", name: "app" },
    policy,
    artifact,
    pullRequest: { title: "Add greeting", body: "Exact governed change", draft: false },
  } satisfies PushCommitArtifactInput;
});

const githubLayer = (options?: { readonly foreignBase?: boolean }) => {
  let branchCreated = false;
  let pullCreated = false;
  const requests: string[] = [];
  const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const ref = (branch: string, sha: string) => ({
        ref: `refs/heads/${branch}`,
        url: `https://api.github.com/repos/mnfst/app/git/refs/heads/${branch}`,
        object: {
          sha,
          type: "commit",
          url: `https://api.github.com/repos/mnfst/app/git/commits/${sha}`,
        },
      });
      if (request.method === "GET" && url.pathname === "/repos/mnfst/app") {
        return Effect.succeed(
          json(request, { full_name: "mnfst/app", archived: false, disabled: false }),
        );
      }
      if (request.method === "GET" && url.pathname.endsWith("/git/ref/heads%2Fmain")) {
        return Effect.succeed(
          json(request, ref("main", options?.foreignBase === true ? "9".repeat(40) : BASE_COMMIT)),
        );
      }
      if (request.method === "GET" && url.pathname.endsWith(`/git/commits/${BASE_COMMIT}`)) {
        return Effect.succeed(
          json(request, { sha: BASE_COMMIT, url: "commit", tree: { sha: BASE_TREE } }),
        );
      }
      if (request.method === "GET" && url.pathname.endsWith(`/git/trees/${BASE_TREE}`)) {
        return Effect.succeed(
          json(request, { sha: BASE_TREE, url: "tree", truncated: false, tree: [] }),
        );
      }
      if (request.method === "POST" && url.pathname.endsWith("/git/blobs")) {
        return Effect.succeed(json(request, { sha: BLOB_SHA, url: "blob" }, 201));
      }
      if (request.method === "POST" && url.pathname.endsWith("/git/trees")) {
        return Effect.succeed(json(request, { sha: HEAD_TREE, url: "tree", tree: [] }, 201));
      }
      if (request.method === "POST" && url.pathname.endsWith("/git/commits")) {
        return Effect.succeed(
          json(request, { sha: HEAD_COMMIT, url: "commit", tree: { sha: HEAD_TREE } }, 201),
        );
      }
      if (request.method === "GET" && url.pathname.includes("/git/ref/heads%2Fmnfst%2F")) {
        return Effect.succeed(
          branchCreated
            ? json(request, ref(HEAD_BRANCH, HEAD_COMMIT))
            : json(request, { message: "Not Found" }, 404),
        );
      }
      if (request.method === "POST" && url.pathname.endsWith("/git/refs")) {
        branchCreated = true;
        return Effect.succeed(json(request, ref(HEAD_BRANCH, HEAD_COMMIT), 201));
      }
      const pull = {
        number: 17,
        node_id: "PR_node",
        html_url: "https://github.com/mnfst/app/pull/17",
        title: "Add greeting",
        body: "Exact governed change",
        state: "open",
        draft: false,
        head: { sha: HEAD_COMMIT, ref: HEAD_BRANCH },
        base: { sha: BASE_COMMIT, ref: "main" },
      };
      if (request.method === "GET" && url.pathname.endsWith("/pulls")) {
        return Effect.succeed(json(request, pullCreated ? [pull] : []));
      }
      if (request.method === "POST" && url.pathname.endsWith("/pulls")) {
        pullCreated = true;
        return Effect.succeed(json(request, pull, 201));
      }
      if (request.method === "GET" && url.pathname.endsWith("/check-runs")) {
        return Effect.succeed(
          json(request, {
            check_runs: [
              {
                id: 23,
                name: "test",
                status: "completed",
                conclusion: "success",
                url: "https://api.github.com/check-runs/23",
                details_url: "https://github.com/mnfst/app/actions/runs/23",
                head_sha: HEAD_COMMIT,
              },
            ],
          }),
        );
      }
      if (request.method === "GET" && url.pathname.endsWith(`/commits/${HEAD_COMMIT}/status`)) {
        return Effect.succeed(
          json(request, { state: "success", sha: HEAD_COMMIT, url: "status", statuses: [] }),
        );
      }
      return Effect.succeed(json(request, { message: "Unexpected test request" }, 500));
    }),
  );
  return { layer, requests };
};

describe("GitHub governed commit capability", () => {
  it.effect("is discoverable only through the exact GitHub GraphQL connection", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );
      yield* executor.graphql.addIntegration({
        endpoint: "https://api.github.com/graphql",
        slug: "github",
        introspectionJson: JSON.stringify({
          data: {
            __schema: {
              queryType: { name: "Query" },
              mutationType: null,
              types: [
                {
                  kind: "OBJECT",
                  name: "Query",
                  description: null,
                  fields: [],
                  inputFields: null,
                  enumValues: null,
                },
              ],
            },
          },
        }),
        authenticationTemplate: [{ kind: "oauth2", slug: "oauth2" }],
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("github"),
        template: AuthTemplateSlug.make("oauth2"),
        value: "host-held-token",
      });
      const schema = yield* executor.tools.schema(
        ToolAddress.make("tools.github.org.main.mutation.pushCommitArtifact"),
      );
      expect(schema).not.toBeNull();
      expect(Reflect.get(schema?.outputSchema ?? {}, "x-executor-capability")).toEqual({
        schemaVersion: "mnfst.executor.push-commit-artifact-capability.v1",
        guarantees: {
          exactCommitSha: true,
          idempotencyKey: true,
          ambiguousReconciliation: true,
          credentialsStayInExecutor: true,
        },
      });
    }),
  );

  it.effect("routes invocation through the host-held connection credential", () =>
    Effect.gen(function* () {
      const github = githubLayer();
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            memoryCredentialsPlugin(),
            graphqlPlugin({ httpClientLayer: github.layer }),
          ] as const,
        }),
      );
      yield* executor.graphql.addIntegration({
        endpoint: "https://api.github.com/graphql",
        slug: "github",
        introspectionJson: JSON.stringify({
          data: {
            __schema: {
              queryType: { name: "Query" },
              mutationType: null,
              types: [
                {
                  kind: "OBJECT",
                  name: "Query",
                  description: null,
                  fields: [],
                  inputFields: null,
                  enumValues: null,
                },
              ],
            },
          },
        }),
        authenticationTemplate: [{ kind: "oauth2", slug: "oauth2" }],
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("github"),
        template: AuthTemplateSlug.make("oauth2"),
        value: "host-held-token",
      });
      const input = yield* makeInput();
      const result = yield* executor.execute(
        ToolAddress.make("tools.github.org.main.mutation.pushCommitArtifact"),
        input,
        { onElicitation: "accept-all" },
      );
      expect(result).toMatchObject({
        ok: true,
        data: {
          head: { commitSha: HEAD_COMMIT },
          pullRequest: { number: 17 },
          checks: { requiredState: "success" },
        },
      });
    }),
  );

  it.effect("pushes one exact commit and reconciles a repeated idempotency key", () =>
    Effect.gen(function* () {
      const input = yield* makeInput();
      const store = makeStore();
      const github = githubLayer();
      const first = yield* pushCommitArtifact(input, "host-held-token", store).pipe(
        Effect.provide(github.layer),
      );
      expect(first).toMatchObject({
        head: { commitSha: HEAD_COMMIT, treeSha: HEAD_TREE },
        pullRequest: { number: 17, headSha: HEAD_COMMIT, baseSha: BASE_COMMIT },
        checks: { requiredState: "success" },
      });
      const postsAfterFirst = github.requests.filter((entry) => entry.startsWith("POST ")).length;
      const repeated = yield* pushCommitArtifact(input, "host-held-token", store).pipe(
        Effect.provide(github.layer),
      );
      expect(repeated).toMatchObject({
        idempotencyKey: first.idempotencyKey,
        payloadSha256: first.payloadSha256,
        reconciled: true,
        head: first.head,
        pullRequest: first.pullRequest,
        checks: { requiredState: "success" },
      });
      expect(github.requests.filter((entry) => entry.startsWith("POST "))).toHaveLength(
        postsAfterFirst,
      );
    }),
  );

  it.effect("fails before effects when the live base branch is foreign", () =>
    Effect.gen(function* () {
      const input = yield* makeInput();
      const github = githubLayer({ foreignBase: true });
      const result = yield* Effect.result(
        pushCommitArtifact(input, "host-held-token", makeStore()).pipe(
          Effect.provide(github.layer),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(result.failure).toMatchObject({ code: "base_revision_mismatch" });
      expect(github.requests.some((entry) => entry.startsWith("POST "))).toBe(false);
    }),
  );

  it.effect("rejects reuse of an idempotency key for a different payload", () =>
    Effect.gen(function* () {
      const input = yield* makeInput();
      const store = makeStore();
      const github = githubLayer();
      yield* pushCommitArtifact(input, "host-held-token", store).pipe(Effect.provide(github.layer));
      const result = yield* Effect.result(
        pushCommitArtifact(
          {
            ...input,
            pullRequest: { ...input.pullRequest, title: "Foreign title" },
          },
          "host-held-token",
          store,
        ).pipe(Effect.provide(github.layer)),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(result.failure).toMatchObject({ code: "idempotency_key_conflict" });
    }),
  );
});

describe("governed commit approval posture", () => {
  it("does not ask for an interactive approval it cannot use", () => {
    // Every byte this tool writes is pinned by `artifactSha256` before the call, and the push
    // aborts if GitHub returns a different blob, tree, or commit. A prompt here cannot narrow the
    // effect -- it can only add a second gate in front of the caller's own signed authorization,
    // in a console no customer of that caller can reach. Regression: this annotation was `true`,
    // and every governed run parked forever waiting for a click that never came.
    expect(GITHUB_GOVERNED_COMMIT_TOOL.annotations?.requiresApproval).toBeFalsy();
  });

  it("still names the effect for any surface that shows pending work", () => {
    expect(GITHUB_GOVERNED_COMMIT_TOOL.annotations?.approvalDescription).toBe(
      "Push an exact governed commit and open its pull request",
    );
  });
});
