import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import type { HttpApiGroup } from "effect/unstable/httpapi";

import { ToolsApi } from "./tools/api";
import { IntegrationsApi } from "./integrations/api";
import { ConnectionsApi } from "./connections/api";
import { ProvidersApi } from "./providers/api";
import { ExecutionsApi } from "./executions/api";
import { OAuthApi } from "./oauth/api";
import { PoliciesApi } from "./policies/api";
import { OperationsApi } from "./operations/api";

export const CoreExecutorApi = HttpApi.make("executor")
  .add(ToolsApi)
  .add(IntegrationsApi)
  .add(ConnectionsApi)
  .add(ProvidersApi)
  .add(ExecutionsApi)
  .add(OAuthApi)
  .add(PoliciesApi)
  .annotateMerge(
    OpenApi.annotations({
      title: "Executor API",
      description: "Tool execution platform API",
    }),
  );

/** Default API. It intentionally has no operation route. */
export const ExecutorApi = CoreExecutorApi;

/** Explicit opt-in API for a host that has configured operation definitions and
 * a replay ledger. This is kept separate so generic production composition
 * cannot advertise `execute_operation` accidentally. */
export const OperationExecutorApi = CoreExecutorApi.add(OperationsApi);

/**
 * Compose the core API with a plugin group.
 */
export const addGroup = <G extends HttpApiGroup.Any>(group: G) => CoreExecutorApi.add(group);
