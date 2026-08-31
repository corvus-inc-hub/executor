import { describe, expect, it } from "@effect/vitest";

import { cloudHostConfigFromEnv } from "./execution-stack";

describe("cloud connection handoff return origins", () => {
  it("threads a canonical exact-origin allowlist into HostConfig", () => {
    expect(
      cloudHostConfigFromEnv({
        VITE_PUBLIC_SITE_URL: "https://executor.example",
        EXECUTOR_CONNECTION_RETURN_ORIGINS:
          " https://manifest.example/,https://customer.example:8443 ",
      }),
    ).toMatchObject({
      webBaseUrl: "https://executor.example",
      connectionReturnOrigins: ["https://manifest.example", "https://customer.example:8443"],
    });
  });

  it("fails closed when the allowlist is missing or not exact", () => {
    expect(cloudHostConfigFromEnv({}).connectionReturnOrigins).toEqual([]);
    expect(() =>
      cloudHostConfigFromEnv({
        EXECUTOR_CONNECTION_RETURN_ORIGINS: "https://manifest.example/return",
      }),
    ).toThrowError(/must contain only exact HTTP\(S\) origins/);
  });
});
