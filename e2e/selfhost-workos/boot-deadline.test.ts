import { createServer } from "node:http";

import { describe, expect, it } from "@effect/vitest";

import { waitForHttp } from "../setup/boot";

describe("production-shaped boot deadline", () => {
  it("aborts a hanging HTTP attempt at the declared readiness deadline", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => response.end("late"), 1_000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    expect(address && typeof address === "object").toBe(true);
    const port = typeof address === "object" && address ? address.port : 0;
    const startedAt = Date.now();
    try {
      await expect(waitForHttp(`http://127.0.0.1:${port}`, { timeoutMs: 50 })).rejects.toThrow(
        /timed out waiting for/,
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
