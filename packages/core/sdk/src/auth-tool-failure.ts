import { ToolResult, type ToolError } from "./tool-result";

export type AuthToolFailureCode =
  | "connection_value_missing"
  | "connection_rejected"
  | "oauth_connection_missing"
  | "oauth_refresh_failed"
  | "oauth_reauth_required"
  | "oauth_scope_insufficient";

export type AuthToolFailureInput = {
  readonly code: AuthToolFailureCode;
  readonly message: string;
  readonly integration?: {
    readonly id: string;
    readonly scope?: string;
  };
  readonly credential?: {
    readonly kind: "secret" | "oauth" | "upstream";
    readonly label?: string;
    readonly slotKey?: string;
    readonly secretId?: string;
    readonly connectionId?: string;
  };
  readonly status?: number;
  readonly upstream?: {
    readonly status?: number;
    readonly details?: unknown;
  };
  readonly recovery?: {
    readonly configureIntegrationTool?: string;
  };
};

// In v1.5 a connection IS the credential: there is no standalone secret to
// "bind" to an integration afterward. Browser-mediated credentials are owned by
// the host's connection experience; OAuth credentials are minted by the OAuth
// start flow. These strings are read by the agent resolving the failure, so
// they must not advertise service-only APIs as model-callable tools.
const authRecovery = (code: AuthToolFailureCode, input?: AuthToolFailureInput["recovery"]) => {
  // A scope-insufficient rejection cannot be fixed by re-running the same
  // grant, so this branch deliberately omits startOAuthTool/oauthInstructions:
  // an agent following the hints would loop through an identical consent and
  // land on the identical 403. The connection must be reconnected with a
  // broader scope, which is a user decision, not a retryable tool call.
  if (code === "oauth_scope_insufficient") {
    return {
      listConnectionsTool: "executor.coreTools.connections.list",
      ...(input?.configureIntegrationTool
        ? { configureIntegrationTool: input.configureIntegrationTool }
        : {}),
      scopeInstructions:
        "The connection's OAuth grant does not cover the scope this operation requires; re-authenticating with the same grant will return the same error. Tell the user which operation was denied and ask them to reconnect the integration with broader access (or use a connection that already has it). Call listConnectionsTool to see the available connections and their scopes.",
    };
  }
  return {
    startOAuthTool: "executor.coreTools.oauth.start",
    listConnectionsTool: "executor.coreTools.connections.list",
    ...(input?.configureIntegrationTool
      ? { configureIntegrationTool: input.configureIntegrationTool }
      : {}),
    connectionInstructions:
      "For API keys and tokens, ask the user to connect the integration through the Executor-hosted Connections experience. Do not ask the user to paste secrets into chat. Then call listConnectionsTool to confirm the connection exists before retrying this tool.",
    oauthInstructions:
      "For OAuth credentials, call startOAuthTool and give the returned authorizationUrl to the user. The completed connection binds automatically, then retry the tool.",
  };
};

export const authToolFailure = <T = never>(input: AuthToolFailureInput): ToolResult<T> => {
  const error: ToolError = {
    code: input.code,
    message: input.message,
    retryable: false,
    ...(input.status !== undefined ? { status: input.status } : {}),
    details: {
      category: "authentication",
      ...(input.integration ? { integration: input.integration } : {}),
      ...(input.credential ? { credential: input.credential } : {}),
      ...(input.upstream ? { upstream: input.upstream } : {}),
      recovery: authRecovery(input.code, input.recovery),
    },
  };
  return ToolResult.fail(error);
};
