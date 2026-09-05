import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AUTH_ME_KEY, api } from "../api";
import { friendlyMessage } from "./ErrorBanner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The whole app behind one question: who are you. Shown by `App` whenever the
 * session query comes back null, so it never needs to know how it got here —
 * first visit, sign-out, or an expired cookie all land in the same place.
 */
export function LoginPage() {
  // Same query key `HealthDot` uses, so the two share one response. `stack` is
  // the only thing read here: the dev-login endpoint exists only when the worker
  // runs locally, and offering a form that 404s would be worse than hiding it.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    retry: false,
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm gap-4">
        <CardHeader>
          <CardTitle className="text-lg">TIL</CardTitle>
          <CardDescription>
            Sign in to save and search your reading.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* A plain anchor, not a fetch: /api/auth/google answers with a 302 to
              Google, and only a top-level navigation can follow it. */}
          <Button asChild className="w-full">
            <a href="/api/auth/google">Continue with Google</a>
          </Button>
          {health.data?.stack === "local" && <DevLogin />}
        </CardContent>
      </Card>
    </div>
  );
}

/** Local-stack only. Matches `.dev.vars.example`'s OWNER_EMAIL default, so the
 * out-of-the-box dev session claims the pre-seeded owner row and its data. */
function DevLogin() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("dev@example.com");

  const login = useMutation({
    mutationFn: (value: string) => api.devLogin(value),
    // Seeding the cache directly is what dismisses this page: `App` reads the
    // same key, and the cookie is already set by the time this resolves.
    onSuccess: (user) => qc.setQueryData(AUTH_ME_KEY, user),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    login.mutate(trimmed);
  }

  return (
    <>
      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or, on local dev</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <form onSubmit={onSubmit}>
        <Label htmlFor="til-dev-email">Email</Label>
        <Input
          id="til-dev-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={login.isPending || email.trim().length === 0}
          className="mt-3 w-full"
        >
          {login.isPending ? "Signing in…" : "Dev sign-in"}
        </Button>
        {login.error !== null && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {friendlyMessage(login.error)}
          </p>
        )}
      </form>
    </>
  );
}
