import { describe, expect, it } from "@effect/vitest";

import { parseConnectionReturnOrigins } from "./config";

describe("connection handoff return origins", () => {
  it("normalizes a comma-separated exact-origin allowlist", () => {
    expect(
      parseConnectionReturnOrigins(" https://manifest.example,https://customer.example:8443 "),
    ).toEqual(["https://manifest.example", "https://customer.example:8443"]);
  });

  it("rejects entries with a path, query, or fragment", () => {
    expect(() => parseConnectionReturnOrigins("https://manifest.example/return")).toThrowError(
      /must contain only exact HTTP\(S\) origins/,
    );
  });
});
