import { Schema } from "effect";

import { AuthTemplateSlug, ConnectionHandoffId, ConnectionName, IntegrationSlug } from "./ids";

/** Service-side request for a member-bound, browser-mediated connection. */
export interface CreateConnectionHandoffInput {
  readonly memberId: string;
  readonly integration: IntegrationSlug;
  readonly template?: AuthTemplateSlug;
  readonly label: string;
  readonly returnTo: string;
}

export const ConnectionHandoffTarget = Schema.Struct({
  owner: Schema.Literal("user"),
  integration: IntegrationSlug,
  name: ConnectionName,
});
export type ConnectionHandoffTarget = typeof ConnectionHandoffTarget.Type;

export const ConnectionHandoffReceipt = Schema.Struct({
  schema: Schema.Literal("executor.connection-handoff.receipt.v1"),
  receiptId: Schema.String,
  handoffId: ConnectionHandoffId,
  tenant: Schema.String,
  memberId: Schema.String,
  completedAt: Schema.Number,
  connection: ConnectionHandoffTarget,
  readback: Schema.Struct({ connectionPresent: Schema.Literal(true) }),
});
export type ConnectionHandoffReceipt = typeof ConnectionHandoffReceipt.Type;

const ConnectionHandoffBase = {
  handoffId: ConnectionHandoffId,
  memberId: Schema.String,
  integration: IntegrationSlug,
  owner: Schema.Literal("user"),
  connectionName: ConnectionName,
  template: Schema.optional(AuthTemplateSlug),
  label: Schema.String,
  returnTo: Schema.String,
  url: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
} as const;

export const PendingConnectionHandoff = Schema.Struct({
  ...ConnectionHandoffBase,
  status: Schema.Literal("pending"),
});
export type PendingConnectionHandoff = typeof PendingConnectionHandoff.Type;

export const CompletedConnectionHandoff = Schema.Struct({
  ...ConnectionHandoffBase,
  status: Schema.Literal("completed"),
  receipt: ConnectionHandoffReceipt,
});
export type CompletedConnectionHandoff = typeof CompletedConnectionHandoff.Type;

export const ConnectionHandoffExpiryReceipt = Schema.Struct({
  schema: Schema.Literal("executor.connection-handoff.expiry.v1"),
  receiptId: Schema.String,
  handoffId: ConnectionHandoffId,
  tenant: Schema.String,
  memberId: Schema.String,
  expiredAt: Schema.Number,
  code: Schema.Literal("CONNECTION_HANDOFF_EXPIRED"),
});
export type ConnectionHandoffExpiryReceipt = typeof ConnectionHandoffExpiryReceipt.Type;

export const ExpiredConnectionHandoff = Schema.Struct({
  ...ConnectionHandoffBase,
  status: Schema.Literal("expired"),
  receipt: ConnectionHandoffExpiryReceipt,
});
export type ExpiredConnectionHandoff = typeof ExpiredConnectionHandoff.Type;

export const ConnectionHandoff = Schema.Union([
  PendingConnectionHandoff,
  CompletedConnectionHandoff,
  ExpiredConnectionHandoff,
]);
export type ConnectionHandoff = typeof ConnectionHandoff.Type;
