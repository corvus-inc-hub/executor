import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { SystemError, SystemHttpApi } from "./api";

export const SystemHandlers = HttpApiBuilder.group(SystemHttpApi, "system", (handlers) =>
  handlers.handle("health", () =>
    Effect.gen(function* () {
      const { client } = yield* SelfHostDb;
      const status = yield* Effect.tryPromise({
        try: () => client.execute("SELECT 1"),
        catch: () => new SystemError({ message: "database unreachable" }),
      }).pipe(
        Effect.as("ok"),
        Effect.orElseSucceed(() => "degraded"),
      );
      return { status };
    }),
  ),
);

export const makeSelfHostSystemApiLayer = ({
  db,
  mountPrefix,
}: {
  readonly db: SelfHostDbHandle;
  readonly mountPrefix: `/${string}`;
}) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  return HttpApiBuilder.layer(SystemHttpApi).pipe(
    Layer.provide(SystemHandlers),
    Layer.provide(prefixedRouter),
    HttpRouter.provideRequest(Layer.succeed(SelfHostDb)(db)),
  );
};
