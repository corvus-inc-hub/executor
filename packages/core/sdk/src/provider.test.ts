import { describe, expect, it } from "@effect/vitest";

import { Owner, ProviderItemId } from "./ids";
import { ownerForProviderItem, providerItemOwner } from "./provider";

describe("provider item ownership", () => {
  it.each([
    ["connection:org:github:main:token", "org"],
    ["oauth:org:github:main", "org"],
    ["oauth-client:org:github-prod:secret", "org"],
    ["connection:user:github:main:token", "user"],
    ["oauth:user:github:main", "user"],
    ["oauth-client:user:github-prod:secret", "user"],
  ] as const)("reads the owner embedded in %s", (itemId, expected) => {
    expect(providerItemOwner(ProviderItemId.make(itemId))).toBe(expected);
  });

  it("returns null for opaque and malformed provider item ids", () => {
    expect(providerItemOwner(ProviderItemId.make("opaque"))).toBeNull();
    expect(providerItemOwner(ProviderItemId.make("oauth-client:team:github:secret"))).toBeNull();
  });

  it("falls back to the caller partition only when the item carries no owner", () => {
    expect(ownerForProviderItem(ProviderItemId.make("opaque"), Owner.make("user"))).toBe("user");
    expect(
      ownerForProviderItem(
        ProviderItemId.make("oauth-client:org:github-prod:secret"),
        Owner.make("user"),
      ),
    ).toBe("org");
  });
});
