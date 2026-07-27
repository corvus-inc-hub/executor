import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ToolName, type ToolDef } from "@executor-js/sdk/core";

import type { GraphqlStore } from "./store";

const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const GITHUB_REST_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_FILE_COUNT = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

const GitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const SafeRepositorySegment = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,100}$/));
const BranchName = Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(240));
const Rfc3339Utc = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/));

const RepositoryIdentity = Schema.Struct({
  owner: SafeRepositorySegment,
  name: SafeRepositorySegment,
});

const CommitIdentity = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200)),
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
  date: Rfc3339Utc,
});

const CommitArtifactFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(1024)),
  mode: Schema.Literals(["100644", "100755", "120000"]),
  operation: Schema.Literals(["add", "modify", "delete"]),
  baseMode: Schema.optional(Schema.Literals(["100644", "100755", "120000"])),
  baseBlobSha: Schema.optional(GitSha),
  blobSha: Schema.optional(GitSha),
  contentBase64: Schema.optional(
    Schema.String.check(Schema.isMaxLength(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8)),
  ),
  contentSha256: Schema.optional(Sha256),
});

export const CommitArtifact = Schema.Struct({
  schemaVersion: Schema.Literal("mnfst.commit-artifact.v1"),
  base: Schema.Struct({
    branch: BranchName,
    commitSha: GitSha,
    treeSha: GitSha,
  }),
  head: Schema.Struct({
    branch: BranchName,
    commitSha: GitSha,
    treeSha: GitSha,
    message: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(65_536)),
    author: CommitIdentity,
    committer: CommitIdentity,
  }),
  files: Schema.Array(CommitArtifactFile)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(MAX_FILE_COUNT)),
});
export type CommitArtifact = typeof CommitArtifact.Type;

export const RepositoryDeliveryPolicy = Schema.Struct({
  schemaVersion: Schema.Literal("mnfst.repository-delivery-policy.v1"),
  repository: RepositoryIdentity,
  baseBranch: BranchName,
  headBranchPrefix: BranchName,
  allowForcePush: Schema.Literal(false),
  requiredChecks: Schema.Array(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200)),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(100)),
});
export type RepositoryDeliveryPolicy = typeof RepositoryDeliveryPolicy.Type;

export const PushCommitArtifactInput = Schema.Struct({
  schemaVersion: Schema.Literal("mnfst.executor.push-commit-artifact.v1"),
  idempotencyKey: Sha256,
  artifactSha256: Sha256,
  policySha256: Sha256,
  repository: RepositoryIdentity,
  policy: RepositoryDeliveryPolicy,
  artifact: CommitArtifact,
  pullRequest: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
    body: Schema.String.check(Schema.isMaxLength(65_536)),
    draft: Schema.Literal(false),
  }),
});
export type PushCommitArtifactInput = typeof PushCommitArtifactInput.Type;

const CheckRunReceipt = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  url: Schema.String,
  detailsUrl: Schema.NullOr(Schema.String),
  headSha: GitSha,
});

const CommitStatusReceipt = Schema.Struct({
  id: Schema.Number,
  context: Schema.String,
  state: Schema.String,
  url: Schema.String,
  targetUrl: Schema.NullOr(Schema.String),
  sha: GitSha,
});

const RequiredCheckReceipt = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["pending", "success", "failure"]),
  source: Schema.Literals(["check-run", "commit-status", "missing"]),
  id: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
});
type RequiredCheckReceipt = typeof RequiredCheckReceipt.Type;

export const PushCommitArtifactReceipt = Schema.Struct({
  schemaVersion: Schema.Literal("mnfst.executor.push-commit-artifact-receipt.v1"),
  idempotencyKey: Sha256,
  payloadSha256: Sha256,
  artifactSha256: Sha256,
  policySha256: Sha256,
  reconciled: Schema.Boolean,
  repository: RepositoryIdentity,
  base: Schema.Struct({ branch: BranchName, commitSha: GitSha, treeSha: GitSha }),
  head: Schema.Struct({
    branch: BranchName,
    commitSha: GitSha,
    treeSha: GitSha,
    refUrl: Schema.String,
  }),
  pullRequest: Schema.Struct({
    number: Schema.Number,
    url: Schema.String,
    nodeId: Schema.String,
    state: Schema.String,
    isDraft: Schema.Boolean,
    headSha: GitSha,
    baseSha: GitSha,
  }),
  checks: Schema.Struct({
    observedAt: Rfc3339Utc,
    combinedState: Schema.String,
    requiredState: Schema.Literals(["pending", "success", "failure"]),
    runs: Schema.Array(CheckRunReceipt),
    statuses: Schema.Array(CommitStatusReceipt),
    required: Schema.Array(RequiredCheckReceipt),
  }),
});
export type PushCommitArtifactReceipt = typeof PushCommitArtifactReceipt.Type;

const PendingEffect = Schema.Struct({
  schemaVersion: Schema.Literal("mnfst.executor.governed-effect-state.v1"),
  status: Schema.Literal("pending"),
  payloadSha256: Sha256,
  createdAt: Rfc3339Utc,
});

const CompletedEffect = Schema.Struct({
  schemaVersion: Schema.Literal("mnfst.executor.governed-effect-state.v1"),
  status: Schema.Literal("completed"),
  payloadSha256: Sha256,
  createdAt: Rfc3339Utc,
  receipt: PushCommitArtifactReceipt,
});

const GovernedEffectState = Schema.Union([PendingEffect, CompletedEffect]);

export class GithubGovernedCommitError extends Schema.TaggedErrorClass<GithubGovernedCommitError>()(
  "GithubGovernedCommitError",
  {
    stage: Schema.String,
    code: Schema.String,
    message: Schema.String,
    status: Schema.NullOr(Schema.Number),
    ambiguous: Schema.Boolean,
    retryable: Schema.Boolean,
  },
) {}

const GitReferenceResponse = Schema.Struct({
  ref: Schema.String,
  url: Schema.String,
  object: Schema.Struct({ sha: GitSha, type: Schema.String, url: Schema.String }),
});

const GitCommitResponse = Schema.Struct({
  sha: GitSha,
  url: Schema.String,
  tree: Schema.Struct({ sha: GitSha, url: Schema.optional(Schema.String) }),
});

const GitTreeEntry = Schema.Struct({
  path: Schema.String,
  mode: Schema.String,
  type: Schema.String,
  sha: GitSha,
});

const GitTreeResponse = Schema.Struct({
  sha: GitSha,
  url: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  tree: Schema.Array(GitTreeEntry),
});

const GitObjectResponse = Schema.Struct({ sha: GitSha, url: Schema.String });

const RepositoryResponse = Schema.Struct({
  full_name: Schema.String,
  archived: Schema.Boolean,
  disabled: Schema.Boolean,
});

const PullRequestResponse = Schema.Struct({
  number: Schema.Number,
  node_id: Schema.String,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  draft: Schema.Boolean,
  head: Schema.Struct({ sha: GitSha, ref: Schema.String }),
  base: Schema.Struct({ sha: GitSha, ref: Schema.String }),
});

const PullRequestListResponse = Schema.Array(PullRequestResponse);

const CheckRunsResponse = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      url: Schema.String,
      details_url: Schema.NullOr(Schema.String),
      head_sha: GitSha,
    }),
  ),
});

const CombinedStatusResponse = Schema.Struct({
  state: Schema.String,
  sha: GitSha,
  url: Schema.String,
  statuses: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      context: Schema.String,
      state: Schema.String,
      url: Schema.String,
      target_url: Schema.NullOr(Schema.String),
    }),
  ),
});

const CAPABILITY_SCHEMA_VERSION = "mnfst.executor.push-commit-artifact-capability.v1";
export const GITHUB_GOVERNED_COMMIT_GUARANTEES = Object.freeze({
  exactCommitSha: true,
  idempotencyKey: true,
  ambiguousReconciliation: true,
  credentialsStayInExecutor: true,
});

const inputJsonSchema = Schema.toJsonSchemaDocument(PushCommitArtifactInput).schema;
const outputJsonSchema = Schema.toJsonSchemaDocument(PushCommitArtifactReceipt).schema;

export const GITHUB_GOVERNED_COMMIT_TOOL: ToolDef = {
  name: ToolName.make("mutation.pushCommitArtifact"),
  description:
    "Push one immutable credential-free commit artifact through host-held GitHub credentials, reconcile the idempotent branch and pull request, and return exact commit, pull-request, and check identities.",
  inputSchema: inputJsonSchema,
  outputSchema: {
    ...outputJsonSchema,
    "x-executor-capability": {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      guarantees: GITHUB_GOVERNED_COMMIT_GUARANTEES,
    },
  },
  // No interactive approval. Unlike the generated GraphQL mutations, this tool cannot be pointed at
  // an arbitrary effect: every byte it writes is fixed by `artifactSha256` before the call, and the
  // push aborts on `blob_sha_mismatch`, `tree_sha_mismatch`, or `commit_sha_mismatch` if GitHub
  // produces anything else. An approval prompt here cannot narrow what happens -- it can only ask a
  // human to re-consent to an effect that is already pinned to a hash.
  //
  // The consent lives with the caller, which is the only party that knows what the artifact means.
  // Manifest parks a signed governed action bound to this exact input hash, with a one-use grant
  // capped at a single call, write, and external effect, before it ever opens this session. Asking
  // again in the Executor console put a second gate in front of that one -- a gate no customer can
  // reach, on a per-run basis, which is not something a multi-tenant product can ship.
  //
  // What still bounds the effect: the artifact hash binding above, the caller's branch-prefix
  // confinement, and the fact that this opens a pull request rather than merging one.
  annotations: {
    approvalDescription: "Push an exact governed commit and open its pull request",
  },
};

export const isGithubGraphqlEndpoint = (endpoint: string): boolean => {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  return url.toString() === GITHUB_GRAPHQL_ENDPOINT;
};

type GithubResponse = Readonly<{
  status: number;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}>;

const failure = (input: {
  stage: string;
  code: string;
  message: string;
  status?: number;
  ambiguous?: boolean;
  retryable?: boolean;
}) =>
  GithubGovernedCommitError.make({
    stage: input.stage,
    code: input.code,
    message: input.message,
    status: input.status ?? null,
    ambiguous: input.ambiguous ?? false,
    retryable: input.retryable ?? false,
  });

const canonicalize = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return null;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]);
  return Object.fromEntries(entries);
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = (algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle
        .digest(algorithm, Uint8Array.from(bytes))
        .then((result) => bytesToHex(new Uint8Array(result))),
    catch: () =>
      failure({
        stage: "artifact-hash",
        code: "digest_unavailable",
        message: `The ${algorithm} artifact digest could not be computed.`,
      }),
  });

export const sha256Canonical = (value: unknown) =>
  digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));

const decodeBase64 = (value: string, path: string) =>
  Effect.try({
    try: () => {
      const binary = atob(value);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    },
    catch: () =>
      failure({
        stage: "artifact-validation",
        code: "invalid_base64",
        message: `Artifact file ${path} is not valid base64.`,
      }),
  });

const gitBlobSha = (bytes: Uint8Array) => {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header, 0);
  object.set(bytes, header.byteLength);
  return digest("SHA-1", object);
};

const bodyText = (body: unknown): string => {
  if (typeof body === "string") return body.slice(0, 500);
  if (typeof body === "object" && body !== null) {
    const message = Reflect.get(body, "message");
    if (typeof message === "string") return message.slice(0, 500);
  }
  return "GitHub rejected the request.";
};

const githubRequest = Effect.fn("graphql.githubGovernedCommit.request")(function* (input: {
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  stage: string;
  mutating?: boolean;
}) {
  const client = yield* HttpClient.HttpClient;
  const url = `${GITHUB_REST_ORIGIN}${input.path}`;
  const make =
    input.method === "GET"
      ? HttpClientRequest.get
      : input.method === "POST"
        ? HttpClientRequest.post
        : HttpClientRequest.patch;
  let request = make(url).pipe(
    HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("Authorization", `Bearer ${input.token}`),
    HttpClientRequest.setHeader("X-GitHub-Api-Version", GITHUB_API_VERSION),
    HttpClientRequest.setHeader("User-Agent", "manifest-executor"),
  );
  if (input.body !== undefined) {
    request = HttpClientRequest.bodyJsonUnsafe(request, input.body);
  }
  const response = yield* client.execute(request).pipe(
    Effect.mapError(() =>
      failure({
        stage: input.stage,
        code: input.mutating ? "github_effect_ambiguous" : "github_unavailable",
        message: input.mutating
          ? `GitHub did not acknowledge the ${input.stage} effect; retry only with the same idempotency key.`
          : `GitHub could not be reached during ${input.stage}.`,
        ambiguous: input.mutating,
        retryable: true,
      }),
    ),
  );
  const text = yield* response.text.pipe(
    Effect.mapError(() =>
      failure({
        stage: input.stage,
        code: input.mutating ? "github_effect_ambiguous" : "github_invalid_response",
        message: `GitHub returned an unreadable response during ${input.stage}.`,
        ambiguous: input.mutating,
        retryable: input.mutating,
      }),
    ),
  );
  const body =
    text.length === 0
      ? null
      : yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
          Effect.mapError(() =>
            failure({
              stage: input.stage,
              code: input.mutating ? "github_effect_ambiguous" : "github_invalid_response",
              message: `GitHub returned non-JSON data during ${input.stage}.`,
              status: response.status,
              ambiguous: input.mutating,
              retryable: input.mutating,
            }),
          ),
        );
  return {
    status: response.status,
    body,
    headers: { ...response.headers },
  } satisfies GithubResponse;
});

const requireStatus = (response: GithubResponse, expected: readonly number[], stage: string) =>
  expected.includes(response.status)
    ? Effect.succeed(response.body)
    : Effect.fail(
        failure({
          stage,
          code: "github_rejected",
          message: `${stage} failed with HTTP ${response.status}: ${bodyText(response.body)}`,
          status: response.status,
          ambiguous: false,
          retryable: response.status === 429 || response.status >= 500,
        }),
      );

const decodeResponse =
  <S extends Schema.Top>(schema: S, stage: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() =>
        failure({
          stage,
          code: "github_invalid_response",
          message: `GitHub returned an invalid ${stage} response.`,
        }),
      ),
    );

const repoPath = (repository: typeof RepositoryIdentity.Type): string =>
  `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;

const refPath = (repository: typeof RepositoryIdentity.Type, branch: string): string =>
  `${repoPath(repository)}/git/ref/${encodeURIComponent(`heads/${branch}`)}`;

const validatePath = (path: string): boolean => {
  const containsControlCharacter = Array.from(path).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    containsControlCharacter
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git",
  );
};

const checkInputInvariants = Effect.fn("graphql.githubGovernedCommit.validate")(function* (
  input: PushCommitArtifactInput,
) {
  const expectedPolicyHash = yield* sha256Canonical(input.policy);
  if (expectedPolicyHash !== input.policySha256) {
    return yield* failure({
      stage: "policy-validation",
      code: "policy_hash_mismatch",
      message: "The repository delivery policy hash does not match its canonical payload.",
    });
  }
  const expectedArtifactHash = yield* sha256Canonical(input.artifact);
  if (expectedArtifactHash !== input.artifactSha256) {
    return yield* failure({
      stage: "artifact-validation",
      code: "artifact_hash_mismatch",
      message: "The commit artifact hash does not match its canonical payload.",
    });
  }
  if (
    input.repository.owner !== input.policy.repository.owner ||
    input.repository.name !== input.policy.repository.name
  ) {
    return yield* failure({
      stage: "policy-validation",
      code: "repository_policy_mismatch",
      message: "The requested repository does not match the immutable delivery policy.",
    });
  }
  if (
    input.artifact.base.branch !== input.policy.baseBranch ||
    input.artifact.head.branch === input.artifact.base.branch ||
    !input.artifact.head.branch.startsWith(input.policy.headBranchPrefix)
  ) {
    return yield* failure({
      stage: "policy-validation",
      code: "branch_policy_mismatch",
      message: "The artifact base or head branch does not satisfy the immutable delivery policy.",
    });
  }
  if (input.policy.allowForcePush !== false || input.pullRequest.draft !== false) {
    return yield* failure({
      stage: "policy-validation",
      code: "unsafe_delivery_policy",
      message: "Governed delivery forbids force pushes and draft pull requests.",
    });
  }
  const deterministicSuffix = input.idempotencyKey.slice(0, 16);
  if (input.artifact.head.branch !== `${input.policy.headBranchPrefix}${deterministicSuffix}`) {
    return yield* failure({
      stage: "policy-validation",
      code: "non_idempotent_head_branch",
      message:
        "The head branch must equal the policy prefix plus the first 16 characters of the idempotency key.",
    });
  }

  if (new Set(input.policy.requiredChecks).size !== input.policy.requiredChecks.length) {
    return yield* failure({
      stage: "policy-validation",
      code: "duplicate_required_check",
      message: "The immutable delivery policy contains a duplicate required check.",
    });
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of input.artifact.files) {
    if (!validatePath(file.path) || paths.has(file.path)) {
      return yield* failure({
        stage: "artifact-validation",
        code: "invalid_artifact_path",
        message: `Artifact path ${file.path} is unsafe or duplicated.`,
      });
    }
    paths.add(file.path);
    if (file.operation === "delete") {
      if (
        file.baseBlobSha === undefined ||
        file.baseMode === undefined ||
        file.blobSha !== undefined ||
        file.contentBase64 !== undefined ||
        file.contentSha256 !== undefined
      ) {
        return yield* failure({
          stage: "artifact-validation",
          code: "invalid_delete_entry",
          message: `Deleted file ${file.path} must name only its exact base blob and mode.`,
        });
      }
      continue;
    }
    if (
      (file.operation === "modify" &&
        (file.baseBlobSha === undefined || file.baseMode === undefined)) ||
      (file.operation === "add" &&
        (file.baseBlobSha !== undefined || file.baseMode !== undefined)) ||
      file.blobSha === undefined ||
      file.contentBase64 === undefined ||
      file.contentSha256 === undefined
    ) {
      return yield* failure({
        stage: "artifact-validation",
        code: "invalid_file_entry",
        message: `Artifact file ${file.path} is missing its exact content or blob identity.`,
      });
    }
    const bytes = yield* decodeBase64(file.contentBase64, file.path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_FILE_BYTES || totalBytes > MAX_BUNDLE_BYTES) {
      return yield* failure({
        stage: "artifact-validation",
        code: "artifact_too_large",
        message: "The credential-free commit bundle exceeds the governed size limit.",
      });
    }
    const [contentHash, blobHash] = yield* Effect.all([
      digest("SHA-256", bytes),
      gitBlobSha(bytes),
    ]);
    if (contentHash !== file.contentSha256 || blobHash !== file.blobSha) {
      return yield* failure({
        stage: "artifact-validation",
        code: "file_hash_mismatch",
        message: `Artifact file ${file.path} does not match its declared hashes.`,
      });
    }
  }
});

const getRepository = (token: string, repository: typeof RepositoryIdentity.Type) =>
  githubRequest({
    token,
    method: "GET",
    path: repoPath(repository),
    stage: "repository-read",
  }).pipe(
    Effect.flatMap((response) => requireStatus(response, [200], "repository-read")),
    Effect.flatMap(decodeResponse(RepositoryResponse, "repository")),
  );

const getReference = (token: string, repository: typeof RepositoryIdentity.Type, branch: string) =>
  githubRequest({
    token,
    method: "GET",
    path: refPath(repository, branch),
    stage: "reference-read",
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 404
        ? Effect.succeed(null)
        : requireStatus(response, [200], "reference-read").pipe(
            Effect.flatMap(decodeResponse(GitReferenceResponse, "reference")),
          ),
    ),
  );

const getCommit = (token: string, repository: typeof RepositoryIdentity.Type, sha: string) =>
  githubRequest({
    token,
    method: "GET",
    path: `${repoPath(repository)}/git/commits/${sha}`,
    stage: "commit-read",
  }).pipe(
    Effect.flatMap((response) => requireStatus(response, [200], "commit-read")),
    Effect.flatMap(decodeResponse(GitCommitResponse, "commit")),
  );

const getTree = (token: string, repository: typeof RepositoryIdentity.Type, sha: string) =>
  githubRequest({
    token,
    method: "GET",
    path: `${repoPath(repository)}/git/trees/${sha}?recursive=1`,
    stage: "tree-read",
  }).pipe(
    Effect.flatMap((response) => requireStatus(response, [200], "tree-read")),
    Effect.flatMap(decodeResponse(GitTreeResponse, "tree")),
  );

const createBlob = (
  token: string,
  repository: typeof RepositoryIdentity.Type,
  contentBase64: string,
) =>
  githubRequest({
    token,
    method: "POST",
    path: `${repoPath(repository)}/git/blobs`,
    stage: "blob-create",
    mutating: true,
    body: { content: contentBase64, encoding: "base64" },
  }).pipe(
    Effect.flatMap((response) => requireStatus(response, [201], "blob-create")),
    Effect.flatMap(decodeResponse(GitObjectResponse, "blob")),
  );

type TreeWrite = Readonly<{
  path: string;
  mode: string;
  type: "blob";
  sha: string | null;
}>;

const createTree = (
  token: string,
  repository: typeof RepositoryIdentity.Type,
  baseTreeSha: string,
  entries: readonly TreeWrite[],
) =>
  githubRequest({
    token,
    method: "POST",
    path: `${repoPath(repository)}/git/trees`,
    stage: "tree-create",
    mutating: true,
    body: { base_tree: baseTreeSha, tree: entries },
  }).pipe(
    Effect.flatMap((response) => requireStatus(response, [201], "tree-create")),
    Effect.flatMap(decodeResponse(GitTreeResponse, "tree")),
  );

const createCommit = (
  token: string,
  repository: typeof RepositoryIdentity.Type,
  artifact: CommitArtifact,
) =>
  githubRequest({
    token,
    method: "POST",
    path: `${repoPath(repository)}/git/commits`,
    stage: "commit-create",
    mutating: true,
    body: {
      message: artifact.head.message,
      tree: artifact.head.treeSha,
      parents: [artifact.base.commitSha],
      author: artifact.head.author,
      committer: artifact.head.committer,
    },
  }).pipe(
    Effect.flatMap((response) => requireStatus(response, [201], "commit-create")),
    Effect.flatMap(decodeResponse(GitCommitResponse, "commit")),
  );

const ensureHeadReference = Effect.fn("graphql.githubGovernedCommit.ensureRef")(function* (
  token: string,
  input: PushCommitArtifactInput,
) {
  const existing = yield* getReference(token, input.repository, input.artifact.head.branch);
  if (existing?.object.sha === input.artifact.head.commitSha)
    return { reference: existing, reconciled: true };
  if (existing !== null && existing.object.sha !== input.artifact.base.commitSha) {
    return yield* failure({
      stage: "reference-write",
      code: "head_branch_conflict",
      message: "The governed head branch exists at a foreign commit.",
    });
  }
  const effect =
    existing === null
      ? githubRequest({
          token,
          method: "POST",
          path: `${repoPath(input.repository)}/git/refs`,
          stage: "reference-create",
          mutating: true,
          body: {
            ref: `refs/heads/${input.artifact.head.branch}`,
            sha: input.artifact.head.commitSha,
          },
        })
      : githubRequest({
          token,
          method: "PATCH",
          path: refPath(input.repository, input.artifact.head.branch),
          stage: "reference-update",
          mutating: true,
          body: { sha: input.artifact.head.commitSha, force: false },
        });
  const writeResult = yield* Effect.option(effect);
  if (
    Option.isSome(writeResult) &&
    (writeResult.value.status === 200 || writeResult.value.status === 201)
  ) {
    const reference = yield* decodeResponse(
      GitReferenceResponse,
      "reference",
    )(writeResult.value.body);
    if (reference.object.sha !== input.artifact.head.commitSha) {
      return yield* failure({
        stage: "reference-write",
        code: "head_sha_mismatch",
        message: "GitHub acknowledged the branch write at a different commit.",
      });
    }
    return { reference, reconciled: false };
  }
  const reconciled = yield* getReference(token, input.repository, input.artifact.head.branch);
  if (reconciled?.object.sha === input.artifact.head.commitSha) {
    return { reference: reconciled, reconciled: true };
  }
  return yield* failure({
    stage: existing === null ? "reference-create" : "reference-update",
    code: "github_effect_ambiguous",
    message:
      "GitHub did not settle the governed branch effect; retry only with the same idempotency key.",
    ambiguous: true,
    retryable: true,
  });
});

const listMatchingPullRequests = (token: string, input: PushCommitArtifactInput) => {
  const query = new URLSearchParams({
    state: "all",
    head: `${input.repository.owner}:${input.artifact.head.branch}`,
    base: input.artifact.base.branch,
    per_page: "100",
  });
  return githubRequest({
    token,
    method: "GET",
    path: `${repoPath(input.repository)}/pulls?${query.toString()}`,
    stage: "pull-request-reconcile",
  }).pipe(
    Effect.flatMap((response) => requireStatus(response, [200], "pull-request-reconcile")),
    Effect.flatMap(decodeResponse(PullRequestListResponse, "pull-request-list")),
    Effect.map(
      (pulls) =>
        pulls.find(
          (pull) =>
            pull.head.ref === input.artifact.head.branch &&
            pull.head.sha === input.artifact.head.commitSha &&
            pull.base.ref === input.artifact.base.branch,
        ) ?? null,
    ),
  );
};

const ensurePullRequest = Effect.fn("graphql.githubGovernedCommit.ensurePullRequest")(function* (
  token: string,
  input: PushCommitArtifactInput,
) {
  const existing = yield* listMatchingPullRequests(token, input);
  if (existing !== null) return { pullRequest: existing, reconciled: true };
  const created = yield* Effect.option(
    githubRequest({
      token,
      method: "POST",
      path: `${repoPath(input.repository)}/pulls`,
      stage: "pull-request-create",
      mutating: true,
      body: {
        title: input.pullRequest.title,
        body: input.pullRequest.body,
        head: input.artifact.head.branch,
        base: input.artifact.base.branch,
        draft: false,
        maintainer_can_modify: false,
      },
    }),
  );
  if (Option.isSome(created) && created.value.status === 201) {
    return {
      pullRequest: yield* decodeResponse(PullRequestResponse, "pull-request")(created.value.body),
      reconciled: false,
    };
  }
  const reconciled = yield* listMatchingPullRequests(token, input);
  if (reconciled !== null) return { pullRequest: reconciled, reconciled: true };
  return yield* failure({
    stage: "pull-request-create",
    code: "github_effect_ambiguous",
    message:
      "GitHub did not settle the governed pull request; retry only with the same idempotency key.",
    ambiguous: true,
    retryable: true,
  });
});

const observeChecks = Effect.fn("graphql.githubGovernedCommit.observeChecks")(function* (
  token: string,
  input: PushCommitArtifactInput,
) {
  const [runsBody, statusesBody] = yield* Effect.all(
    [
      githubRequest({
        token,
        method: "GET",
        path: `${repoPath(input.repository)}/commits/${input.artifact.head.commitSha}/check-runs?filter=latest&per_page=100`,
        stage: "check-runs-read",
      }).pipe(
        Effect.flatMap((response) => requireStatus(response, [200], "check-runs-read")),
        Effect.flatMap(decodeResponse(CheckRunsResponse, "check-runs")),
      ),
      githubRequest({
        token,
        method: "GET",
        path: `${repoPath(input.repository)}/commits/${input.artifact.head.commitSha}/status?per_page=100`,
        stage: "commit-status-read",
      }).pipe(
        Effect.flatMap((response) => requireStatus(response, [200], "commit-status-read")),
        Effect.flatMap(decodeResponse(CombinedStatusResponse, "commit-status")),
      ),
    ],
    { concurrency: 2 },
  );
  if (statusesBody.sha !== input.artifact.head.commitSha) {
    return yield* failure({
      stage: "checks-read",
      code: "check_sha_mismatch",
      message: "GitHub returned checks for a foreign commit.",
    });
  }
  const runs = runsBody.check_runs.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
    detailsUrl: run.details_url,
    headSha: run.head_sha,
  }));
  if (runs.some((run) => run.headSha !== input.artifact.head.commitSha)) {
    return yield* failure({
      stage: "checks-read",
      code: "check_sha_mismatch",
      message: "GitHub returned a check run for a foreign commit.",
    });
  }
  const statuses = statusesBody.statuses.map((status) => ({
    id: status.id,
    context: status.context,
    state: status.state,
    url: status.url,
    targetUrl: status.target_url,
    sha: statusesBody.sha,
  }));
  const required = input.policy.requiredChecks.map((name): RequiredCheckReceipt => {
    const run = runs.find((candidate) => candidate.name === name);
    if (run) {
      const state =
        run.status !== "completed"
          ? "pending"
          : run.conclusion === "success" ||
              run.conclusion === "neutral" ||
              run.conclusion === "skipped"
            ? "success"
            : "failure";
      return { name, state, source: "check-run", id: run.id, url: run.detailsUrl ?? run.url };
    }
    const status = statuses.find((candidate) => candidate.context === name);
    if (status) {
      const state =
        status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure";
      return {
        name,
        state,
        source: "commit-status",
        id: status.id,
        url: status.targetUrl ?? status.url,
      };
    }
    return { name, state: "pending", source: "missing", id: null, url: null };
  });
  const requiredState: "failure" | "success" | "pending" = required.some(
    (check) => check.state === "failure",
  )
    ? "failure"
    : required.every((check) => check.state === "success")
      ? "success"
      : "pending";
  return {
    observedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    combinedState: statusesBody.state,
    requiredState,
    runs,
    statuses,
    required,
  };
});

const reconcileCompletedReceipt = Effect.fn("graphql.githubGovernedCommit.reconcileReceipt")(
  function* (token: string, input: PushCommitArtifactInput, receipt: PushCommitArtifactReceipt) {
    const [head, pulls, checks] = yield* Effect.all(
      [
        getReference(token, input.repository, input.artifact.head.branch),
        listMatchingPullRequests(token, input),
        observeChecks(token, input),
      ],
      { concurrency: 3 },
    );
    if (
      head?.object.sha !== receipt.head.commitSha ||
      pulls === null ||
      pulls.number !== receipt.pullRequest.number ||
      pulls.head.sha !== receipt.head.commitSha
    ) {
      return yield* failure({
        stage: "receipt-reconciliation",
        code: "governed_effect_drift",
        message:
          "The persisted governed receipt no longer matches GitHub branch or pull-request truth.",
      });
    }
    return PushCommitArtifactReceipt.make({
      ...receipt,
      reconciled: true,
      checks,
    });
  },
);

export const pushCommitArtifact = Effect.fn("graphql.githubGovernedCommit.pushCommitArtifact")(
  function* (inputUnknown: unknown, token: string, store: GraphqlStore) {
    const input = yield* Schema.decodeUnknownEffect(PushCommitArtifactInput)(inputUnknown).pipe(
      Effect.mapError(() =>
        failure({
          stage: "input-validation",
          code: "invalid_commit_artifact_input",
          message: "The governed commit artifact input does not match the v1 schema.",
        }),
      ),
    );
    yield* checkInputInvariants(input);
    const payloadSha256 = yield* sha256Canonical(input);
    const storedUnknown = yield* store.getGovernedEffect(input.idempotencyKey);
    const stored =
      storedUnknown === null
        ? null
        : yield* Schema.decodeUnknownEffect(GovernedEffectState)(storedUnknown).pipe(
            Effect.mapError(() =>
              failure({
                stage: "idempotency-read",
                code: "corrupt_idempotency_state",
                message: "The persisted governed-effect state is invalid.",
              }),
            ),
          );
    if (stored !== null && stored.payloadSha256 !== payloadSha256) {
      return yield* failure({
        stage: "idempotency-read",
        code: "idempotency_key_conflict",
        message: "The idempotency key is already bound to a different payload.",
      });
    }
    if (stored?.status === "completed") {
      return yield* reconcileCompletedReceipt(token, input, stored.receipt);
    }
    const createdAt = stored?.createdAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    yield* store.putGovernedEffect(input.idempotencyKey, {
      schemaVersion: "mnfst.executor.governed-effect-state.v1",
      status: "pending",
      payloadSha256,
      createdAt,
    });

    const repository = yield* getRepository(token, input.repository);
    if (
      repository.full_name.toLowerCase() !==
        `${input.repository.owner}/${input.repository.name}`.toLowerCase() ||
      repository.archived ||
      repository.disabled
    ) {
      return yield* failure({
        stage: "repository-read",
        code: "repository_identity_mismatch",
        message: "GitHub repository identity or mutability does not match the governed request.",
      });
    }
    const [baseReference, baseCommit, baseTree] = yield* Effect.all(
      [
        getReference(token, input.repository, input.artifact.base.branch),
        getCommit(token, input.repository, input.artifact.base.commitSha),
        getTree(token, input.repository, input.artifact.base.treeSha),
      ],
      { concurrency: 3 },
    );
    if (
      baseReference?.object.sha !== input.artifact.base.commitSha ||
      baseCommit.sha !== input.artifact.base.commitSha ||
      baseCommit.tree.sha !== input.artifact.base.treeSha ||
      baseTree.sha !== input.artifact.base.treeSha ||
      baseTree.truncated === true
    ) {
      return yield* failure({
        stage: "base-verification",
        code: "base_revision_mismatch",
        message: "The live GitHub base revision or tree does not match the immutable artifact.",
      });
    }
    const baseBlobs = new Map(
      baseTree.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => [entry.path, { sha: entry.sha, mode: entry.mode }]),
    );
    for (const file of input.artifact.files) {
      const current = baseBlobs.get(file.path);
      if (
        (file.operation === "add" && current !== undefined) ||
        (file.operation !== "add" &&
          (current?.sha !== file.baseBlobSha || current?.mode !== file.baseMode))
      ) {
        return yield* failure({
          stage: "base-verification",
          code: "base_blob_mismatch",
          message: `The live base blob for ${file.path} does not match the artifact.`,
        });
      }
    }

    const treeEntries: TreeWrite[] = [];
    for (const file of input.artifact.files) {
      if (file.operation === "delete") {
        treeEntries.push({ path: file.path, mode: file.mode, type: "blob", sha: null });
        continue;
      }
      const contentBase64 = file.contentBase64;
      if (contentBase64 === undefined) {
        return yield* failure({
          stage: "artifact-validation",
          code: "invalid_file_entry",
          message: `Artifact file ${file.path} lost its validated content.`,
        });
      }
      const created = yield* createBlob(token, input.repository, contentBase64);
      if (created.sha !== file.blobSha) {
        return yield* failure({
          stage: "blob-create",
          code: "blob_sha_mismatch",
          message: `GitHub created a foreign blob identity for ${file.path}.`,
        });
      }
      treeEntries.push({ path: file.path, mode: file.mode, type: "blob", sha: created.sha });
    }
    const tree = yield* createTree(
      token,
      input.repository,
      input.artifact.base.treeSha,
      treeEntries,
    );
    if (tree.sha !== input.artifact.head.treeSha) {
      return yield* failure({
        stage: "tree-create",
        code: "tree_sha_mismatch",
        message: "GitHub created a tree that does not match the immutable artifact.",
      });
    }
    const commit = yield* createCommit(token, input.repository, input.artifact);
    if (
      commit.sha !== input.artifact.head.commitSha ||
      commit.tree.sha !== input.artifact.head.treeSha
    ) {
      return yield* failure({
        stage: "commit-create",
        code: "commit_sha_mismatch",
        message: "GitHub created a commit that does not match the immutable artifact.",
      });
    }
    const branch = yield* ensureHeadReference(token, input);
    const pull = yield* ensurePullRequest(token, input);
    if (
      pull.pullRequest.head.sha !== input.artifact.head.commitSha ||
      pull.pullRequest.base.sha !== input.artifact.base.commitSha ||
      pull.pullRequest.title !== input.pullRequest.title ||
      (pull.pullRequest.body ?? "") !== input.pullRequest.body ||
      pull.pullRequest.draft
    ) {
      return yield* failure({
        stage: "pull-request-verification",
        code: "pull_request_identity_mismatch",
        message: "The pull request does not match the exact governed base and head commits.",
      });
    }
    const checks = yield* observeChecks(token, input);
    const receipt = PushCommitArtifactReceipt.make({
      schemaVersion: "mnfst.executor.push-commit-artifact-receipt.v1",
      idempotencyKey: input.idempotencyKey,
      payloadSha256,
      artifactSha256: input.artifactSha256,
      policySha256: input.policySha256,
      reconciled: branch.reconciled || pull.reconciled || stored?.status === "pending",
      repository: input.repository,
      base: {
        branch: input.artifact.base.branch,
        commitSha: input.artifact.base.commitSha,
        treeSha: input.artifact.base.treeSha,
      },
      head: {
        branch: input.artifact.head.branch,
        commitSha: input.artifact.head.commitSha,
        treeSha: input.artifact.head.treeSha,
        refUrl: branch.reference.url,
      },
      pullRequest: {
        number: pull.pullRequest.number,
        url: pull.pullRequest.html_url,
        nodeId: pull.pullRequest.node_id,
        state: pull.pullRequest.state,
        isDraft: pull.pullRequest.draft,
        headSha: pull.pullRequest.head.sha,
        baseSha: pull.pullRequest.base.sha,
      },
      checks,
    });
    yield* store.putGovernedEffect(input.idempotencyKey, {
      schemaVersion: "mnfst.executor.governed-effect-state.v1",
      status: "completed",
      payloadSha256,
      createdAt,
      receipt,
    });
    return receipt;
  },
);
