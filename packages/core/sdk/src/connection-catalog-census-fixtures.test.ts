import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  CONNECTION_CATALOG_CENSUS_GOLDEN_BINDING,
  CONNECTION_CATALOG_CENSUS_GOLDEN_OBSERVED_AT,
  CONNECTION_CATALOG_CENSUS_GOLDEN_REQUEST,
  CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT,
  CONNECTION_CATALOG_CENSUS_GOLDEN_SOURCE,
  finalizeConnectionCatalogCensus,
  type ConnectionCatalogCensusSource,
} from "./index";

describe("connection catalog census conformance golden", () => {
  it.effect("matches the hash-only finalized result", () =>
    Effect.gen(function* () {
      const actual = yield* finalizeConnectionCatalogCensus({
        request: CONNECTION_CATALOG_CENSUS_GOLDEN_REQUEST,
        source: CONNECTION_CATALOG_CENSUS_GOLDEN_SOURCE,
        observedAt: CONNECTION_CATALOG_CENSUS_GOLDEN_OBSERVED_AT,
      });

      expect(actual).toEqual(CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT);
    }),
  );

  it.effect("changes the description, descriptor, and catalog hashes on semantic drift", () =>
    Effect.gen(function* () {
      const changedSource: ConnectionCatalogCensusSource = {
        ...CONNECTION_CATALOG_CENSUS_GOLDEN_SOURCE,
        pages: CONNECTION_CATALOG_CENSUS_GOLDEN_SOURCE.pages.map((page) => ({
          ...page,
          descriptors: page.descriptors.map((descriptor) => ({
            ...descriptor,
            description: "List public records with labels.",
          })),
        })),
      };
      const changed = yield* finalizeConnectionCatalogCensus({
        request: CONNECTION_CATALOG_CENSUS_GOLDEN_REQUEST,
        source: changedSource,
        observedAt: CONNECTION_CATALOG_CENSUS_GOLDEN_OBSERVED_AT,
      });

      const baselineDescriptor = CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT.descriptors[0];
      const changedDescriptor = changed.descriptors[0];
      expect(changed.bindingSha256).toBe(CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT.bindingSha256);
      expect(changedDescriptor?.descriptionSha256).not.toBe(baselineDescriptor?.descriptionSha256);
      expect(changedDescriptor?.annotationsSha256).toBe(baselineDescriptor?.annotationsSha256);
      expect(changedDescriptor?.inputSchemaSha256).toBe(baselineDescriptor?.inputSchemaSha256);
      expect(changedDescriptor?.outputSchemaSha256).toBe(baselineDescriptor?.outputSchemaSha256);
      expect(changedDescriptor?.definitionsSha256).toBe(baselineDescriptor?.definitionsSha256);
      expect(changedDescriptor?.descriptorSha256).not.toBe(baselineDescriptor?.descriptorSha256);
      expect(changed.catalogSha256).not.toBe(CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT.catalogSha256);
    }),
  );

  it("keeps the golden binding fixture exact and credential-free", () => {
    expect(CONNECTION_CATALOG_CENSUS_GOLDEN_BINDING).toMatchObject({
      address: "tools.acme.org.primary",
      owner: "org",
      integration: "acme",
      credentialProvider: "vault",
      subject: null,
    });
    expect(JSON.stringify(CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT)).not.toMatch(
      /ghp_|sk-|bearer\s/i,
    );
  });
});
