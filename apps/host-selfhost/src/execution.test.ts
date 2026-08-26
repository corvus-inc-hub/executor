import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { HostConfig } from "@executor-js/api/server";

import { SelfHostHostConfig } from "./execution";

it.effect("fails closed until self-host wires a server-signed OAuth correlation authority", () =>
  Effect.gen(function* () {
    const config = yield* HostConfig;
    expect(config.requireOAuthCorrelation).toBe(true);
    expect(config.verifyOAuthCorrelation).toBeUndefined();
  }).pipe(Effect.provide(SelfHostHostConfig)),
);
