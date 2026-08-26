import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result, Schema } from "effect";

import {
  ConnectionCatalogCensusDescriptor,
  ConnectionCatalogCensusError,
  ConnectionCatalogCensusRequest,
  ConnectionCatalogCensusResult,
  CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION,
  CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION,
  CONNECTION_CATALOG_CENSUS_MAX_PAGES,
  CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES,
  type ConnectionCatalogCensusBinding,
  type ConnectionCatalogCensusDescriptorInput,
  type ConnectionCatalogCensusInput,
  type ConnectionCatalogCensusSource,
  finalizeConnectionCatalogCensus,
  validateConnectionCatalogCensusInput,
} from "./connection-catalog-census";

const REQUEST: ConnectionCatalogCensusInput = {
  schemaVersion: CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION,
  connectionAddress: "tools.acme.org.primary",
  expectedIntegration: "acme",
  expectedCredentialProvider: "vault",
  refresh: true,
};

const binding = {
  address: "tools.acme.org.primary",
  owner: "org" as const,
  integration: "acme",
  name: "primary",
  credentialProvider: "vault",
  tenant: "tenant-1",
  subject: null,
  template: "api-key",
  generation: "generation-1",
  catalogRevision: "revision-1",
  sourceTransport: "http" as const,
} satisfies ConnectionCatalogCensusBinding;

const descriptor = {
  address: "tools.acme.org.primary.getThing",
  connectionAddress: "tools.acme.org.primary",
  owner: "org",
  integration: "acme",
  name: "getThing",
  description: "Read one thing",
  annotations: { requiresApproval: false, tag: "a" },
  inputSchema: {
    type: "object",
    properties: { token: { type: "string", title: "a" } },
    $ref: "#/$defs/Thing",
  },
  outputSchema: { type: "object", properties: { id: { type: "string", title: "a" } } },
  definitions: {
    Thing: { type: "object", properties: { id: { type: "string", title: "a" } } },
  },
} satisfies ConnectionCatalogCensusDescriptorInput;

const source = (overrides: Partial<ConnectionCatalogCensusSource> = {}) =>
  ({
    binding,
    complete: true,
    pages: [
      {
        cursor: null,
        nextCursor: null,
        generation: "generation-1",
        catalogRevision: "revision-1",
        sourceTransport: "http" as const,
        descriptors: [descriptor],
      },
    ],
    ...overrides,
  }) satisfies ConnectionCatalogCensusSource;

const observedAt = "2026-08-26T00:00:00.000Z";

const sourceForBinding = (
  sourceBinding: ConnectionCatalogCensusBinding,
  descriptors: readonly ConnectionCatalogCensusDescriptorInput[] = [descriptor],
): ConnectionCatalogCensusSource => ({
  binding: sourceBinding,
  complete: true,
  pages: [
    {
      cursor: null,
      nextCursor: null,
      generation: sourceBinding.generation,
      catalogRevision: sourceBinding.catalogRevision,
      sourceTransport: sourceBinding.sourceTransport,
      descriptors,
    },
  ],
});

const pageForBinding = (
  sourceBinding: ConnectionCatalogCensusBinding,
  cursor: string | null,
  nextCursor: string | null,
  descriptors: readonly ConnectionCatalogCensusDescriptorInput[] = [],
) => ({
  cursor,
  nextCursor,
  generation: sourceBinding.generation,
  catalogRevision: sourceBinding.catalogRevision,
  sourceTransport: sourceBinding.sourceTransport,
  descriptors,
});

const descriptorFor = (
  overrides: Partial<ConnectionCatalogCensusDescriptorInput> = {},
): ConnectionCatalogCensusDescriptorInput => ({ ...descriptor, ...overrides });

const descriptorNamed = (name: string): ConnectionCatalogCensusDescriptorInput =>
  descriptorFor({ name, address: `${binding.address}.${name}` });

const expectFailureReason = (
  result: Result.Result<unknown, ConnectionCatalogCensusError>,
  reason: string,
): void => {
  expect(
    Result.match(result, {
      onFailure: (failure) => failure.reason === reason,
      onSuccess: () => false,
    }),
  ).toBe(true);
};

const expectOnlyDescriptorHashChange = (
  baseline: ConnectionCatalogCensusResult,
  changed: ConnectionCatalogCensusResult,
  changedField:
    | "descriptionSha256"
    | "annotationsSha256"
    | "inputSchemaSha256"
    | "outputSchemaSha256"
    | "definitionsSha256",
): void => {
  const baselineDescriptor = baseline.descriptors[0];
  const changedDescriptor = changed.descriptors[0];
  expect(baselineDescriptor).toBeDefined();
  expect(changedDescriptor).toBeDefined();
  if (!baselineDescriptor || !changedDescriptor) return;
  const fields = [
    "descriptionSha256",
    "annotationsSha256",
    "inputSchemaSha256",
    "outputSchemaSha256",
    "definitionsSha256",
  ] as const;
  expect(changedDescriptor[changedField]).not.toBe(baselineDescriptor[changedField]);
  for (const field of fields.filter((field) => field !== changedField)) {
    expect(changedDescriptor[field]).toBe(baselineDescriptor[field]);
  }
  expect(changedDescriptor.descriptorSha256).not.toBe(baselineDescriptor.descriptorSha256);
  expect(changed.catalogSha256).not.toBe(baseline.catalogSha256);
  expect(changed.bindingSha256).toBe(baseline.bindingSha256);
};

describe("connection catalog census finalizer", () => {
  it.effect("is invariant to source object key order", () =>
    Effect.gen(function* () {
      const first = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const second = yield* finalizeConnectionCatalogCensus({
        request: {
          schemaVersion: CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION,
          expectedCredentialProvider: "vault",
          expectedIntegration: "acme",
          connectionAddress: "tools.acme.org.primary",
          refresh: true,
        },
        source: {
          complete: true,
          pages: [
            {
              descriptors: [
                {
                  outputSchema: descriptor.outputSchema,
                  inputSchema: descriptor.inputSchema,
                  definitions: descriptor.definitions,
                  annotations: descriptor.annotations,
                  description: descriptor.description,
                  name: descriptor.name,
                  address: descriptor.address,
                  connectionAddress: descriptor.connectionAddress,
                  owner: descriptor.owner,
                  integration: descriptor.integration,
                },
              ],
              sourceTransport: "http",
              catalogRevision: "revision-1",
              generation: "generation-1",
              nextCursor: null,
              cursor: null,
            },
          ],
          binding: {
            sourceTransport: "http",
            catalogRevision: "revision-1",
            generation: "generation-1",
            template: "api-key",
            subject: null,
            tenant: "tenant-1",
            credentialProvider: "vault",
            name: "primary",
            integration: "acme",
            owner: "org",
            address: "tools.acme.org.primary",
          },
        },
        observedAt,
      });
      expect(second).toEqual(first);
    }),
  );

  it.effect("rejects duplicate descriptor addresses", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                cursor: null,
                nextCursor: null,
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [descriptor, { ...descriptor }],
              },
            ],
          }),
          observedAt,
        }),
      );
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "ConnectionCatalogCensusError") &&
            failure.reason === "duplicate_entry",
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("rejects incomplete and nonterminal sources", () =>
    Effect.gen(function* () {
      const incomplete = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({ complete: false }),
          observedAt,
        }),
      );
      const nonterminal = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                cursor: null,
                nextCursor: "next",
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [descriptor],
              },
            ],
          }),
          observedAt,
        }),
      );
      expect(Result.isFailure(incomplete)).toBe(true);
      expect(Result.isFailure(nonterminal)).toBe(true);
    }),
  );

  it.effect("rejects credential-shaped schema defaults without echoing the value", () =>
    Effect.gen(function* () {
      const sentinel = `ghp_${"A".repeat(36)}`;
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                cursor: null,
                nextCursor: null,
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [
                  { ...descriptor, inputSchema: { type: "string", default: sentinel } },
                ],
              },
            ],
          }),
          observedAt,
        }),
      );
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "ConnectionCatalogCensusError") &&
            failure.reason === "secret_rejected" &&
            !failure.message.includes(sentinel),
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("rejects an injected target key", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        validateConnectionCatalogCensusInput({ ...REQUEST, target: "injected" }),
      );
      expectFailureReason(result, "invalid_input");
    }),
  );

  it.effect("rejects an injected tenant key", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        validateConnectionCatalogCensusInput({ ...REQUEST, tenant: "injected" }),
      );
      expectFailureReason(result, "invalid_input");
    }),
  );

  it.effect("rejects an injected cursor key", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        validateConnectionCatalogCensusInput({ ...REQUEST, cursor: "injected" }),
      );
      expectFailureReason(result, "invalid_input");
    }),
  );

  it.effect("rejects descriptor connection provenance drift", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                cursor: null,
                nextCursor: null,
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [{ ...descriptor, connectionAddress: "tools.other.org.primary" }],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "drift");
    }),
  );

  it.effect("rejects credential-shaped annotation values without echoing them", () =>
    Effect.gen(function* () {
      const pat = `ghp_${"A".repeat(36)}`;
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                cursor: null,
                nextCursor: null,
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [{ ...descriptor, annotations: { providerValue: pat } }],
              },
            ],
          }),
          observedAt,
        }),
      );
      expect(
        Result.match(result, {
          onFailure: (failure) =>
            Predicate.isTagged(failure, "ConnectionCatalogCensusError") &&
            failure.reason === "secret_rejected" &&
            !failure.message.includes(pat),
          onSuccess: () => false,
        }),
      ).toBe(true);
    }),
  );

  it.effect("emits the result schema version and requires refresh", () =>
    Effect.gen(function* () {
      const success = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      expect(success.schemaVersion).toBe(CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION);
      const invalidRefresh = yield* Effect.result(
        validateConnectionCatalogCensusInput({ ...REQUEST, refresh: false }),
      );
      expectFailureReason(invalidRefresh, "invalid_input");
    }),
  );

  it.effect("finalizes a local OpenAPI-style source with truthful none transport", () =>
    Effect.gen(function* () {
      const localRequest = {
        ...REQUEST,
        expectedCredentialProvider: "none",
      } satisfies ConnectionCatalogCensusInput;
      const localBinding = {
        ...binding,
        credentialProvider: "none",
        template: "openapi",
        sourceTransport: "none" as const,
      } satisfies ConnectionCatalogCensusBinding;
      const localDescriptor = descriptorFor({
        inputSchema: {
          openapi: "3.1.0",
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
        },
        outputSchema: {
          openapi: "3.1.0",
          type: "object",
          properties: { records: { type: "array", items: { type: "string" } } },
        },
      });
      const result = yield* finalizeConnectionCatalogCensus({
        request: localRequest,
        source: sourceForBinding(localBinding, [localDescriptor]),
        observedAt,
      });
      expect(result.sourceTransport).toBe("none");
      expect(result.credentialProvider).toBe("none");
      expect(result.complete).toBe(true);
    }),
  );

  it.effect("rejects an unknown binding transport before finalization", () =>
    Effect.gen(function* () {
      const baseline = source();
      const untrustedSource = {
        ...baseline,
        binding: { ...baseline.binding, sourceTransport: "unknown" },
        pages: baseline.pages.map((page) => ({ ...page, sourceTransport: "unknown" })),
      };
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: untrustedSource,
          observedAt,
        }),
      );
      expectFailureReason(result, "invalid_binding");
    }),
  );

  it.effect("allows a complete terminal empty catalog", () =>
    Effect.gen(function* () {
      const result = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              cursor: null,
              nextCursor: null,
              generation: "generation-1",
              catalogRevision: "revision-1",
              sourceTransport: "http",
              descriptors: [],
            },
          ],
        }),
        observedAt,
      });
      expect(result.complete).toBe(true);
      expect(result.toolCount).toBe(0);
      expect(result.descriptors).toEqual([]);
    }),
  );

  it.effect("finalizes a three-page terminal catalog in address order", () =>
    Effect.gen(function* () {
      const result = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              cursor: null,
              nextCursor: "cursor-1",
              generation: "generation-1",
              catalogRevision: "revision-1",
              sourceTransport: "http",
              descriptors: [descriptorNamed("zeta")],
            },
            {
              cursor: "cursor-1",
              nextCursor: "cursor-2",
              generation: "generation-1",
              catalogRevision: "revision-1",
              sourceTransport: "http",
              descriptors: [descriptorNamed("alpha")],
            },
            {
              cursor: "cursor-2",
              nextCursor: null,
              generation: "generation-1",
              catalogRevision: "revision-1",
              sourceTransport: "http",
              descriptors: [descriptorNamed("middle")],
            },
          ],
        }),
        observedAt,
      });
      expect(result.complete).toBe(true);
      expect(result.sourcePageCount).toBe(3);
      expect(result.sourceTerminalCursor).toBeNull();
      expect(result.toolCount).toBe(3);
      expect(result.descriptors.map(({ name }) => name)).toEqual(["alpha", "middle", "zeta"]);
    }),
  );

  it.effect("rejects a repeated cursor", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                cursor: null,
                nextCursor: "cursor-1",
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [],
              },
              {
                cursor: "cursor-1",
                nextCursor: "cursor-1",
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "repeated_cursor");
    }),
  );

  it.effect("rejects a cursor cycle", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                cursor: null,
                nextCursor: "cursor-1",
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [],
              },
              {
                cursor: "cursor-1",
                nextCursor: "cursor-2",
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [],
              },
              {
                cursor: "cursor-2",
                nextCursor: "cursor-1",
                generation: "generation-1",
                catalogRevision: "revision-1",
                sourceTransport: "http",
                descriptors: [],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "repeated_cursor");
    }),
  );

  it.effect("rejects a nonterminal 100th page", () =>
    Effect.gen(function* () {
      const pages = Array.from({ length: CONNECTION_CATALOG_CENSUS_MAX_PAGES }, (_, index) => ({
        cursor: index === 0 ? null : `cursor-${index}`,
        nextCursor: `cursor-${index + 1}`,
        generation: "generation-1" as const,
        catalogRevision: "revision-1" as const,
        sourceTransport: "http" as const,
        descriptors: [],
      }));
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({ pages }),
          observedAt,
        }),
      );
      expectFailureReason(result, "nonterminal_page_cap");
    }),
  );

  it.effect("rejects more than 100 pages", () =>
    Effect.gen(function* () {
      const pages = Array.from({ length: CONNECTION_CATALOG_CENSUS_MAX_PAGES + 1 }, (_, index) => ({
        cursor: index === 0 ? null : `cursor-${index}`,
        nextCursor: index === CONNECTION_CATALOG_CENSUS_MAX_PAGES ? null : `cursor-${index + 1}`,
        generation: "generation-1" as const,
        catalogRevision: "revision-1" as const,
        sourceTransport: "http" as const,
        descriptors: [],
      }));
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({ pages }),
          observedAt,
        }),
      );
      expectFailureReason(result, "nonterminal_page_cap");
    }),
  );

  it.effect("rejects generation drift between binding and page", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [{ ...pageForBinding(binding, null, null), generation: "generation-2" }],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "drift");
    }),
  );

  it.effect("rejects catalog revision drift between binding and page", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [{ ...pageForBinding(binding, null, null), catalogRevision: "revision-2" }],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "drift");
    }),
  );

  it.effect("rejects actual transport drift between binding and page", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [{ ...pageForBinding(binding, null, null), sourceTransport: "mcp" }],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "drift");
    }),
  );

  it.effect("changes binding, descriptor, and catalog hashes for generation changes", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: sourceForBinding(binding),
        observedAt,
      });
      const changedBinding = {
        ...binding,
        generation: "generation-2",
      } satisfies ConnectionCatalogCensusBinding;
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: sourceForBinding(changedBinding),
        observedAt,
      });
      expect(changed.bindingSha256).not.toBe(baseline.bindingSha256);
      expect(changed.descriptors[0]?.descriptionSha256).toBe(
        baseline.descriptors[0]?.descriptionSha256,
      );
      expect(changed.descriptors[0]?.descriptorSha256).not.toBe(
        baseline.descriptors[0]?.descriptorSha256,
      );
      expect(changed.catalogSha256).not.toBe(baseline.catalogSha256);
    }),
  );

  it.effect("changes binding, descriptor, and catalog hashes for revision changes", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: sourceForBinding(binding),
        observedAt,
      });
      const changedBinding = {
        ...binding,
        catalogRevision: "revision-2",
      } satisfies ConnectionCatalogCensusBinding;
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: sourceForBinding(changedBinding),
        observedAt,
      });
      expect(changed.bindingSha256).not.toBe(baseline.bindingSha256);
      expect(changed.descriptors[0]?.annotationsSha256).toBe(
        baseline.descriptors[0]?.annotationsSha256,
      );
      expect(changed.descriptors[0]?.descriptorSha256).not.toBe(
        baseline.descriptors[0]?.descriptorSha256,
      );
      expect(changed.catalogSha256).not.toBe(baseline.catalogSha256);
    }),
  );

  it.effect("changes binding, descriptor, and catalog hashes for transport changes", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: sourceForBinding(binding),
        observedAt,
      });
      const changedBinding = {
        ...binding,
        sourceTransport: "mcp",
      } satisfies ConnectionCatalogCensusBinding;
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: sourceForBinding(changedBinding),
        observedAt,
      });
      expect(changed.bindingSha256).not.toBe(baseline.bindingSha256);
      expect(changed.descriptors[0]?.inputSchemaSha256).toBe(
        baseline.descriptors[0]?.inputSchemaSha256,
      );
      expect(changed.descriptors[0]?.descriptorSha256).not.toBe(
        baseline.descriptors[0]?.descriptorSha256,
      );
      expect(changed.catalogSha256).not.toBe(baseline.catalogSha256);
    }),
  );

  it.effect("changes only the expected lower-level hash when description changes", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              ...pageForBinding(binding, null, null),
              descriptors: [descriptorFor({ description: "Read one thinh" })],
            },
          ],
        }),
        observedAt,
      });
      expectOnlyDescriptorHashChange(baseline, changed, "descriptionSha256");
    }),
  );

  it.effect("changes only the expected lower-level hash when annotations change", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              ...pageForBinding(binding, null, null),
              descriptors: [descriptorFor({ annotations: { requiresApproval: false, tag: "b" } })],
            },
          ],
        }),
        observedAt,
      });
      expectOnlyDescriptorHashChange(baseline, changed, "annotationsSha256");
    }),
  );

  it.effect("changes only the expected lower-level hash when input schema changes", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              ...pageForBinding(binding, null, null),
              descriptors: [
                descriptorFor({
                  inputSchema: {
                    type: "object",
                    properties: { token: { type: "string", title: "b" } },
                    $ref: "#/$defs/Thing",
                  },
                }),
              ],
            },
          ],
        }),
        observedAt,
      });
      expectOnlyDescriptorHashChange(baseline, changed, "inputSchemaSha256");
    }),
  );

  it.effect("changes only the expected lower-level hash when output schema changes", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              ...pageForBinding(binding, null, null),
              descriptors: [
                descriptorFor({
                  outputSchema: {
                    type: "object",
                    properties: { id: { type: "string", title: "b" } },
                  },
                }),
              ],
            },
          ],
        }),
        observedAt,
      });
      expectOnlyDescriptorHashChange(baseline, changed, "outputSchemaSha256");
    }),
  );

  it.effect("changes only the expected lower-level hash when definitions change", () =>
    Effect.gen(function* () {
      const baseline = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const changed = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              ...pageForBinding(binding, null, null),
              descriptors: [
                descriptorFor({
                  definitions: {
                    Thing: {
                      type: "object",
                      properties: { id: { type: "string", title: "b" } },
                    },
                  },
                }),
              ],
            },
          ],
        }),
        observedAt,
      });
      expectOnlyDescriptorHashChange(baseline, changed, "definitionsSha256");
    }),
  );

  it.effect("rejects invalid timestamps", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source(),
          observedAt: "not-a-timestamp",
        }),
      );
      expectFailureReason(result, "invalid_timestamp");
    }),
  );

  it.effect("rejects oversized strings", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                ...pageForBinding(binding, null, null),
                descriptors: [
                  descriptorFor({
                    description: "x".repeat(CONNECTION_CATALOG_CENSUS_MAX_STRING_BYTES + 1),
                  }),
                ],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "bounds_overflow");
    }),
  );

  it.effect("rejects a user binding without a subject", () =>
    Effect.gen(function* () {
      const userRequest = {
        ...REQUEST,
        connectionAddress: "tools.acme.user.primary",
      } satisfies ConnectionCatalogCensusInput;
      const userBinding = {
        ...binding,
        address: "tools.acme.user.primary",
        owner: "user" as const,
        subject: null,
      } satisfies ConnectionCatalogCensusBinding;
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: userRequest,
          source: sourceForBinding(userBinding),
          observedAt,
        }),
      );
      expectFailureReason(result, "invalid_binding");
    }),
  );

  it.effect("rejects missing plugin provenance", () =>
    Effect.gen(function* () {
      const pluginBinding = {
        ...binding,
        pluginId: "plugin-1",
      } satisfies ConnectionCatalogCensusBinding;
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: sourceForBinding(pluginBinding),
          observedAt,
        }),
      );
      expectFailureReason(result, "drift");
    }),
  );

  it.effect("rejects mismatched or unexpected plugin provenance", () =>
    Effect.gen(function* () {
      const pluginBinding = {
        ...binding,
        pluginId: "plugin-1",
      } satisfies ConnectionCatalogCensusBinding;
      const mismatched = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: sourceForBinding(pluginBinding, [descriptorFor({ pluginId: "plugin-2" })]),
          observedAt,
        }),
      );
      expectFailureReason(mismatched, "drift");
      const unexpected = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: sourceForBinding(binding, [descriptorFor({ pluginId: "plugin-1" })]),
          observedAt,
        }),
      );
      expectFailureReason(unexpected, "drift");
    }),
  );

  it.effect("rejects an unresolved local schema reference", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                ...pageForBinding(binding, null, null),
                descriptors: [
                  descriptorFor({
                    inputSchema: { $ref: "#/$defs/Missing" },
                    definitions: {},
                  }),
                ],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "schema_lookup_failure");
    }),
  );

  it.effect("preserves cyclic local schema references", () =>
    Effect.gen(function* () {
      const result = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              ...pageForBinding(binding, null, null),
              descriptors: [
                descriptorFor({
                  inputSchema: {
                    $ref: "#/$defs/A",
                    $defs: {
                      A: { $ref: "#/$defs/B" },
                      B: { $ref: "#/$defs/A" },
                    },
                  },
                  definitions: {},
                }),
              ],
            },
          ],
        }),
        observedAt,
      });
      expect(result.complete).toBe(true);
      expect(result.toolCount).toBe(1);
    }),
  );

  it.effect("resolves encoded definition names and nested JSON Pointer paths", () =>
    Effect.gen(function* () {
      const result = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source({
          pages: [
            {
              ...pageForBinding(binding, null, null),
              descriptors: [
                descriptorFor({
                  inputSchema: {
                    $ref: "#/$defs/a~1b/properties/c~0d",
                    $defs: {
                      "a/b": {
                        type: "object",
                        properties: { "c~d": { type: "string" } },
                      },
                    },
                  },
                  definitions: {},
                }),
              ],
            },
          ],
        }),
        observedAt,
      });
      expect(result.complete).toBe(true);
    }),
  );

  it.effect("rejects malformed JSON Pointer escapes", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                ...pageForBinding(binding, null, null),
                descriptors: [
                  descriptorFor({ inputSchema: { $ref: "#/$defs/Thing~2" }, definitions: {} }),
                ],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "schema_lookup_failure");
    }),
  );

  it.effect("rejects missing nested JSON Pointer targets", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                ...pageForBinding(binding, null, null),
                descriptors: [
                  descriptorFor({
                    inputSchema: {
                      $ref: "#/$defs/Thing/properties/missing",
                      $defs: { Thing: { type: "object", properties: {} } },
                    },
                    definitions: {},
                  }),
                ],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(result, "schema_lookup_failure");
    }),
  );

  it.effect("rejects non-local refs under the documented resolver policy", () =>
    Effect.gen(function* () {
      const external = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                ...pageForBinding(binding, null, null),
                descriptors: [
                  descriptorFor({
                    inputSchema: { $ref: "https://schemas.example.test/tool.json#/Thing" },
                    definitions: {},
                  }),
                ],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(external, "schema_lookup_failure");

      const otherLocalRoot = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: source({
            pages: [
              {
                ...pageForBinding(binding, null, null),
                descriptors: [
                  descriptorFor({ inputSchema: { $ref: "#/properties/name" }, definitions: {} }),
                ],
              },
            ],
          }),
          observedAt,
        }),
      );
      expectFailureReason(otherLocalRoot, "schema_lookup_failure");
    }),
  );

  it.effect("rejects a non-null subject on an org-owned binding", () =>
    Effect.gen(function* () {
      const orgBinding = {
        ...binding,
        subject: "unexpected-subject",
      } satisfies ConnectionCatalogCensusBinding;
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: REQUEST,
          source: sourceForBinding(orgBinding),
          observedAt,
        }),
      );
      expectFailureReason(result, "invalid_binding");
    }),
  );

  it.effect("rejects an empty subject on a user-owned binding", () =>
    Effect.gen(function* () {
      const userAddress = "tools.acme.user.primary";
      const userRequest = {
        ...REQUEST,
        connectionAddress: userAddress,
      } satisfies ConnectionCatalogCensusInput;
      const userBinding = {
        ...binding,
        address: userAddress,
        owner: "user" as const,
        subject: "",
      } satisfies ConnectionCatalogCensusBinding;
      const result = yield* Effect.result(
        finalizeConnectionCatalogCensus({
          request: userRequest,
          source: sourceForBinding(userBinding),
          observedAt,
        }),
      );
      expectFailureReason(result, "invalid_binding");
    }),
  );

  it.effect("separates valid user subject hashes without exposing subjects", () =>
    Effect.gen(function* () {
      const userAddress = "tools.acme.user.primary";
      const userRequest = {
        ...REQUEST,
        connectionAddress: userAddress,
      } satisfies ConnectionCatalogCensusInput;
      const userDescriptor = descriptorFor({
        address: `${userAddress}.getThing`,
        connectionAddress: userAddress,
        owner: "user",
      });
      const firstBinding = {
        ...binding,
        address: userAddress,
        owner: "user" as const,
        subject: "subject-1",
      } satisfies ConnectionCatalogCensusBinding;
      const secondBinding = {
        ...firstBinding,
        subject: "subject-2",
      } satisfies ConnectionCatalogCensusBinding;
      const first = yield* finalizeConnectionCatalogCensus({
        request: userRequest,
        source: sourceForBinding(firstBinding, [userDescriptor]),
        observedAt,
      });
      const second = yield* finalizeConnectionCatalogCensus({
        request: userRequest,
        source: sourceForBinding(secondBinding, [userDescriptor]),
        observedAt,
      });
      expect(first.bindingSha256).not.toBe(second.bindingSha256);
      expect(Object.hasOwn(first, "subject")).toBe(false);
      expect(Object.hasOwn(second, "subject")).toBe(false);
      expect(JSON.stringify(first)).not.toContain("subject-1");
      expect(JSON.stringify(second)).not.toContain("subject-2");
    }),
  );

  it.effect("accepts an actual finalized result through public schemas", () =>
    Effect.gen(function* () {
      const finalized = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const requestValidation = yield* Effect.promise(() =>
        Promise.resolve(ConnectionCatalogCensusRequest["~standard"].validate(REQUEST)),
      );
      const descriptorValidation = yield* Effect.promise(() =>
        Promise.resolve(
          ConnectionCatalogCensusDescriptor["~standard"].validate(finalized.descriptors[0]),
        ),
      );
      const resultValidation = yield* Effect.promise(() =>
        Promise.resolve(ConnectionCatalogCensusResult["~standard"].validate(finalized)),
      );
      expect("issues" in requestValidation).toBe(false);
      expect("issues" in descriptorValidation).toBe(false);
      expect("issues" in resultValidation).toBe(false);
    }),
  );

  it.effect("rejects malformed public hashes", () =>
    Effect.gen(function* () {
      const finalized = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const malformedDescriptor = Schema.decodeUnknownResult(ConnectionCatalogCensusDescriptor)({
        ...finalized.descriptors[0],
        descriptionSha256: "not-a-hash",
      });
      const malformedResult = Schema.decodeUnknownResult(ConnectionCatalogCensusResult)({
        ...finalized,
        bindingSha256: "not-a-hash",
      });
      expect(Result.isFailure(malformedDescriptor)).toBe(true);
      expect(Result.isFailure(malformedResult)).toBe(true);
    }),
  );

  it.effect("rejects extra keys through each exported strict schema", () =>
    Effect.gen(function* () {
      const finalized = yield* finalizeConnectionCatalogCensus({
        request: REQUEST,
        source: source(),
        observedAt,
      });
      const pat = `ghp_${"A".repeat(36)}`;
      const requestWithSecretExtra = { ...REQUEST, [pat]: pat };
      const descriptorWithExtra = {
        ...finalized.descriptors[0],
        [pat]: pat,
      };
      const resultWithSecretExtra = { ...finalized, [pat]: pat };
      const requestValidation = yield* Effect.promise(() =>
        Promise.resolve(
          ConnectionCatalogCensusRequest["~standard"].validate(requestWithSecretExtra),
        ),
      );
      const descriptorValidation = yield* Effect.promise(() =>
        Promise.resolve(
          ConnectionCatalogCensusDescriptor["~standard"].validate(descriptorWithExtra),
        ),
      );
      const resultValidation = yield* Effect.promise(() =>
        Promise.resolve(ConnectionCatalogCensusResult["~standard"].validate(resultWithSecretExtra)),
      );
      expect("issues" in requestValidation).toBe(true);
      expect("issues" in descriptorValidation).toBe(true);
      expect("issues" in resultValidation).toBe(true);
      expect(JSON.stringify(requestValidation)).not.toContain(pat);
      expect(JSON.stringify(descriptorValidation)).not.toContain(pat);
      expect(JSON.stringify(resultValidation)).not.toContain(pat);
    }),
  );
});
