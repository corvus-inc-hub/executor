import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { HostConfig } from "@executor-js/api/server";

import { loadConfig, type CloudflareEnv } from "./config";
import { makeCloudflareHostConfig } from "./execution";

const env = (overrides: Partial<CloudflareEnv> = {}): CloudflareEnv =>
  ({
    DB: {},
    MCP_SESSION: {},
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "audience",
    EXECUTOR_SECRET_KEY: "0123456789abcdef",
    ENABLE_DEV_AUTH: "true",
    ...overrides,
  }) as CloudflareEnv;

describe("Cloudflare connection handoff return origins", () => {
  it("loads a canonical exact-origin allowlist", () => {
    expect(
      loadConfig(
        env({
          EXECUTOR_CONNECTION_RETURN_ORIGINS:
            " https://manifest.example/,https://customer.example:8443 ",
        }),
      ).connectionReturnOrigins,
    ).toEqual(["https://manifest.example", "https://customer.example:8443"]);
  });

  it.effect("passes the parsed allowlist into the shared HostConfig seam", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = loadConfig(
          env({ EXECUTOR_CONNECTION_RETURN_ORIGINS: "https://manifest.example" }),
        );
        const context = yield* Layer.build(makeCloudflareHostConfig(config));
        expect(Context.get(context, HostConfig).connectionReturnOrigins).toEqual([
          "https://manifest.example",
        ]);
      }),
    ),
  );

  it("fails closed when the allowlist is missing or not exact", () => {
    expect(loadConfig(env()).connectionReturnOrigins).toEqual([]);
    expect(() =>
      loadConfig(env({ EXECUTOR_CONNECTION_RETURN_ORIGINS: "https://manifest.example/return" })),
    ).toThrowError(/must contain only exact HTTP\(S\) origins/);
  });
});
