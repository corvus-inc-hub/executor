import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { InternalError } from "@executor-js/sdk/shared";
import { ExecuteOperationRequest, ExecuteOperationResult } from "@executor-js/sdk/shared";

/** Carrier-neutral operation endpoint. The HTTP adapter supplies the carrier
 * identity; callers cannot choose a target tool or provider transport. */
export const OperationsApi = HttpApiGroup.make("operations").add(
  HttpApiEndpoint.post("execute", "/operations", {
    payload: ExecuteOperationRequest,
    success: ExecuteOperationResult,
    error: InternalError,
  }),
);
