import { Effect, type Layer } from "effect";

import type { McpAuthProvider, McpErrorReporter, McpSessionStore } from "@executor-js/host-mcp";

import { resolveBrowserPrincipal, type WorkOSIdentityDeps } from "../auth/identity";
import type { SelfHostDbHandle } from "../db/self-host-db";
import { makeSelfHostMcpAuth } from "./auth";
import {
  makeSelfHostMcpSessionStore,
  selfHostMcpReporter,
  selfHostMcpSessions,
} from "./session-store";

export { makeSelfHostMcpAuth } from "./auth";
export {
  makeSelfHostMcpSessionStore,
  selfHostMcpReporter,
  selfHostMcpSessions,
  McpEngineBuildError,
} from "./session-store";

export interface SelfHostMcpSeams {
  readonly auth: Layer.Layer<McpAuthProvider>;
  readonly sessions: Layer.Layer<McpSessionStore>;
  readonly reporter: Layer.Layer<McpErrorReporter>;
  readonly approvalHandler: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

const jsonResponse = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const makeApprovalHandler =
  (
    store: ReturnType<typeof makeSelfHostMcpSessionStore>,
    identity: WorkOSIdentityDeps,
  ): ((request: Request) => Promise<Response>) =>
  async (request) => {
    const principal = await Effect.runPromise(
      resolveBrowserPrincipal(identity, request).pipe(Effect.orElseSucceed(() => null)),
    );
    if (!principal) return jsonResponse({ error: "Unauthorized" }, 401);
    return (
      (await store.handlePausedRequest(request, principal)) ??
      (await store.handleApprovalRequest(request, principal)) ??
      jsonResponse({ error: "Not found" }, 404)
    );
  };

export const makeSelfHostMcpSeams = (
  dbHandle: SelfHostDbHandle,
  identity: WorkOSIdentityDeps,
  webBaseUrl?: string,
): SelfHostMcpSeams => {
  const sessionStore = makeSelfHostMcpSessionStore(dbHandle, webBaseUrl);
  return {
    auth: makeSelfHostMcpAuth(identity),
    sessions: selfHostMcpSessions(sessionStore),
    reporter: selfHostMcpReporter,
    approvalHandler: makeApprovalHandler(sessionStore, identity),
    close: sessionStore.close,
  };
};
