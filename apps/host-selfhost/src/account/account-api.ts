import { accountProviderMiddlewareLayer } from "@executor-js/api/server";

import { makeWorkOSAccountProvider, type WorkOSAccountDeps } from "./workos-account-provider";

export const selfHostAccountMiddleware = (deps: WorkOSAccountDeps) =>
  accountProviderMiddlewareLayer(makeWorkOSAccountProvider(deps));
