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
  GITHUB_REPOSITORY_WRITE_AUTHORITY_TOOL,
  inspectRepositoryWriteAuthority,
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
const AUTHORITY_INPUT = {
  schemaVersion: "mnfst.executor.repository-write-authority.v1",
  repository: { owner: "mnfst", name: "app", nodeId: "R_node" },
} as const;
const AUTHORITY_CREDENTIAL = {
  owner: "org",
  integration: "github",
  connection: "main",
  grantedScopes: [] as readonly string[],
} as const;

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

const githubLayer = (options?: {
  readonly foreignBase?: boolean;
  readonly repository?: Partial<{
    readonly node_id: string;
    readonly full_name: string;
    readonly archived: boolean;
    readonly disabled: boolean;
    readonly default_branch: string | null;
    readonly private: boolean;
    readonly permissions: {
      readonly admin: boolean;
      readonly maintain?: boolean;
      readonly push: boolean;
      readonly pull: boolean;
    };
  }>;
  readonly repositoryStatus?: number;
  readonly oauthScopes?: string;
  readonly treeVisibilityFailures?: number;
}) => {
  let branchCreated = false;
  let pullCreated = false;
  let treeCreateAttempts = 0;
  const requests: string[] = [];
  const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json",
          "x-accepted-oauth-scopes": "repo",
          "x-github-request-id": "TEST:1234",
          "x-oauth-scopes": options?.oauthScopes ?? "repo",
        },
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
          json(
            request,
            {
              id: 42,
              node_id: "R_node",
              full_name: "mnfst/app",
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
              permissions: { admin: false, maintain: false, push: true, pull: true },
              ...options?.repository,
            },
            options?.repositoryStatus ?? 200,
          ),
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
        treeCreateAttempts += 1;
        if (treeCreateAttempts <= (options?.treeVisibilityFailures ?? 0)) {
          return Effect.succeed(json(request, { message: "Not Found" }, 404));
        }
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
      const authoritySchema = yield* executor.tools.schema(
        ToolAddress.make("tools.github.org.main.query.repositoryWriteAuthority"),
      );
      expect(Reflect.get(authoritySchema?.outputSchema ?? {}, "x-executor-capability")).toEqual({
        schemaVersion: "mnfst.executor.repository-write-authority-capability.v1",
        guarantees: {
          credentialsStayInExecutor: true,
          exactRepositoryIdentity: true,
          providerRequestIdentity: true,
          readOnly: true,
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

  it.live("waits through a bounded tree visibility delay", () =>
    Effect.gen(function* () {
      const input = yield* makeInput();
      const github = githubLayer({ treeVisibilityFailures: 4 });
      const receipt = yield* pushCommitArtifact(input, "host-held-token", makeStore()).pipe(
        Effect.provide(github.layer),
      );
      expect(receipt.head.treeSha).toBe(HEAD_TREE);
      expect(
        github.requests.filter((entry) => entry === "POST /repos/mnfst/app/git/trees"),
      ).toHaveLength(5);
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

describe("GitHub repository write authority", () => {
  it.effect("uses the connection credential and performs only the exact repository read", () =>
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
      const result = yield* executor.execute(
        ToolAddress.make("tools.github.org.main.query.repositoryWriteAuthority"),
        AUTHORITY_INPUT,
      );
      expect(result).toMatchObject({
        ok: true,
        data: {
          result: "write_ready",
          expected: { nodeId: "R_node", owner: "mnfst", name: "app" },
          observed: { nodeId: "R_node", fullName: "mnfst/app" },
          permissions: { push: true },
          provider: { requestId: "TEST:1234", status: 200 },
          scopeEnvelope: { contentsWrite: true, pullRequestsWrite: true },
        },
      });
      expect(github.requests).toEqual(["GET /repos/mnfst/app"]);
    }),
  );

  it.effect("does not treat a readable 200 response as write authority", () =>
    Effect.gen(function* () {
      const github = githubLayer({
        repository: {
          permissions: { admin: false, maintain: false, push: false, pull: true },
        },
      });
      const receipt = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(github.layer));
      expect(receipt).toMatchObject({
        result: "read_only",
        reasons: ["repository_role_read_only"],
        provider: { status: 200 },
      });
      expect(github.requests).toEqual(["GET /repos/mnfst/app"]);
    }),
  );

  it.effect("fails closed when the configured repository node identity does not match", () =>
    Effect.gen(function* () {
      const github = githubLayer({ repository: { node_id: "R_foreign" } });
      const receipt = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(github.layer));
      expect(receipt).toMatchObject({
        result: "indeterminate",
        reasons: ["node_id_mismatch"],
        observed: { nodeId: "R_foreign" },
      });
    }),
  );

  it.effect("classifies a provider-shaped 404 as inaccessible with its request id", () =>
    Effect.gen(function* () {
      const github = githubLayer({ repositoryStatus: 404 });
      const receipt = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(github.layer));
      expect(receipt).toMatchObject({
        result: "inaccessible",
        reasons: ["github_http_404"],
        provider: { requestId: "TEST:1234", status: 404 },
      });
    }),
  );

  it.effect("limits public_repo scope to public repositories", () =>
    Effect.gen(function* () {
      const privateGithub = githubLayer({ oauthScopes: "public_repo" });
      const privateReceipt = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(privateGithub.layer));
      expect(privateReceipt).toMatchObject({
        result: "read_only",
        reasons: ["contents_scope_read_only", "pull_requests_scope_read_only"],
      });

      const publicGithub = githubLayer({
        oauthScopes: "public_repo",
        repository: { private: false },
      });
      const publicReceipt = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(publicGithub.layer));
      expect(publicReceipt.result).toBe("write_ready");
    }),
  );

  it.effect("requires both fine-grained contents and pull-request write scopes", () =>
    Effect.gen(function* () {
      const incompleteGithub = githubLayer({ oauthScopes: "contents:write" });
      const incomplete = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(incompleteGithub.layer));
      expect(incomplete).toMatchObject({
        result: "read_only",
        reasons: ["pull_requests_scope_read_only"],
        scopeEnvelope: { contentsWrite: true, pullRequestsWrite: false },
      });

      const completeGithub = githubLayer({
        oauthScopes: "contents:write, pull_requests:write",
      });
      const complete = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(completeGithub.layer));
      expect(complete).toMatchObject({
        result: "write_ready",
        scopeEnvelope: { contentsWrite: true, pullRequestsWrite: true },
      });
    }),
  );

  it.effect("normalizes a comma-delimited connection scope envelope in the receipt", () =>
    Effect.gen(function* () {
      const github = githubLayer();
      const receipt = yield* inspectRepositoryWriteAuthority(AUTHORITY_INPUT, "host-held-token", {
        ...AUTHORITY_CREDENTIAL,
        grantedScopes: ["read:org,repo"],
      }).pipe(Effect.provide(github.layer));

      expect(receipt).toMatchObject({
        credentialReference: { grantedScopes: ["read:org", "repo"] },
        scopeEnvelope: { executorGrantedScopes: ["read:org", "repo"] },
      });
    }),
  );

  it.effect("accepts an explicit higher role but blocks inactive repositories", () =>
    Effect.gen(function* () {
      const administratorGithub = githubLayer({
        repository: {
          permissions: { admin: true, maintain: false, push: false, pull: true },
        },
      });
      const administrator = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(administratorGithub.layer));
      expect(administrator).toMatchObject({ result: "write_ready", reasons: [] });

      const archivedGithub = githubLayer({ repository: { archived: true } });
      const archived = yield* inspectRepositoryWriteAuthority(
        AUTHORITY_INPUT,
        "host-held-token",
        AUTHORITY_CREDENTIAL,
      ).pipe(Effect.provide(archivedGithub.layer));
      expect(archived).toMatchObject({
        result: "read_only",
        reasons: ["repository_archived"],
      });
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

  it("keeps repository authority free of interactive approval", () => {
    expect(GITHUB_REPOSITORY_WRITE_AUTHORITY_TOOL.annotations?.requiresApproval).toBeFalsy();
    expect(GITHUB_REPOSITORY_WRITE_AUTHORITY_TOOL.name).toBe("query.repositoryWriteAuthority");
  });
});
