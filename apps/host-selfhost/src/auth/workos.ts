import {
  WorkOS,
  type Invitation,
  type Organization,
  type OrganizationMembership,
  type User,
} from "@workos-inc/node";
import { Data, Effect } from "effect";

import type { WorkOSConfig } from "../config";

export const WORKOS_SESSION_COOKIE = "wos-session";

type RawWorkOS = WorkOS & {
  readonly get: (
    path: string,
    options?: { readonly query?: Record<string, unknown> },
  ) => Promise<{ readonly data: unknown }>;
  readonly post: (path: string, entity: unknown) => Promise<{ readonly data: unknown }>;
};

export class WorkOSRequestError extends Data.TaggedError("WorkOSRequestError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly status: number | undefined;
}> {}

const errorStatus = (cause: unknown): number | undefined => {
  if (!cause || typeof cause !== "object") return undefined;
  const status = (cause as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

const request = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkOSRequestError({ operation, cause, status: errorStatus(cause) }),
  });

const collect = async <A>(response: {
  readonly data: A[];
  readonly listMetadata: { readonly after?: string | null };
  readonly autoPagination: () => Promise<A[]>;
}): Promise<readonly A[]> =>
  response.listMetadata.after ? await response.autoPagination() : response.data;

export const workosApiUrlOptions = (
  url: string | undefined,
): { apiHostname?: string; port?: number; https?: boolean } => {
  if (!url) return {};
  const parsed = new URL(url);
  return {
    apiHostname: parsed.hostname,
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
    https: parsed.protocol === "https:",
  };
};

export interface WorkOSBrowserSession {
  readonly accountId: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly organizationId: string | null;
  readonly sessionId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly sealedSession: string;
  readonly refreshedSession: string | null;
}

export interface ConnectApplication {
  readonly id: string;
  readonly clientId: string;
  readonly organizationId: string;
  readonly applicationType: "m2m" | "oauth";
  readonly scopes: readonly string[];
}

export interface WorkOSClient {
  readonly userJwksUrl: string;
  readonly getAuthorizationUrl: (state: string) => string;
  readonly authenticateWithCode: (code: string) => Effect.Effect<
    {
      readonly sealedSession?: string;
      readonly organizationId?: string;
      readonly user: User;
    },
    WorkOSRequestError
  >;
  readonly authenticateSealedSession: (
    sessionData: string,
  ) => Effect.Effect<WorkOSBrowserSession | null, WorkOSRequestError>;
  readonly refreshSession: (
    sessionData: string,
    organizationId?: string,
  ) => Effect.Effect<string | null, WorkOSRequestError>;
  readonly getLogoutUrl: (
    sessionData: string,
    returnTo: string,
  ) => Effect.Effect<string, WorkOSRequestError>;
  readonly createOrganization: (name: string) => Effect.Effect<Organization, WorkOSRequestError>;
  readonly updateOrganization: (
    organizationId: string,
    name: string,
  ) => Effect.Effect<Organization, WorkOSRequestError>;
  readonly getOrganization: (
    organizationId: string,
  ) => Effect.Effect<Organization, WorkOSRequestError>;
  readonly createMembership: (
    organizationId: string,
    userId: string,
    roleSlug?: string,
  ) => Effect.Effect<OrganizationMembership, WorkOSRequestError>;
  readonly listUserMemberships: (
    userId: string,
  ) => Effect.Effect<readonly OrganizationMembership[], WorkOSRequestError>;
  readonly listOrgMembers: (
    organizationId: string,
  ) => Effect.Effect<readonly OrganizationMembership[], WorkOSRequestError>;
  readonly getUserOrgMembership: (
    organizationId: string,
    userId: string,
  ) => Effect.Effect<OrganizationMembership | null, WorkOSRequestError>;
  readonly getOrgMembership: (
    membershipId: string,
  ) => Effect.Effect<OrganizationMembership, WorkOSRequestError>;
  readonly getUser: (userId: string) => Effect.Effect<User, WorkOSRequestError>;
  readonly sendInvitation: (input: {
    readonly email: string;
    readonly organizationId: string;
    readonly roleSlug?: string;
  }) => Effect.Effect<Invitation, WorkOSRequestError>;
  readonly deleteOrgMembership: (membershipId: string) => Effect.Effect<void, WorkOSRequestError>;
  readonly updateOrgMembershipRole: (
    membershipId: string,
    roleSlug: string,
  ) => Effect.Effect<OrganizationMembership, WorkOSRequestError>;
  readonly listOrgRoles: (
    organizationId: string,
  ) => Effect.Effect<
    readonly { readonly slug: string; readonly name: string }[],
    WorkOSRequestError
  >;
  readonly validateApiKey: (value: string) => Effect.Effect<unknown, WorkOSRequestError>;
  readonly listUserApiKeys: (
    userId: string,
    organizationId: string,
  ) => Effect.Effect<unknown, WorkOSRequestError>;
  readonly createUserApiKey: (input: {
    readonly userId: string;
    readonly organizationId: string;
    readonly name: string;
  }) => Effect.Effect<unknown, WorkOSRequestError>;
  readonly deleteApiKey: (keyId: string) => Effect.Effect<void, WorkOSRequestError>;
  readonly getConnectApplication: (
    clientId: string,
  ) => Effect.Effect<ConnectApplication | null, WorkOSRequestError>;
}

const connectApplication = (value: unknown): ConnectApplication | null => {
  const raw =
    value && typeof value === "object" && "connect_application" in value
      ? (value as { connect_application: unknown }).connect_application
      : value;
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const applicationType = item.application_type ?? item.applicationType;
  const clientId = item.client_id ?? item.clientId;
  const organizationId = item.organization_id ?? item.organizationId;
  if (
    (applicationType !== "m2m" && applicationType !== "oauth") ||
    typeof item.id !== "string" ||
    typeof clientId !== "string" ||
    typeof organizationId !== "string"
  ) {
    return null;
  }
  return {
    id: item.id,
    clientId,
    organizationId,
    applicationType,
    scopes: Array.isArray(item.scopes)
      ? item.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
};

export const makeWorkOSClient = (config: WorkOSConfig): WorkOSClient => {
  const workos = new WorkOS({
    apiKey: config.apiKey,
    clientId: config.clientId,
    ...workosApiUrlOptions(config.apiUrl),
  });
  const raw = workos as RawWorkOS;

  return {
    userJwksUrl: workos.userManagement.getJwksUrl(config.clientId),
    getAuthorizationUrl: (state) =>
      workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        redirectUri: config.redirectUri,
        clientId: config.clientId,
        state,
      }),

    authenticateWithCode: (code) =>
      request("authenticate_with_code", () =>
        workos.userManagement.authenticateWithCode({
          code,
          clientId: config.clientId,
          session: { sealSession: true, cookiePassword: config.cookiePassword },
        }),
      ),

    authenticateSealedSession: (sessionData) =>
      Effect.gen(function* () {
        if (!sessionData) return null;
        const session = workos.userManagement.loadSealedSession({
          sessionData,
          cookiePassword: config.cookiePassword,
        });
        const initial = yield* request("authenticate_sealed_session", () => session.authenticate());
        let authenticated = initial;
        let sealedSession = sessionData;
        let refreshedSession: string | null = null;
        if (!authenticated.authenticated) {
          const refreshed = yield* request("refresh_sealed_session", () =>
            session.refresh({ cookiePassword: config.cookiePassword }),
          );
          if (!refreshed.authenticated || !refreshed.sealedSession) return null;
          refreshedSession = refreshed.sealedSession;
          sealedSession = refreshed.sealedSession;
          authenticated = yield* request("authenticate_refreshed_session", () =>
            workos.userManagement
              .loadSealedSession({
                sessionData: refreshed.sealedSession!,
                cookiePassword: config.cookiePassword,
              })
              .authenticate(),
          );
          if (!authenticated.authenticated) return null;
        }
        return {
          accountId: authenticated.user.id,
          email: authenticated.user.email,
          name:
            [authenticated.user.firstName, authenticated.user.lastName].filter(Boolean).join(" ") ||
            null,
          avatarUrl: authenticated.user.profilePictureUrl ?? null,
          organizationId: authenticated.organizationId ?? null,
          sessionId: authenticated.sessionId,
          roles: authenticated.roles ?? (authenticated.role ? [authenticated.role] : []),
          permissions: authenticated.permissions ?? [],
          sealedSession,
          refreshedSession,
        };
      }),

    refreshSession: (sessionData, organizationId) =>
      Effect.gen(function* () {
        const session = workos.userManagement.loadSealedSession({
          sessionData,
          cookiePassword: config.cookiePassword,
        });
        const refreshed = yield* request("refresh_session", () =>
          session.refresh({
            cookiePassword: config.cookiePassword,
            ...(organizationId ? { organizationId } : {}),
          }),
        );
        return refreshed.authenticated ? (refreshed.sealedSession ?? null) : null;
      }),

    getLogoutUrl: (sessionData, returnTo) =>
      request("get_logout_url", () =>
        workos.userManagement
          .loadSealedSession({ sessionData, cookiePassword: config.cookiePassword })
          .getLogoutUrl({ returnTo }),
      ),

    createOrganization: (name) =>
      request("create_organization", () => workos.organizations.createOrganization({ name })),
    updateOrganization: (organizationId, name) =>
      request("update_organization", () =>
        workos.organizations.updateOrganization({ organization: organizationId, name }),
      ),
    getOrganization: (organizationId) =>
      request("get_organization", () => workos.organizations.getOrganization(organizationId)),
    createMembership: (organizationId, userId, roleSlug) =>
      request("create_membership", () =>
        workos.userManagement.createOrganizationMembership({
          organizationId,
          userId,
          ...(roleSlug ? { roleSlug } : {}),
        }),
      ),
    listUserMemberships: (userId) =>
      request("list_user_memberships", async () =>
        collect(
          await workos.userManagement.listOrganizationMemberships({
            userId,
            statuses: ["active", "pending"],
          }),
        ),
      ),
    listOrgMembers: (organizationId) =>
      request("list_org_members", async () =>
        collect(
          await workos.userManagement.listOrganizationMemberships({
            organizationId,
            statuses: ["active", "pending"],
          }),
        ),
      ),
    getUserOrgMembership: (organizationId, userId) =>
      request("get_user_org_membership", async () => {
        const result = await workos.userManagement.listOrganizationMemberships({
          organizationId,
          userId,
          statuses: ["active", "pending"],
        });
        return result.data[0] ?? null;
      }),
    getOrgMembership: (membershipId) =>
      request("get_org_membership", () =>
        workos.userManagement.getOrganizationMembership(membershipId),
      ),
    getUser: (userId) => request("get_user", () => workos.userManagement.getUser(userId)),
    sendInvitation: (input) =>
      request("send_invitation", () => workos.userManagement.sendInvitation(input)),
    deleteOrgMembership: (membershipId) =>
      request("delete_org_membership", () =>
        workos.userManagement.deleteOrganizationMembership(membershipId),
      ),
    updateOrgMembershipRole: (membershipId, roleSlug) =>
      request("update_org_membership_role", () =>
        workos.userManagement.updateOrganizationMembership(membershipId, { roleSlug }),
      ),
    listOrgRoles: (organizationId) =>
      request("list_org_roles", async () => {
        const result = await workos.organizations.listOrganizationRoles({ organizationId });
        return result.data;
      }),

    validateApiKey: (value) =>
      request("validate_api_key", () => workos.apiKeys.validateApiKey({ value })),
    listUserApiKeys: (userId, organizationId) =>
      request("list_user_api_keys", async () => {
        const response = await raw.get(`/user_management/users/${userId}/api_keys`, {
          query: { organization_id: organizationId, limit: 100 },
        });
        return response.data;
      }),
    createUserApiKey: ({ userId, organizationId, name }) =>
      request("create_user_api_key", async () => {
        const response = await raw.post(`/user_management/users/${userId}/api_keys`, {
          name,
          organization_id: organizationId,
        });
        return response.data;
      }),
    deleteApiKey: (keyId) => request("delete_api_key", () => workos.apiKeys.deleteApiKey(keyId)),
    getConnectApplication: (clientId) =>
      request("get_connect_application", async () => {
        const response = await raw.get(`/connect/applications/${clientId}`);
        return connectApplication(response.data);
      }),
  };
};

export const isAllowedOrganization = (config: WorkOSConfig, organizationId: string): boolean =>
  config.allowedOrganizationIds.size === 0 || config.allowedOrganizationIds.has(organizationId);
