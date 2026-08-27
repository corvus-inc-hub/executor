import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { HostConfig } from "@executor-js/api/server";

import { SelfHostHostConfig } from "./execution";

it.effect("requires and wires a server-signed OAuth correlation verifier", () =>
  Effect.gen(function* () {
    const config = yield* HostConfig;
    expect(config.requireOAuthCorrelation).toBe(true);
    expect(config.verifyOAuthCorrelation).toBeDefined();
  }).pipe(Effect.provide(SelfHostHostConfig)),
);
