import { Effect, Layer } from "effect";

import {
  AccountError,
  AccountForbidden,
  AccountNoOrganization,
  AccountUnauthorized,
} from "@executor-js/api";
import { AccountProvider, type AccountHeaders } from "@executor-js/api/server";

import type { ApiKeyService } from "../auth/api-keys";
import { sessionForRequest, type WorkOSIdentityDeps } from "../auth/identity";
import {
  ORG_SELECTOR_HEADER,
  authorizeUserOrganizationSelector,
  rolesForMembership,
} from "../auth/organization";

const MAX_API_KEY_NAME_LENGTH = 80;

const toAccountError = (message = "Account request failed") =>
  Effect.fail(new AccountError({ message }));

const header = (headers: AccountHeaders, name: string): string | undefined =>
  headers[name] ?? new Headers(headers).get(name) ?? undefined;

export interface WorkOSAccountDeps extends WorkOSIdentityDeps {
  readonly apiKeys: ApiKeyService;
}

export const makeWorkOSAccountProvider = (deps: WorkOSAccountDeps): Layer.Layer<AccountProvider> =>
  Layer.succeed(AccountProvider)({
    me: (headers) =>
      Effect.gen(function* () {
        const session = yield* requireSession(deps, headers);
        const requested = header(headers, ORG_SELECTOR_HEADER) ?? session.organizationId;
        const memberships = requested
          ? null
          : yield* deps.workos
              .listUserMemberships(session.accountId)
              .pipe(Effect.catch(() => Effect.succeed([])));
        const selector =
          requested ??
          memberships?.find((membership) => membership.status === "active")?.organizationId;
        const organization = selector
          ? yield* authorizeUserOrganizationSelector(deps, session.accountId, selector).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
          : null;
        return {
          user: {
            id: session.accountId,
            email: session.email,
            name: session.name,
            avatarUrl: session.avatarUrl,
          },
          organization: organization
            ? { id: organization.id, name: organization.name, slug: organization.slug }
            : null,
        };
      }),

    listApiKeys: (headers) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        const apiKeys = yield* deps.apiKeys
          .listUserKeys({
            accountId: session.accountId,
            organizationId: organization.id,
          })
          .pipe(Effect.catch(() => toAccountError("Failed to list API keys")));
        return { apiKeys: [...apiKeys] };
      }),

    createApiKey: (headers, name) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        const trimmed = name.trim().slice(0, MAX_API_KEY_NAME_LENGTH);
        if (!trimmed) return yield* toAccountError("API key name is required");
        return yield* deps.apiKeys
          .createUserKey({
            accountId: session.accountId,
            organizationId: organization.id,
            name: trimmed,
          })
          .pipe(Effect.catch(() => toAccountError("Failed to create API key")));
      }),

    revokeApiKey: (headers, apiKeyId) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        const keys = yield* deps.apiKeys
          .listUserKeys({
            accountId: session.accountId,
            organizationId: organization.id,
          })
          .pipe(Effect.catch(() => toAccountError("Failed to list API keys")));
        if (!keys.some((key) => key.id === apiKeyId)) {
          return yield* toAccountError("API key not found");
        }
        yield* deps.apiKeys
          .revokeUserKey(apiKeyId)
          .pipe(Effect.catch(() => toAccountError("Failed to revoke API key")));
        return { success: true };
      }),

    listMembers: (headers) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        const memberships = yield* deps.workos
          .listOrgMembers(organization.id)
          .pipe(Effect.catch(() => toAccountError("Failed to list members")));
        const members = yield* Effect.all(
          memberships.map((membership) =>
            deps.workos.getUser(membership.userId).pipe(
              Effect.map((user) => ({
                id: membership.id,
                userId: membership.userId,
                email: user.email,
                name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
                avatarUrl: user.profilePictureUrl ?? null,
                role: rolesForMembership(membership)[0] ?? "member",
                status: membership.status,
                lastActiveAt: user.lastSignInAt ?? null,
                isCurrentUser: membership.userId === session.accountId,
              })),
            ),
          ),
          { concurrency: 5 },
        ).pipe(Effect.catch(() => toAccountError("Failed to load member details")));
        return {
          members,
          seats: { used: members.length, granted: members.length, unlimited: true },
        };
      }),

    listRoles: (headers) =>
      Effect.gen(function* () {
        const { organization } = yield* requireOrganization(deps, headers);
        const roles = yield* deps.workos
          .listOrgRoles(organization.id)
          .pipe(Effect.catch(() => toAccountError("Failed to list roles")));
        return { roles: roles.map((role) => ({ slug: role.slug, name: role.name })) };
      }),

    inviteMember: (headers, body) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        yield* requireAdmin(deps, session.accountId, organization.id);
        const invitation = yield* deps.workos
          .sendInvitation({
            email: body.email,
            organizationId: organization.id,
            ...(body.roleSlug ? { roleSlug: body.roleSlug } : {}),
          })
          .pipe(Effect.catch(() => toAccountError("Failed to invite member")));
        return { id: invitation.id, email: invitation.email };
      }),

    removeMember: (headers, membershipId) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        yield* requireAdmin(deps, session.accountId, organization.id);
        yield* assertMembershipInOrganization(deps, organization.id, membershipId);
        yield* deps.workos
          .deleteOrgMembership(membershipId)
          .pipe(Effect.catch(() => toAccountError("Failed to remove member")));
        return { success: true };
      }),

    updateMemberRole: (headers, membershipId, roleSlug) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        yield* requireAdmin(deps, session.accountId, organization.id);
        yield* assertMembershipInOrganization(deps, organization.id, membershipId);
        yield* deps.workos
          .updateOrgMembershipRole(membershipId, roleSlug)
          .pipe(Effect.catch(() => toAccountError("Failed to update member role")));
        return { success: true };
      }),

    updateOrgName: (headers, name) =>
      Effect.gen(function* () {
        const { session, organization } = yield* requireOrganization(deps, headers);
        yield* requireAdmin(deps, session.accountId, organization.id);
        const trimmed = name.trim();
        if (!trimmed) return yield* toAccountError("Organization name is required");
        const updated = yield* deps.workos
          .updateOrganization(organization.id, trimmed)
          .pipe(Effect.catch(() => toAccountError("Failed to update organization")));
        yield* deps.organizations
          .upsert({ id: updated.id, name: updated.name })
          .pipe(Effect.catch(() => toAccountError("Failed to update organization")));
        return { name: updated.name };
      }),
  });

const requireSession = (deps: WorkOSAccountDeps, headers: AccountHeaders) =>
  sessionForRequest(deps.workos, new Request("http://executor.internal", { headers })).pipe(
    Effect.catch(() => toAccountError("Failed to resolve session")),
    Effect.flatMap((session) =>
      session ? Effect.succeed(session) : Effect.fail(new AccountUnauthorized()),
    ),
  );

const requireOrganization = (deps: WorkOSAccountDeps, headers: AccountHeaders) =>
  Effect.gen(function* () {
    const session = yield* requireSession(deps, headers);
    const selector = header(headers, ORG_SELECTOR_HEADER) ?? session.organizationId;
    if (!selector) return yield* new AccountNoOrganization();
    const organization = yield* authorizeUserOrganizationSelector(
      deps,
      session.accountId,
      selector,
    ).pipe(Effect.catch(() => Effect.fail(new AccountNoOrganization())));
    if (!organization) return yield* new AccountNoOrganization();
    return { session, organization };
  });

const requireAdmin = (deps: WorkOSAccountDeps, accountId: string, organizationId: string) =>
  Effect.gen(function* () {
    const membership = yield* deps.workos
      .getUserOrgMembership(organizationId, accountId)
      .pipe(Effect.catch(() => toAccountError()));
    if (!membership || !rolesForMembership(membership).includes("admin")) {
      return yield* new AccountForbidden();
    }
  });

const assertMembershipInOrganization = (
  deps: WorkOSAccountDeps,
  organizationId: string,
  membershipId: string,
) =>
  Effect.gen(function* () {
    const membership = yield* deps.workos
      .getOrgMembership(membershipId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!membership || membership.organizationId !== organizationId) {
      return yield* new AccountForbidden();
    }
  });
