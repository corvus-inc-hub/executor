import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Official @workos/emulate 0.11.0 plus the exact client-id readback change
// reviewed at github.com/workos/emulate/pull/92 commit
// 163f02651d0ba4d20847e5e3e9e1896070b84ab4. The root patchedDependency
// applies that upstream diff to the published package.
import { createEmulator } from "@workos/emulate";

import { bootProcesses, waitForHttp } from "./boot";
import {
  M2M_CLIENT_ID,
  M2M_CLIENT_SECRET,
  M2M_SCOPE,
  WORKOS_CUSTOMER_ORG_ID,
  WORKOS_FORBIDDEN_ORG_ID,
  WORKOS_PLATFORM_ORG_ID,
  WORKOS_USER_EMAIL,
  WORKOS_USER_ID,
} from "../targets/selfhost-workos";

const selfhostDir = fileURLToPath(new URL("../../apps/host-selfhost/", import.meta.url));

export interface SelfhostWorkosBootOptions {
  readonly appPort: number;
  readonly workosPort: number;
  readonly dataDir: string;
  readonly logFile?: string;
}

export const bootSelfhostWorkos = async (options: SelfhostWorkosBootOptions) => {
  rmSync(options.dataDir, { recursive: true, force: true });
  const baseUrl = `http://localhost:${options.appPort}`;
  const dbPath = resolve(options.dataDir, "data.db");
  const workos = await createEmulator({
    port: options.workosPort,
    seed: {
      users: [
        {
          id: WORKOS_USER_ID,
          email: WORKOS_USER_EMAIL,
          password: "manifest-e2e-password",
          email_verified: true,
        },
      ],
      organizations: [
        { id: WORKOS_PLATFORM_ORG_ID, name: "Manifest Platform" },
        {
          id: WORKOS_CUSTOMER_ORG_ID,
          name: "Manifest Delivery E2E",
          memberships: [{ email: WORKOS_USER_EMAIL, role: "admin", status: "active" }],
        },
        { id: WORKOS_FORBIDDEN_ORG_ID, name: "Unrelated Customer" },
      ],
      connectApplications: [
        {
          name: "Manifest Trigger",
          type: "m2m",
          organization: "Manifest Platform",
          scopes: [M2M_SCOPE, "connections:handoff"],
          client_id: M2M_CLIENT_ID,
          client_secret: M2M_CLIENT_SECRET,
          audience: "client_executor_selfhost",
        },
      ],
    },
  });

  const env = {
    EXECUTOR_DATA_DIR: options.dataDir,
    EXECUTOR_DB_PATH: dbPath,
    EXECUTOR_SECRET_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    EXECUTOR_WEB_BASE_URL: baseUrl,
    EXECUTOR_CONNECTION_RETURN_ORIGINS: baseUrl,
    EXECUTOR_ALLOW_LOCAL_NETWORK: "true",
    EXECUTOR_AUTH_PROVIDER: "workos-authkit",
    WORKOS_API_KEY: workos.apiKey,
    WORKOS_CLIENT_ID: "client_executor_selfhost",
    WORKOS_COOKIE_PASSWORD: "manifest_e2e_cookie_password_0123456789abcdef",
    WORKOS_API_URL: workos.url,
    WORKOS_AUTHKIT_DOMAIN: workos.url,
    WORKOS_REDIRECT_URI: `${baseUrl}/api/auth/callback`,
    WORKOS_SERVICE_ORGANIZATION_ID: WORKOS_PLATFORM_ORG_ID,
    WORKOS_ALLOWED_ORGANIZATION_IDS: WORKOS_CUSTOMER_ORG_ID,
    WORKOS_CONNECT_AUDIENCE: "client_executor_selfhost",
    WORKOS_M2M_ALLOWED_CLIENT_IDS: M2M_CLIENT_ID,
    WORKOS_CREDENTIAL_LEASE_SCOPE: M2M_SCOPE,
  };

  const processes = bootProcesses(
    [
      {
        cmd: "bunx",
        args: ["--bun", "vite", "dev", "--port", String(options.appPort), "--strictPort"],
        cwd: selfhostDir,
        env,
        logFile: options.logFile,
      },
    ],
    { label: "selfhost-workos" },
  );

  const teardown = async () => {
    await processes.teardown();
    await workos.close();
  };

  try {
    await waitForHttp(baseUrl);
    await waitForHttp(`${baseUrl}/api/auth/login`, { expectRedirect: true });
  } catch (error) {
    await teardown();
    throw error;
  }

  return { baseUrl, dbPath, workosUrl: workos.url, workosApiKey: workos.apiKey, teardown };
};
