import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Effect } from "effect";

import { Button } from "@executor-js/react/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@executor-js/react/components/dropdown-menu";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { useAuth } from "@executor-js/react/multiplayer/auth-context";

interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

const readJson = (response: Response): Promise<unknown | null> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => response.json(),
      catch: () => "invalid_json" as const,
    }).pipe(Effect.orElseSucceed(() => null)),
  );

export function WorkOSOrgMenu() {
  const auth = useAuth();
  const [organizations, setOrganizations] = useState<readonly OrganizationSummary[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/auth/organizations", { credentials: "same-origin" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!alive || !body || typeof body !== "object" || !("organizations" in body)) return;
        const items = (body as { organizations?: unknown }).organizations;
        if (Array.isArray(items)) setOrganizations(items as OrganizationSummary[]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (auth.status !== "authenticated") return null;

  const createOrganization = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    const response = await fetch("/api/auth/create-organization", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    const body = (await readJson(response)) as OrganizationSummary | null;
    if (response.ok && body?.slug) {
      window.location.assign(`/${body.slug}`);
      return;
    }
    setCreating(false);
    setError(
      response.status === 403
        ? "Organization creation is managed by your operator."
        : "Unable to create organization.",
    );
  };

  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        Organization
      </DropdownMenuLabel>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-xs">
          <span className="min-w-0 flex-1 truncate">
            {auth.organization?.name ?? "No organization"}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          {organizations === null ? (
            <DropdownMenuItem disabled>Loading...</DropdownMenuItem>
          ) : organizations.length === 0 ? (
            <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
          ) : (
            organizations.map((organization) => (
              <DropdownMenuItem
                key={organization.id}
                disabled={organization.id === auth.organization?.id}
                onClick={() => window.location.assign(`/${organization.slug}`)}
              >
                <span className="truncate">{organization.name}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setName("");
              setError(null);
              setOpen(true);
            }}
          >
            <Plus className="size-4" />
            Create organization
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>Create a new WorkOS-backed Executor workspace.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="workos-org-name">Name</Label>
            <Input
              id="workos-org-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createOrganization();
              }}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void createOrganization()} disabled={!name.trim() || creating}>
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CreateFirstOrganization() {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    const response = await fetch("/api/auth/create-organization", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const body = (await readJson(response)) as OrganizationSummary | null;
    if (response.ok && body?.slug) {
      window.location.assign(`/${body.slug}`);
      return;
    }
    setCreating(false);
    setError(
      response.status === 403
        ? "Ask your operator to add you to a WorkOS organization."
        : "Unable to create organization.",
    );
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-foreground">Create an organization</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Executor data and credentials are isolated by WorkOS organization.
        </p>
        <div className="mt-6 grid gap-2">
          <Label htmlFor="first-workos-org-name">Organization name</Label>
          <Input
            id="first-workos-org-name"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button
            className="mt-2"
            onClick={() => void submit()}
            disabled={!name.trim() || creating}
          >
            {creating ? "Creating..." : "Create organization"}
          </Button>
        </div>
      </section>
    </main>
  );
}
