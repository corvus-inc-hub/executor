# MNFST self-hosted Executor

This package runs Executor's API, MCP server, integration and credential plane,
QuickJS execution runtime, and web console in one container. SQLite data and the
Executor secret-encryption key remain local. WorkOS AuthKit is the only identity
provider.

The fork is based on upstream Executor `v1.5.31` at
`04ce4b4ae53a900f9c28276c300f3c8d5010472b`.

## Identity contract

- Browser users authenticate with WorkOS AuthKit sealed sessions.
- Organizations, memberships, roles, invitations, and API keys are read from or
  written to WorkOS. Executor mirrors only organization IDs, names, and stable
  URL slugs locally.
- Every API request resolves a live WorkOS organization membership. Existing
  connections, encrypted credentials, and execution remain scoped by the
  resulting Executor organization ID.
- WorkOS Connect OAuth tokens authenticate CLI and MCP clients. WorkOS API keys
  remain valid bearer credentials and retain their WorkOS organization owner.
- WorkOS Connect M2M applications authenticate internal service requests. The
  application must belong to the configured platform service organization; the
  customer organization remains an explicit, separately authorized request
  target.
- There is no local password database, first-user setup, Better Auth login,
  bootstrap admin, local invite code, or local OAuth authorization server.

## WorkOS setup

Configure these WorkOS resources before booting the server:

1. An AuthKit application with the Executor callback URL, for example
   `https://executor.example.com/api/auth/callback`.
2. Organization roles. Executor treats the `admin` role as the management role
   for invitations, member roles, member removal, and organization renaming.
3. AuthKit user API keys if users should create keys in the Executor console.
   The user API-key endpoints are feature flagged by WorkOS.
4. A WorkOS Connect OAuth application with device authorization enabled for the
   Executor CLI. Put its public client ID in `WORKOS_CLI_CLIENT_ID`.
5. AuthKit MCP support with CIMD enabled, and DCR if older MCP clients must be
   supported. Register the exact bare and organization-scoped MCP resource URLs
   that clients will use, such as `https://executor.example.com/mcp` and
   `https://executor.example.com/<organization-slug>/mcp`.
6. A WorkOS Connect M2M application for Manifest Trigger, owned by the platform
   service organization. Give it only `credentials:lease`, then allowlist its
   client ID in `WORKOS_M2M_ALLOWED_CLIENT_IDS`. Provider scopes stay on the
   customer connection and are checked independently for each lease.

## Runtime configuration

Copy [`.env.example`](./.env.example) to `.env` and set all required values.
The server fails during boot when its WorkOS identity configuration is missing
or invalid.

| Variable                                        | Required    | Purpose                                                                         |
| ----------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `EXECUTOR_WEB_BASE_URL`                         | yes         | Exact public origin used by browser and MCP URLs.                               |
| `EXECUTOR_AUTH_PROVIDER`                        | recommended | Must be `workos-authkit` when set.                                              |
| `WORKOS_API_KEY`                                | yes         | Server-side WorkOS API key.                                                     |
| `WORKOS_CLIENT_ID`                              | yes         | AuthKit application's client ID and default Connect audience.                   |
| `WORKOS_COOKIE_PASSWORD`                        | yes         | At least 32 characters, used to seal WorkOS browser sessions.                   |
| `WORKOS_AUTHKIT_DOMAIN`                         | yes         | AuthKit issuer origin, with no path.                                            |
| `WORKOS_REDIRECT_URI`                           | no          | Defaults to `<web base URL>/api/auth/callback`.                                 |
| `WORKOS_SERVICE_ORGANIZATION_ID`                | yes         | Platform organization that owns allowlisted M2M service apps.                   |
| `WORKOS_ALLOWED_ORGANIZATION_IDS`               | no          | Optional customer-organization allowlist; empty permits verified organizations. |
| `WORKOS_CLI_CLIENT_ID`                          | for CLI     | Public WorkOS Connect device-flow client ID.                                    |
| `WORKOS_CONNECT_AUDIENCE`                       | no          | JWT audience, defaulting to `WORKOS_CLIENT_ID`.                                 |
| `WORKOS_M2M_ALLOWED_CLIENT_IDS`                 | for M2M     | Comma-separated service client allowlist. Empty denies all M2M.                 |
| `WORKOS_CREDENTIAL_LEASE_SCOPE`                 | no          | Required M2M scope, default `credentials:lease`.                                |
| `EXECUTOR_CREDENTIAL_LEASE_DEFAULT_TTL_SECONDS` | no          | Default lease TTL, 3600 seconds.                                                |
| `EXECUTOR_CREDENTIAL_LEASE_MAX_TTL_SECONDS`     | no          | Maximum lease TTL, 3600 seconds.                                                |
| `EXECUTOR_SECRET_KEY`                           | recommended | Encrypts Executor credentials. Otherwise generated under `/data`.               |

`WORKOS_API_URL` is an optional WorkOS API override intended for a local
emulator or private routing. It is not a second identity provider.

## Run

From this package directory:

```bash
docker compose up -d --build
```

Or run a published digest with an explicit environment file:

```bash
docker run -d \
  --name executor-selfhost \
  -p 4788:4788 \
  --env-file /path/to/executor.env \
  -v executor-data:/data \
  ghcr.io/OWNER/executor-selfhost@sha256:DIGEST
```

Always persist `/data`. It contains `data.db` and, when
`EXECUTOR_SECRET_KEY` is not set, the generated `secret.key` required to
decrypt existing Executor credentials.

## Credential leases

Manifest Trigger requests a lease with a WorkOS M2M access token:

```http
POST /api/credential-leases
Authorization: Bearer <workos-m2m-jwt>
Content-Type: application/json
```

```json
{
  "organizationId": "org_...",
  "workspaceId": "workspace_manifest",
  "runId": "run_...",
  "credential": {
    "integration": "github",
    "name": "github-prod"
  },
  "purpose": "Run approved release workflow",
  "scopes": ["github:read"],
  "ttlSeconds": 3600,
  "delivery": {
    "environment": {
      "GITHUB_TOKEN": "token"
    },
    "secretFiles": [
      {
        "name": "github-app.pem",
        "variable": "privateKey"
      }
    ]
  }
}
```

The endpoint verifies JWT signature, issuer, audience, expiry, M2M subject,
organization, allowlisted client ID, live Connect application ownership, and
the `credentials:lease` permission before resolving an existing
organization-owned Executor connection. Requested resource scopes are not
WorkOS permissions. When the connected credential records OAuth scopes, those
scopes must cover the resource request.

A successful `201` response contains delivery metadata plus only the requested
environment variables and `0600` secret-file contents. `disposeAfter` is the
deadline by which Manifest Sandbox must erase the material; `enforcement` is
always `sandbox_cleanup`. This does not claim to shorten or revoke an underlying
static provider credential. `sourceCredentialExpiresAt` reports a real provider
expiry when one exists. The local receipt stores organization, workspace, run,
client, credential, timestamps, scopes, and SHA-256 material hashes. It
never stores response secrets. Missing connections, OAuth refresh failures,
incomplete credentials, unknown delivery variables, or receipt-write failures
return an error and never produce a synthetic lease.

## Build and publish the arm64 image

Build from the repository root. Production images for `sst-executor` must be
`linux/arm64`, pushed to a registry, and consumed by digest. The source and
revision build arguments are required provenance inputs.

```bash
SOURCE_URL=https://github.com/OWNER/executor
SOURCE_REVISION=$(git rev-parse HEAD)
IMAGE=ghcr.io/OWNER/executor-selfhost:mnfst-${SOURCE_REVISION}

docker buildx build \
  --platform linux/arm64 \
  --file apps/host-selfhost/Dockerfile \
  --build-arg EXECUTOR_IMAGE_SOURCE="$SOURCE_URL" \
  --build-arg EXECUTOR_SOURCE_REVISION="$SOURCE_REVISION" \
  --build-arg EXECUTOR_UPSTREAM_REVISION=04ce4b4ae53a900f9c28276c300f3c8d5010472b \
  --tag "$IMAGE" \
  --push \
  .

docker buildx imagetools inspect "$IMAGE"
```

Before changing the digest consumed by infrastructure, verify the image is
`linux/arm64` and has these labels:

```text
org.opencontainers.image.source=<owned fork URL>
org.opencontainers.image.revision=<full owned-fork commit SHA>
io.mnfst.executor.auth-provider=workos-authkit
io.mnfst.executor.upstream-revision=04ce4b4ae53a900f9c28276c300f3c8d5010472b
```

Publishing an image does not deploy it. Deployment and digest updates belong to
the separate `sst-executor` infrastructure repository.

## Develop and check

```bash
bun run bootstrap
bun run --cwd apps/host-selfhost build
bun run --cwd apps/host-selfhost typecheck
bun run --cwd apps/host-selfhost test
```

The WorkOS identity and credential-lease unit tests use injected fakes and do
not call production WorkOS APIs.
