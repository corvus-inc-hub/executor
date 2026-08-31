import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(e2eRoot, "../.github/workflows/ci.yml"), "utf8");

const jobSource = (name: string): string => {
  const match = new RegExp(`\\n  ${name}:[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`).exec(workflow);
  expect(match, `${name} is a permanent CI job`).not.toBeNull();
  return match?.[0] ?? "";
};

describe("Manifest selfhost-workos PR acceptance", () => {
  it("runs the production-shaped target on Manifest pull requests", () => {
    const job = jobSource("manifest-selfhost-workos");

    expect(job).toContain(
      "if: github.repository == 'manifest-platform/executor' && github.event_name == 'pull_request'",
    );
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain("id: acceptance");
    expect(job).toContain("run: bunx vitest run --project selfhost-workos");
    expect(job).not.toContain("--retry");
    expect(job).not.toContain("fixtures/");
    expect(job).not.toContain("connect-handoff-session.test.ts");
    expect(job).not.toContain("--passWithNoTests");
  });

  it("rejects traces and publishes only masked browser media", () => {
    const job = jobSource("manifest-selfhost-workos");

    expect(job).toContain("name: Reject credential-bearing browser artifacts");
    expect(job).toContain("-name 'trace.zip'");
    expect(job).toContain("name: Require browser evidence after accepted handoff");
    expect(job).toContain("if: steps.acceptance.outcome == 'success'");
    expect(job).toContain("-name '*.png'");
    expect(job).toContain("name: manifest-selfhost-workos-browser-evidence");
    const uploadPaths = /          path: \|\n((?:            .+\n)+)/
      .exec(job)?.[1]
      ?.trim()
      .split("\n")
      .map((line) => line.trim());
    expect(uploadPaths, "the artifact contains only masked screenshots and video").toEqual([
      "e2e/runs/selfhost-workos/**/*.png",
      "e2e/runs/selfhost-workos/**/session.mp4",
      "e2e/runs/selfhost-workos/**/session.webm",
    ]);
    expect(job).toContain("if-no-files-found: ignore");
  });
});
