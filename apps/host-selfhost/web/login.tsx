import { LogIn } from "lucide-react";

import { Button } from "@executor-js/react/components/button";
import { Wordmark } from "@executor-js/react/components/wordmark";

const loginHref = (): string => {
  if (typeof window === "undefined") return "/api/auth/login";
  const returnTo = `${window.location.pathname}${window.location.search}`;
  return returnTo === "/"
    ? "/api/auth/login"
    : `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
};

export function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="w-full max-w-sm text-center">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <h1 className="text-xl font-semibold text-foreground">Sign in to Executor</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Continue through your organization&apos;s WorkOS sign-in.
        </p>
        <Button asChild className="mt-6 w-full">
          <a href={loginHref()}>
            <LogIn className="size-4" />
            Continue with WorkOS
          </a>
        </Button>
      </section>
    </main>
  );
}
