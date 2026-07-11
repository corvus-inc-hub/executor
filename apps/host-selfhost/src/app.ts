import { Effect, Layer } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";
import { HttpApiSwagger } from "effect/unstable/httpapi";

import {
  composePluginApi,
  ExecutorApp,
  makeScopedExecutor,
  textFailureStrategy,
} from "@executor-js/api/server";
import { runSqliteDataMigrations } from "@executor-js/sdk";

import { selfHostAccountMiddleware } from "./account";
import {
  ensureWorkOSIdentityTables,
  makeApiKeyService,
  makeOrganizationStore,
  makeWorkOSAuthHandler,
  makeWorkOSClient,
  makeWorkOSIdentityLayer,
  sessionForRequest,
  type WorkOSIdentityDeps,
} from "./auth";
import { serializeCookie } from "./auth/cookies";
import { WORKOS_SESSION_COOKIE } from "./auth/workos";
import { isEncryptedOrgAwsRoleConnection } from "./aws-role-integration";
import {
  loadConfig,
  loadWorkOSConfig,
  SELF_HOST_NAMESPACE,
  SELF_HOST_SCHEMA_VERSION,
} from "./config";
import { makeAwsRoleAssumer, makeCredentialLeaseHandler } from "./credential-leases";
import { selfHostDataMigrations } from "./db/data-migrations";
import { createSelfHostDb, SelfHostDb, SelfHostDbProvider } from "./db/self-host-db";
import {
  SelfHostCodeExecutorProvider,
  SelfHostHostConfig,
  SelfHostPluginsProvider,
  SelfHostScopedExecutorSeams,
} from "./execution";
import { makeSelfHostMcpSeams } from "./mcp";
import { ErrorCaptureLive } from "./observability";
import { selfHostPlugins } from "./plugins";
import { makeSelfHostSystemApiLayer } from "./system/handlers";

export interface MakeSelfHostAppOptions {
  readonly dbPath?: string;
}

const replaceCookie = (header: string | null, name: string, value: string): string => {
  const retained = (header ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0 && !cookie.startsWith(`${name}=`));
  return [`${name}=${value}`, ...retained].join("; ");
};

export const makeSelfHostApp = async (options: MakeSelfHostAppOptions = {}) => {
  const config = loadConfig();
  const workosConfig = loadWorkOSConfig(config);
  const dbHandle = await createSelfHostDb({
    path: options.dbPath ?? config.dbPath,
    namespace: SELF_HOST_NAMESPACE,
    version: SELF_HOST_SCHEMA_VERSION,
  });
  await Effect.runPromise(runSqliteDataMigrations(dbHandle.client, selfHostDataMigrations));
  await Effect.runPromise(ensureWorkOSIdentityTables(dbHandle.client));

  const workos = makeWorkOSClient(workosConfig);
  const organizations = makeOrganizationStore(dbHandle.client);
  const apiKeys = makeApiKeyService(workos);
  const identity: WorkOSIdentityDeps = {
    config: workosConfig,
    workos,
    organizations,
    apiKeys,
  };
  const identityLayer = makeWorkOSIdentityLayer(identity);
  const authHandler = makeWorkOSAuthHandler({
    selfHost: config,
    config: workosConfig,
    workos,
    organizations,
  });
  const mcp = makeSelfHostMcpSeams(dbHandle, identity, config.webBaseUrl);
  const assumeAwsRole = makeAwsRoleAssumer();

  const scopedExecutorLayer = SelfHostScopedExecutorSeams.pipe(
    Layer.provide(Layer.succeed(SelfHostDb)(dbHandle)),
  );
  const credentialLeaseHandler = makeCredentialLeaseHandler({
    config: workosConfig,
    workos,
    db: dbHandle.client,
    assumeAwsRole,
    resolveCredential: (serviceAccountId, organizationId, ref) =>
      makeScopedExecutor(serviceAccountId, organizationId, "").pipe(
        Effect.provide(scopedExecutorLayer),
        Effect.flatMap((executor) =>
          executor.connections
            .get(ref)
            .pipe(
              Effect.flatMap((connection) =>
                connection
                  ? String(ref.integration) === "amazonaws.com" &&
                    !isEncryptedOrgAwsRoleConnection(connection)
                    ? Effect.succeed(null)
                    : executor.connections
                        .resolveValues(ref)
                        .pipe(Effect.map((values) => ({ connection, values })))
                  : Effect.succeed(null),
              ),
            ),
        ),
      ),
  });

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins: selfHostPlugins,
    providers: {
      identity: identityLayer,
      account: selfHostAccountMiddleware(identity),
      db: SelfHostDbProvider,
      engine: { codeExecutor: SelfHostCodeExecutorProvider },
      mcp: { auth: mcp.auth, sessions: mcp.sessions, reporter: mcp.reporter },
      plugins: { provider: SelfHostPluginsProvider, config: SelfHostHostConfig },
      errorCapture: ErrorCaptureLive,
    },
    extensions: {
      routes: [
        HttpRouter.add("*", "/api/auth/*", HttpEffect.fromWebHandler(authHandler)),
        HttpRouter.add(
          "POST",
          "/api/credential-leases",
          HttpEffect.fromWebHandler(credentialLeaseHandler),
        ),
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(mcp.approvalHandler)),
        makeSelfHostSystemApiLayer({ db: dbHandle, mountPrefix: "/api" }),
        HttpApiSwagger.layer(composePluginApi(selfHostPlugins).prefix("/api"), { path: "/docs" }),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: Layer.merge(Layer.succeed(SelfHostDb)(dbHandle), identityLayer),
  });

  return {
    AppLayer: appLayer as Layer.Layer<never>,
    toWebHandler,
    workos,
    workosConfig,
    closeDb: async () => {
      await mcp.close();
      await dbHandle.close();
    },
  };
};

export interface SelfHostApiHandler {
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

export const makeSelfHostApiHandler = async (
  options: MakeSelfHostAppOptions = {},
): Promise<SelfHostApiHandler> => {
  const { toWebHandler, workos, workosConfig, closeDb } = await makeSelfHostApp(options);
  const web = toWebHandler();
  return {
    handler: async (request) => {
      const session = await Effect.runPromise(
        sessionForRequest(workos, request).pipe(Effect.orElseSucceed(() => null)),
      );
      const refreshed = session?.refreshedSession ?? null;
      const effectiveRequest = refreshed
        ? new Request(request, {
            headers: new Headers({
              ...Object.fromEntries(request.headers.entries()),
              cookie: replaceCookie(
                request.headers.get("cookie"),
                WORKOS_SESSION_COOKIE,
                refreshed,
              ),
            }),
          })
        : request;
      const response = await web.handler(effectiveRequest);
      if (!refreshed) return response;
      const headers = new Headers(response.headers);
      headers.append(
        "set-cookie",
        serializeCookie(WORKOS_SESSION_COOKIE, refreshed, {
          maxAge: 60 * 60 * 24 * 7,
          secure: workosConfig.redirectUri.startsWith("https://"),
        }),
      );
      return new Response(response.body, { status: response.status, headers });
    },
    dispose: async () => {
      await web.dispose();
      await closeDb();
    },
  };
};
