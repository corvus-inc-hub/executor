import { Schema } from "effect";

import { ToolAddress } from "./ids";
import type {
  ExecuteOperationDefinition,
  ExecuteOperationDescriptor,
  ExecuteOperationRequest,
  ExecuteOperationResult,
} from "./operation";
import { EXECUTE_OPERATION_SCHEMA_VERSION } from "./operation";

/**
 * A deterministic wire-contract fixture for adapter conformance tests.
 *
 * This is intentionally a tiny public echo operation, not a provider
 * implementation. In particular, `github.repository.inventory.v1` is not
 * defined or registered by Executor; MNFST must not infer that operation from
 * this fixture. The fixture exists so HTTP/MCP adapters can share exact
 * descriptor, request, and result bytes while integrating a real registry.
 */
const GOLDEN_INPUT_SCHEMA = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ message: Schema.String })),
);

const GOLDEN_OUTPUT_SCHEMA = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ message: Schema.String })),
);

export const GOLDEN_OPERATION_DEFINITION: ExecuteOperationDefinition = {
  operationKey: "executor.attestation.echo",
  version: 1,
  target: ToolAddress.make("tools.attestation.echo"),
  inputSchema: GOLDEN_INPUT_SCHEMA,
  outputSchema: GOLDEN_OUTPUT_SCHEMA,
  providerTransport: "none",
};

/** Canonical descriptor bytes covered by descriptorSha256. */
export const GOLDEN_OPERATION_DESCRIPTOR_CANONICAL =
  '{"inputSchema":{"additionalProperties":false,"properties":{"message":{"type":"string"}},"required":["message"],"type":"object"},"operationKey":"executor.attestation.echo","outputSchema":{"additionalProperties":false,"properties":{"message":{"type":"string"}},"required":["message"],"type":"object"},"providerTransport":"none","schemaVersion":"executor.operation.v2","target":"tools.attestation.echo","version":1}' as const;

export const GOLDEN_OPERATION_DESCRIPTOR_SHA256 =
  "8f22a2f77ecaaa4d1b2fb7ee357cc0a51554579e37d3a1777148313b7607ee0c" as const;

export const GOLDEN_OPERATION_DESCRIPTOR: ExecuteOperationDescriptor = {
  schemaVersion: EXECUTE_OPERATION_SCHEMA_VERSION,
  operationKey: GOLDEN_OPERATION_DEFINITION.operationKey,
  version: GOLDEN_OPERATION_DEFINITION.version,
  target: GOLDEN_OPERATION_DEFINITION.target,
  providerTransport: GOLDEN_OPERATION_DEFINITION.providerTransport,
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  descriptorSha256: GOLDEN_OPERATION_DESCRIPTOR_SHA256,
};

export const GOLDEN_OPERATION_REQUEST_CANONICAL =
  '{"descriptorSha256":"8f22a2f77ecaaa4d1b2fb7ee357cc0a51554579e37d3a1777148313b7607ee0c","input":{"message":"hello"},"jobId":"golden-job-001","operationKey":"executor.attestation.echo","schemaVersion":"executor.operation.v2","version":1}' as const;

export const GOLDEN_OPERATION_REQUEST_SHA256 =
  "a8425bf059937d6f2a74af17675b968079301eb3dd4e944e2eb9c71eb89eaebd" as const;

export const GOLDEN_OPERATION_REQUEST: ExecuteOperationRequest = {
  schemaVersion: EXECUTE_OPERATION_SCHEMA_VERSION,
  operationKey: GOLDEN_OPERATION_DEFINITION.operationKey,
  version: GOLDEN_OPERATION_DEFINITION.version,
  jobId: "golden-job-001",
  descriptorSha256: GOLDEN_OPERATION_DESCRIPTOR_SHA256,
  input: { message: "hello" },
  requestSha256: GOLDEN_OPERATION_REQUEST_SHA256,
};

export const GOLDEN_OPERATION_OUTPUT_SHA256 =
  "9b2d43affbf49a367028df2e1414f84c0e099ac98c3d54a8a80157fd7771af25" as const;

/** A deterministic result envelope for carrier-adapter serialization tests. */
export const GOLDEN_OPERATION_RESULT: ExecuteOperationResult = {
  schemaVersion: EXECUTE_OPERATION_SCHEMA_VERSION,
  operationKey: GOLDEN_OPERATION_DEFINITION.operationKey,
  version: GOLDEN_OPERATION_DEFINITION.version,
  jobId: GOLDEN_OPERATION_REQUEST.jobId,
  descriptorSha256: GOLDEN_OPERATION_DESCRIPTOR_SHA256,
  requestSha256: GOLDEN_OPERATION_REQUEST_SHA256,
  carrier: "http",
  target: GOLDEN_OPERATION_DEFINITION.target,
  providerTransport: GOLDEN_OPERATION_DEFINITION.providerTransport,
  executionId: "execution-golden-001",
  policy: {
    decision: "allow",
    source: "user",
    pattern: "executor.attestation.echo",
    policyId: "policy-golden-001",
  },
  approval: {
    decision: "not_required",
    tenant: "golden-tenant",
    executionId: "execution-golden-001",
    jobId: GOLDEN_OPERATION_REQUEST.jobId,
    operationKey: GOLDEN_OPERATION_DEFINITION.operationKey,
    version: GOLDEN_OPERATION_DEFINITION.version,
    descriptorSha256: GOLDEN_OPERATION_DESCRIPTOR_SHA256,
    requestSha256: GOLDEN_OPERATION_REQUEST_SHA256,
    target: GOLDEN_OPERATION_DEFINITION.target,
    providerTransport: GOLDEN_OPERATION_DEFINITION.providerTransport,
    carrier: "http",
    policy: {
      decision: "allow",
      source: "user",
      pattern: "executor.attestation.echo",
      policyId: "policy-golden-001",
    },
    sessionId: "approval-golden-001",
  },
  providerReconciliation: { status: "not_attempted" },
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:00.005Z",
  durationMs: 5,
  status: "completed",
  outputSha256: GOLDEN_OPERATION_OUTPUT_SHA256,
  output: { message: "hello" },
};
