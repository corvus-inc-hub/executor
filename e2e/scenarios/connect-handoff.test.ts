// A production-shaped hosted connection handoff. The service creates the
// member-bound handoff over Executor's HTTP API; the browser user can only
// observe and complete it. The retired model-callable createHandoff tool is
// deliberately absent from this journey.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator, type EmulatorClient } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug, type ConnectionRef } from "@executor-js/sdk/shared";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, ServiceIdentity, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";
import type { BrowserSurface } from "../src/surfaces/browser";
import type { ApiSurface } from "../src/surfaces/api";

const api = composePluginApi([openApiHttpPlugin()] as const);
const unique = (prefix: string) =>
  IntegrationSlug.make(`${prefix}_${randomBytes(4).toString("hex")}`);

const emulator = Effect.gen(function* () {
  const baseUrl = yield* createEmulatorInstance("resend", "connect-handoff");
  return yield* Effect.promise(() => connectEmulator({ baseUrl }));
});

const mintEmulatorApiKey = (client: EmulatorClient) =>
  Effect.gen(function* () {
    const credential = yield* Effect.promise(() => client.credentials.mint({ type: "api-key" }));
    if (!credential.token) {
      return yield* Effect.die(`emulator credential mint failed: ${JSON.stringify(credential)}`);
    }
    return credential.token;
  });

scenario(
  "Connect · the service-created handoff opens this deployment and the bound user completes it",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const newServiceIdentity = yield* ServiceIdentity;
    const { client: makeApiClient } = yield* Api;

    const integration = unique("resendhf");
    const emulatorClient = yield* emulator;
    const apiKey = yield* mintEmulatorApiKey(emulatorClient);
    const user = yield* target.newIdentity();
    const service = yield* newServiceIdentity({ scopes: ["connections:handoff"] });
    const userClient = yield* makeApiClient(api, user);
    const settlement: { connection?: ConnectionRef } = {};

    yield* runScenario({
      target,
      browser,
      user,
      service,
      integration,
      apiKey,
      emulatorClient,
      makeApiClient,
      settlement,
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (settlement.connection) {
            yield* userClient.connections
              .remove({ params: settlement.connection })
              .pipe(Effect.ignore);
          }
          yield* userClient.openapi
            .removeSpec({ params: { slug: integration } })
            .pipe(Effect.ignore);
        }).pipe(Effect.ignore),
      ),
    );
  }),
);

const runScenario = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly user: Identity;
  readonly service: Identity;
  readonly integration: IntegrationSlug;
  readonly apiKey: string;
  readonly emulatorClient: EmulatorClient;
  readonly makeApiClient: ApiSurface["client"];
  readonly settlement: { connection?: ConnectionRef };
}) =>
  Effect.gen(function* () {
    const {
      target,
      browser,
      user,
      service,
      integration,
      apiKey,
      emulatorClient,
      makeApiClient,
      settlement,
    } = input;
    expect(user.subject, "the browser identity has an exact WorkOS member subject").toBeTruthy();

    const serviceClient = yield* makeApiClient(api, service);
    const userClient = yield* makeApiClient(api, user);
    yield* userClient.openapi.addSpec({
      payload: {
        spec: { kind: "url", url: emulatorClient.openapiUrl },
        slug: integration,
      },
    });

    const accountClient = yield* makeApiClient(AccountHttpApi, user);
    const me = yield* accountClient.account.me();
    const orgSlug = me.organization?.slug;
    expect(orgSlug, "the service is scoped to the exact customer organization").toBeTruthy();

    const returnTo = new URL(`/${orgSlug}/integrations/${integration}`, target.baseUrl).toString();
    const handoff = yield* serviceClient.connections.createHandoff({
      payload: {
        memberId: user.subject!,
        integration,
        label: "Resend (emulated)",
        returnTo,
      },
    });
    expect(handoff.status).toBe("pending");
    expect(handoff.memberId).toBe(user.subject);
    expect(new URL(handoff.url).origin).toBe(new URL(target.baseUrl).origin);
    expect(new URL(handoff.url).pathname).toBe(`/${orgSlug}/connect/${handoff.handoffId}`);

    yield* browser.session(user, async ({ page, step }) => {
      await step("Open the service-created handoff URL", async () => {
        await page.goto(handoff.url, { waitUntil: "networkidle" });
      });
      await step("The Add connection modal is open", async () => {
        await page.getByRole("heading", { name: /Add connection/ }).waitFor({ timeout: 15_000 });
      });
      await step("Paste the provider credential", async () => {
        const credential = page.getByRole("dialog").getByRole("textbox", { name: "Authorization" });
        await credential.waitFor({ timeout: 15_000 });
        await credential.fill(apiKey);
      });
      await step("Complete the handoff", async () => {
        await page.getByRole("button", { name: "Continue" }).click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Add connection", exact: true })
          .click();
        await page
          .getByRole("heading", { name: /Add connection/ })
          .waitFor({ state: "hidden", timeout: 20_000 });
        await page.waitForURL(returnTo, { timeout: 20_000, waitUntil: "networkidle" });
        await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 20_000 });
      });
    });

    const completed = yield* serviceClient.connections.getHandoff({
      params: { handoffId: handoff.handoffId },
    });
    expect(completed.status, "the service observes terminal settlement").toBe("completed");
    if (completed.status !== "completed") return yield* Effect.die("handoff did not complete");
    settlement.connection = completed.receipt.connection;
    expect(completed.receipt).toMatchObject({
      schema: "executor.connection-handoff.receipt.v1",
      memberId: user.subject,
      readback: { connectionPresent: true },
    });
    const saved = yield* userClient.connections.get({ params: completed.receipt.connection });
    expect(saved.integration).toBe(integration);
    expect(saved.owner).toBe("user");
    expect(
      JSON.stringify(saved),
      "the saved projection never returns the provider secret",
    ).not.toContain(apiKey);
  });
