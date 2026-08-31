import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { claimAndBoot } from "../src/ports";
import { RUNS_DIR } from "../src/scenario";
import { bootSelfhostWorkos } from "./selfhost-workos.boot";

const logFile = process.env.E2E_VERBOSE
  ? undefined
  : resolve(RUNS_DIR, "selfhost-workos", "server-logs", "boot.log");

export default async function setup(): Promise<() => Promise<void>> {
  if (logFile) mkdirSync(resolve(logFile, ".."), { recursive: true });
  const booted = await claimAndBoot(
    [
      { envVar: "E2E_SELFHOST_WORKOS_PORT", offset: 14, label: "selfhost WorkOS app" },
      { envVar: "E2E_SELFHOST_WORKOS_EMULATOR_PORT", offset: 15, label: "WorkOS M2M emulator" },
    ],
    async (ports) => {
      const dataDir = resolve(import.meta.dirname, "../../apps/host-selfhost/.e2e-data-workos");
      const value = await bootSelfhostWorkos({
        appPort: ports.E2E_SELFHOST_WORKOS_PORT!,
        workosPort: ports.E2E_SELFHOST_WORKOS_EMULATOR_PORT!,
        dataDir,
        logFile,
      });
      return { teardown: value.teardown, value };
    },
    { label: "selfhost-workos" },
  );

  process.env.E2E_SELFHOST_WORKOS_URL = booted.value.baseUrl;
  process.env.E2E_SELFHOST_WORKOS_AUTH_URL = booted.value.workosUrl;
  process.env.E2E_SELFHOST_WORKOS_API_KEY = booted.value.workosApiKey;
  process.env.E2E_SELFHOST_WORKOS_DB_PATH = booted.value.dbPath;
  return booted.teardown;
}
