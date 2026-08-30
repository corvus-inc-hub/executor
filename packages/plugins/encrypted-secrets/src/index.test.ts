import { Effect, Exit } from "effect";
import { describe, expect, test } from "@effect/vitest";

import { Owner, ProviderItemId, type CredentialProvider, type PluginCtx } from "@executor-js/sdk";

import { decryptSecret, deriveKey, encryptSecret, encryptedSecretsPlugin } from "./index";

// ---------------------------------------------------------------------------
// In-memory PluginStorageFacade fake (owner-partitioned), enough to exercise
// the provider exactly as the executor's plugin-storage table would: rows are
// keyed by (owner, collection, key); `get` is not owner-filtered and searches
// the user partition before the org one (the executor's read precedence),
// while `put`/`remove` target exactly the owner they are handed.
//
// v2: the provider keys values by the opaque `ProviderItemId` (the storage
// `key`); the connection row that references the id owns the partition.
// ---------------------------------------------------------------------------

const READ_OWNERS: readonly Owner[] = [Owner.make("user"), Owner.make("org")];

const makeFakeStorage = () => {
  const rows = new Map<string, { owner: Owner; key: string; collection: string; data: unknown }>();
  const composite = (owner: Owner, collection: string, key: string) =>
    `${owner} ${collection} ${key}`;
  const toEntry = (row: { owner: Owner; key: string; collection: string; data: unknown }) => ({
    id: composite(row.owner, row.collection, row.key),
    owner: row.owner,
    pluginId: "encryptedSecrets",
    collection: row.collection,
    key: row.key,
    data: row.data,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const visible = (collection: string, key: string) => {
    for (const owner of READ_OWNERS) {
      const row = rows.get(composite(owner, collection, key));
      if (row) return row;
    }
    return null;
  };
  const facade = {
    get: (input: { collection: string; key: string }) =>
      Effect.sync(() => {
        const row = visible(input.collection, input.key);
        return row ? (toEntry(row) as never) : null;
      }),
    getForOwner: (input: { collection: string; key: string; owner: Owner }) =>
      Effect.sync(() => {
        const row = rows.get(composite(input.owner, input.collection, input.key));
        return row ? (toEntry(row) as never) : null;
      }),
    list: (input: { collection: string }) =>
      Effect.sync(
        () =>
          [...rows.values()]
            .filter((row) => row.collection === input.collection)
            .map((row) => toEntry(row)) as never,
      ),
    put: (input: { collection: string; key: string; owner: Owner; data: unknown }) =>
      Effect.sync(() => {
        const row = {
          owner: input.owner,
          key: input.key,
          collection: input.collection,
          data: input.data,
        };
        rows.set(composite(input.owner, input.collection, input.key), row);
        return toEntry(row) as never;
      }),
    remove: (input: { collection: string; key: string; owner: Owner }) =>
      Effect.sync(() => {
        rows.delete(composite(input.owner, input.collection, input.key));
      }),
  };
  return { facade, rows };
};

const makeProvider = (key: string, owner: Owner = Owner.make("org")) => {
  const { facade, rows } = makeFakeStorage();
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: minimal PluginCtx fake for the provider under test
  const ctx = {
    owner: {
      tenant: "tenant-a",
      subject: owner === Owner.make("user") ? "subject-a" : null,
    },
    pluginStorage: facade,
  } as unknown as PluginCtx<unknown>;
  const plugin = encryptedSecretsPlugin({ key });
  const credentialProviders = plugin.credentialProviders as (
    ctx: PluginCtx<unknown>,
  ) => readonly CredentialProvider[];
  const provider = credentialProviders(ctx)[0]!;
  return { provider, rows };
};

const id = (value: string) => ProviderItemId.make(value);

const expectFailure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
};

describe("crypto", () => {
  test("round-trips through encrypt/decrypt", async () => {
    const key = deriveKey("master-key-1");
    const payload = await Effect.runPromise(encryptSecret(key, "ghp_secret_value"));
    expect(payload.startsWith("v1.")).toBe(true);
    const back = await Effect.runPromise(decryptSecret(key, payload));
    expect(back).toBe("ghp_secret_value");
  });

  test("a different key cannot decrypt", async () => {
    const payload = await Effect.runPromise(encryptSecret(deriveKey("key-a"), "value"));
    await expectFailure(decryptSecret(deriveKey("key-b"), payload));
  });

  test("tampered ciphertext fails the auth tag", async () => {
    const key = deriveKey("master-key-1");
    const payload = await Effect.runPromise(encryptSecret(key, "value"));
    const parts = payload.split(".");
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      Buffer.from("tampered").toString("base64"),
    ].join(".");
    await expectFailure(decryptSecret(key, tampered));
  });
});

describe("provider", () => {
  test("set then get returns the plaintext", async () => {
    const { provider } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("github"), "ghp_xyz"));
    const got = await Effect.runPromise(provider.get(id("github")));
    expect(got).toBe("ghp_xyz");
  });

  test("stores ciphertext at rest, not plaintext", async () => {
    const { provider, rows } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("github"), "ghp_plaintext"));
    const stored = String([...rows.values()][0]!.data);
    expect(stored).not.toContain("ghp_plaintext");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  // removed: "a secret in one scope is invisible to another scope" — v2 drops
  // the scope arg entirely. The provider keys solely by the opaque
  // `ProviderItemId`; the referencing connection row owns the (tenant, owner,
  // subject) partition, so cross-scope isolation is no longer the provider's
  // concern to enforce or test.

  test("get returns null for a missing id", async () => {
    const { provider } = makeProvider("master");
    expect(await Effect.runPromise(provider.get(id("absent")))).toBeNull();
  });

  test("has and delete reflect presence", async () => {
    const { provider } = makeProvider("master");
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
    await Effect.runPromise(provider.set!(id("k"), "v"));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(true);
    await Effect.runPromise(provider.delete!(id("k")));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
    // delete is idempotent and returns void; deleting an absent id is a no-op.
    await Effect.runPromise(provider.delete!(id("k")));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
  });

  test("list surfaces stored ids", async () => {
    const { provider } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("alpha"), "a"));
    await Effect.runPromise(provider.set!(id("beta"), "b"));
    const entries = await Effect.runPromise(provider.list!());
    expect(entries.map((e) => e.id).sort()).toEqual(["alpha", "beta"]);
  });
});
describe("owner-aware item custody", () => {
  test.each([
    "connection:org:github:main:token",
    "oauth:org:github-prod:access_token",
    "oauth-client:org:github-prod:secret",
  ])("a subject-bound service write stores %s in the organization partition", async (itemId) => {
    const { provider, rows } = makeProvider("master", Owner.make("user"));
    await Effect.runPromise(provider.set!(id(itemId), "secret"));

    expect([...rows.values()]).toHaveLength(1);
    expect([...rows.values()][0]!.owner).toBe("org");
    expect(await Effect.runPromise(provider.get(id(itemId)))).toBe("secret");
  });

  test.each([
    "connection:user:github:main:token",
    "oauth:user:github-prod:access_token",
    "oauth-client:user:github-prod:secret",
  ])("a user-owned item %s stays in the user partition", async (itemId) => {
    const { provider, rows } = makeProvider("master", Owner.make("user"));
    await Effect.runPromise(provider.set!(id(itemId), "secret"));

    expect([...rows.values()][0]!.owner).toBe("user");
  });

  test("an organization rewrite removes the subject's stale shadow copy", async () => {
    const itemId = id("oauth-client:org:github-prod:secret");
    const { provider, rows } = makeProvider("master", Owner.make("user"));
    rows.set(`user secrets ${itemId}`, {
      owner: Owner.make("user"),
      key: itemId,
      collection: "secrets",
      data: "v1.stale",
    });

    await Effect.runPromise(provider.set!(itemId, "fresh"));

    expect([...rows.values()]).toHaveLength(1);
    expect([...rows.values()][0]!.owner).toBe("org");
    expect(await Effect.runPromise(provider.get(itemId))).toBe("fresh");
  });

  test("an exact legacy service-user secret is not accepted as organization-ready", async () => {
    const itemId = id("oauth-client:org:github-prod:secret");
    const { provider, rows } = makeProvider("master", Owner.make("user"));
    const legacyPayload = await Effect.runPromise(
      encryptSecret(deriveKey("master"), "managed-client-secret"),
    );
    rows.set(`user secrets ${itemId}`, {
      owner: Owner.make("user"),
      key: itemId,
      collection: "secrets",
      data: legacyPayload,
    });

    expect(await Effect.runPromise(provider.get(itemId))).toBeNull();
    expect(await Effect.runPromise(provider.has!(itemId))).toBe(false);

    await Effect.runPromise(provider.set!(itemId, "managed-client-secret"));

    expect(await Effect.runPromise(provider.get(itemId))).toBe("managed-client-secret");
    expect(rows.has(`org secrets ${itemId}`)).toBe(true);
    expect(rows.has(`user secrets ${itemId}`)).toBe(false);
  });

  test("deleting an organization item clears both the exact row and a stale user shadow", async () => {
    const itemId = id("oauth-client:org:github-prod:secret");
    const { provider, rows } = makeProvider("master", Owner.make("user"));
    rows.set(`org secrets ${itemId}`, {
      owner: Owner.make("org"),
      key: itemId,
      collection: "secrets",
      data: "v1.current",
    });
    rows.set(`user secrets ${itemId}`, {
      owner: Owner.make("user"),
      key: itemId,
      collection: "secrets",
      data: "v1.stale",
    });

    await Effect.runPromise(provider.delete!(itemId));

    expect(rows.size).toBe(0);
  });

  test("an opaque item keeps the subject-derived partition", async () => {
    const { provider, rows } = makeProvider("master", Owner.make("user"));
    await Effect.runPromise(provider.set!(id("opaque"), "secret"));
    expect([...rows.values()][0]!.owner).toBe("user");
  });
});
