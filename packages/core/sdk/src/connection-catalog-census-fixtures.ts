import {
  CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION,
  CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION,
  type ConnectionCatalogCensusBinding,
  type ConnectionCatalogCensusDescriptorInput,
  type ConnectionCatalogCensusInput,
  type ConnectionCatalogCensusResult,
  type ConnectionCatalogCensusSource,
} from "./connection-catalog-census";

/** A deterministic, credential-free request for public contract conformance tests. */
export const CONNECTION_CATALOG_CENSUS_GOLDEN_REQUEST = {
  schemaVersion: CONNECTION_CATALOG_CENSUS_REQUEST_SCHEMA_VERSION,
  connectionAddress: "tools.acme.org.primary",
  expectedIntegration: "acme",
  expectedCredentialProvider: "vault",
  refresh: true,
} satisfies ConnectionCatalogCensusInput;

/** The authenticated binding facts covered by the binding hash. */
export const CONNECTION_CATALOG_CENSUS_GOLDEN_BINDING = {
  address: "tools.acme.org.primary",
  owner: "org",
  integration: "acme",
  name: "primary",
  credentialProvider: "vault",
  tenant: "tenant-fixture",
  subject: null,
  template: "api-key",
  generation: "generation-fixture-1",
  catalogRevision: "revision-fixture-1",
  sourceTransport: "http",
} satisfies ConnectionCatalogCensusBinding;

const CONNECTION_CATALOG_CENSUS_GOLDEN_DESCRIPTOR = {
  address: "tools.acme.org.primary.listRecords",
  name: "listRecords",
  description: "List public records.",
  annotations: {
    category: "records",
    requiresApproval: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      records: { type: "array", items: { type: "string" } },
    },
  },
  definitions: {},
  connectionAddress: "tools.acme.org.primary",
  owner: "org",
  integration: "acme",
} satisfies ConnectionCatalogCensusDescriptorInput;

/** The one-page source snapshot used by the golden. */
export const CONNECTION_CATALOG_CENSUS_GOLDEN_SOURCE = {
  binding: CONNECTION_CATALOG_CENSUS_GOLDEN_BINDING,
  complete: true,
  pages: [
    {
      cursor: null,
      nextCursor: null,
      generation: "generation-fixture-1",
      catalogRevision: "revision-fixture-1",
      sourceTransport: "http",
      descriptors: [CONNECTION_CATALOG_CENSUS_GOLDEN_DESCRIPTOR],
    },
  ],
} satisfies ConnectionCatalogCensusSource;

export const CONNECTION_CATALOG_CENSUS_GOLDEN_OBSERVED_AT = "2026-08-26T00:00:00.000Z" as const;

/**
 * Filled from the pure finalizer and intentionally limited to public identity and hashes.
 * No source description, annotations, schemas, definitions, tenant, or subject crosses this
 * conformance fixture's result boundary.
 */
export const CONNECTION_CATALOG_CENSUS_GOLDEN_RESULT = {
  schemaVersion: CONNECTION_CATALOG_CENSUS_RESULT_SCHEMA_VERSION,
  address: "tools.acme.org.primary",
  owner: "org",
  integration: "acme",
  name: "primary",
  credentialProvider: "vault",
  bindingSha256: "65ddfaa6e019593965e525898283b7f84cc67fa0d9da7e2d3c18cae539611ce4",
  sourceTransport: "http",
  complete: true,
  observedAt: CONNECTION_CATALOG_CENSUS_GOLDEN_OBSERVED_AT,
  sourcePageCount: 1,
  sourceTerminalCursor: null,
  toolCount: 1,
  descriptors: [
    {
      address: "tools.acme.org.primary.listRecords",
      name: "listRecords",
      descriptionSha256: "ee7136275ec0d1189df2b9182f5328a743492ed24ce1e67f65178f0337722a16",
      annotationsSha256: "ffcf618a9896bd942c6eb8d80eabd16f3cbff00c432bfbd6f07f0e7b14704533",
      inputSchemaSha256: "683d4cd6d128cdcde5e0040a593e39a30627a8198cb2ce9eac80850f81748073",
      outputSchemaSha256: "23ea9300730fe21794a600c1f88732345f31231ef5665ca2b2981dd8065d44dc",
      definitionsSha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      descriptorSha256: "bb53609fcaa073ec1753a93790bc814c37cbc321fddab4ebda0f8a08de3ef0f0",
    },
  ],
  descriptorHashes: ["bb53609fcaa073ec1753a93790bc814c37cbc321fddab4ebda0f8a08de3ef0f0"],
  catalogSha256: "9d554b7b73ae7b968f01fe2abecc9a9f86cc8fa6ded9e092bfc383daf997907f",
} satisfies ConnectionCatalogCensusResult;
