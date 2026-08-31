import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenariosRoot = join(e2eRoot, "scenarios");
const retiredScenario = "connect-handoff-session.test.ts";
const retiredModelTool = "coreTools.connections.createHandoff";

describe("hosted connection handoff legacy absence", () => {
  it("keeps the retired model-callable handoff journey out of the scenario corpus", () => {
    expect(existsSync(join(scenariosRoot, retiredScenario))).toBe(false);

    const offenders = readdirSync(scenariosRoot)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => readFileSync(join(scenariosRoot, name), "utf8").includes(retiredModelTool));

    expect(offenders).toEqual([]);
  });

  it("keeps the desk on the production-shaped WorkOS journey", () => {
    for (const path of [join(e2eRoot, "desk", "run.sh"), join(e2eRoot, "desk", "entry.sh")]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain(retiredScenario);
      expect(source).toContain("scenarios/connect-handoff.test.ts");
      expect(source).toContain("selfhost-workos");
    }
  });
});
