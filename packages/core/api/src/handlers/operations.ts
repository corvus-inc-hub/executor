import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { capture } from "@executor-js/api";
import { InternalError } from "@executor-js/sdk/shared";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

/**
 * HTTP is only a carrier. All target resolution, policy/approval, credential
 * ordering, replay reservation, and provider evidence stay in Executor.
 */
export const OperationsHandlers = HttpApiBuilder.group(ExecutorApi, "operations", (handlers) =>
  handlers.handle("execute", ({ payload }) =>
    capture(
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        return yield* executor.executeOperation(payload, "http");
      }),
    ).pipe(
      // Provider/tool failures are represented in the attested result. Any
      // failure that escapes that boundary is an opaque HTTP defect.
      Effect.mapError(() => new InternalError({ traceId: "" })),
    ),
  ),
);
