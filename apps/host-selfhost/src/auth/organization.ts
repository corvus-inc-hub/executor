import { Effect } from "effect";

import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import type { WorkOSConfig } from "../config";
import type { OrganizationStore, StoredOrganization } from "./organization-store";
import {
  isAllowedOrganization,
  type ConnectApplication,
  type WorkOSClient,
  type WorkOSRequestError,
} from "./workos";

export const ORG_SELECTOR_HEADER = EXECUTOR_ORG_SELECTOR_HEADER;

export interface AuthorizedOrganization extends StoredOrganization {
  readonly roles: readonly string[];
}

export interface AuthorizedServiceOrganization extends StoredOrganization {
  readonly application: ConnectApplication;
}

export interface OrganizationAuthDeps {
  readonly config: WorkOSConfig;
  readonly workos: WorkOSClient;
  readonly organizations: OrganizationStore;
}

const membershipRoles = (membership: {
  readonly role?: { readonly slug: string };
  readonly roles?: readonly { readonly slug: string }[];
}): readonly string[] => {
  const roles = membership.roles?.map((role) => role.slug) ?? [];
  if (membership.role?.slug && !roles.includes(membership.role.slug))
    roles.unshift(membership.role.slug);
  return roles;
};

export const resolveOrganization = (deps: OrganizationAuthDeps, organizationId: string) =>
  Effect.gen(function* () {
    if (!isAllowedOrganization(deps.config, organizationId)) return null;
    const existing = yield* deps.organizations.getById(organizationId);
    if (existing) return existing;
    const remote = yield* deps.workos.getOrganization(organizationId);
    return yield* deps.organizations.upsert({ id: remote.id, name: remote.name });
  });

export const organizationIdFromSelector = (deps: OrganizationAuthDeps, selector: string) =>
  selector.startsWith("org_")
    ? Effect.succeed(selector)
    : deps.organizations
        .getBySlug(selector)
        .pipe(Effect.map((organization) => organization?.id ?? null));

export const authorizeUserOrganization = (
  deps: OrganizationAuthDeps,
  userId: string,
  organizationId: string,
) =>
  Effect.gen(function* () {
    if (!isAllowedOrganization(deps.config, organizationId)) return null;
    const membership = yield* deps.workos.getUserOrgMembership(organizationId, userId);
    if (!membership || membership.status !== "active") return null;
    const organization = yield* resolveOrganization(deps, organizationId);
    return organization ? { ...organization, roles: membershipRoles(membership) } : null;
  });

export const authorizeUserOrganizationSelector = (
  deps: OrganizationAuthDeps,
  userId: string,
  selector: string,
) =>
  Effect.gen(function* () {
    const organizationId = yield* organizationIdFromSelector(deps, selector);
    if (!organizationId) return null;
    return yield* authorizeUserOrganization(deps, userId, organizationId);
  });

export const authorizeServiceOrganization = (
  deps: OrganizationAuthDeps,
  clientId: string,
  organizationId: string,
): Effect.Effect<AuthorizedServiceOrganization | null, WorkOSRequestError | Error> =>
  Effect.gen(function* () {
    if (!isAllowedOrganization(deps.config, organizationId)) return null;
    if (
      deps.config.m2mAllowedClientIds.size === 0 ||
      !deps.config.m2mAllowedClientIds.has(clientId)
    ) {
      return null;
    }
    const application = yield* deps.workos.getConnectApplication(clientId);
    if (
      !application ||
      application.applicationType !== "m2m" ||
      application.clientId !== clientId ||
      application.organizationId !== deps.config.serviceOrganizationId
    ) {
      return null;
    }
    const organization = yield* resolveOrganization(deps, organizationId);
    return organization ? { ...organization, application } : null;
  });

export const selectedOrganization = (request: Request, fallback: string | null): string | null =>
  request.headers.get(ORG_SELECTOR_HEADER) ?? fallback;

export const rolesForMembership = membershipRoles;
