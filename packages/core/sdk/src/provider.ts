import type { Effect } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import { Owner, type ProviderItemId, type ProviderKey } from "./ids";

const OWNER_SCOPED_ITEM_PREFIXES: ReadonlySet<string> = new Set([
  "connection",
  "oauth",
  "oauth-client",
]);

/** The logical owner carried by a core credential item id. Provider backends
 *  use this instead of the acting caller when deciding where shared material
 *  belongs. Opaque third-party item ids return null. */
export const providerItemOwner = (id: ProviderItemId): Owner | null => {
  const [prefix, embeddedOwner] = String(id).split(":");
  if (!OWNER_SCOPED_ITEM_PREFIXES.has(prefix ?? "")) return null;
  if (embeddedOwner === "org" || embeddedOwner === "user") return Owner.make(embeddedOwner);
  return null;
};

/** Resolve an item's embedded owner, falling back to the active executor
 *  binding only for ids that do not carry a core ownership segment. */
export const ownerForProviderItem = (id: ProviderItemId, fallback: Owner): Owner =>
  providerItemOwner(id) ?? fallback;

/* Where a credential's value actually lives — the v2 successor to v1's
 * `SecretProvider`. The default store holds pasted values; external backends
 * (1Password, keychain, workos-vault) resolve an opaque `id` on demand — the
 * value never lands in our core storage. Core never knows how the id is shaped;
 * only the provider interprets it. Registered alongside the executor, a separate
 * axis from integration plugins. No `scope` arg — the connection row owns the
 * (tenant, owner, subject) partition; the provider sees only an opaque id. */

export interface ProviderEntry {
  /** The provider's own opaque handle for this entry. Surfaced for discovery so
   *  a connection can reference it without core knowing its internal shape. */
  readonly id: ProviderItemId;
  readonly name: string;
}

export interface CredentialProvider {
  readonly key: ProviderKey;
  /** If false, we never write here — `set`/`delete` are skipped and a referenced
   *  connection's `remove` only drops our routing, leaving the item intact. */
  readonly writable: boolean;
  /** Resolve a value by opaque id. The single hop a credential goes through
   *  before its template is applied. The provider interprets the id. */
  readonly get: (id: ProviderItemId) => Effect.Effect<string | null, StorageFailure>;
  readonly has?: (id: ProviderItemId) => Effect.Effect<boolean, StorageFailure>;
  readonly set?: (id: ProviderItemId, value: string) => Effect.Effect<void, StorageFailure>;
  readonly delete?: (id: ProviderItemId) => Effect.Effect<void, StorageFailure>;
  /** Browse entries for discovery (pick a 1Password item). Optional — some
   *  backends can't enumerate. */
  readonly list?: () => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
}
