import { createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ExecutorProvider } from "@executor-js/react/api/provider";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { OrganizationProvider } from "@executor-js/react/api/organization-context";
import { OrgSlugGate } from "@executor-js/react/multiplayer/org-slug-gate";
import { Toaster } from "@executor-js/react/components/sonner";
import { AuthProvider, useAuth } from "@executor-js/react/multiplayer/auth-context";
import { Shell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";

import { LoginPage } from "../login";
import { CreateFirstOrganization, WorkOSOrgMenu } from "../workos-org-menu";

// ---------------------------------------------------------------------------
// WorkOS AuthKit is the only browser identity provider in the owned self-host.
// ---------------------------------------------------------------------------

export const Route = createRootRoute({
  notFoundComponent: NotFoundPage,
  component: RootComponent,
});

const selfHostNavItems = [
  ...defaultShellNavItems,
  { to: "/api-keys", label: "API keys" },
  { to: "/org", label: "Organization" },
];

const signOut = async () => {
  window.location.assign("/api/auth/logout");
};

function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="w-full max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">404</p>
        <h1 className="mt-2 text-xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          There&apos;s nothing at this address.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
        >
          Go home
        </a>
      </section>
    </main>
  );
}

const Loading = () => (
  <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
    Loading…
  </div>
);

function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.status === "loading") return <Loading />;
  if (auth.status === "unauthenticated") return <LoginPage />;
  return <>{children}</>;
}

function AuthenticatedApp() {
  const auth = useAuth();
  const organization = auth.status === "authenticated" ? (auth.organization ?? null) : null;
  if (!organization) return <CreateFirstOrganization />;

  const gated = (
    <>
      <Shell onSignOut={signOut} navItems={selfHostNavItems} orgMenuSlot={<WorkOSOrgMenu />} />
      <Toaster />
    </>
  );

  return (
    <ExecutorProvider>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        <OrganizationProvider organizationId={organization.id} organizationSlug={organization.slug}>
          <OrgSlugGate activeSlug={organization.slug}>{gated}</OrgSlugGate>
        </OrganizationProvider>
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}

function RootComponent() {
  return (
    <AuthProvider>
      <AuthGate>
        <AuthenticatedApp />
      </AuthGate>
    </AuthProvider>
  );
}
