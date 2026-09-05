import { NavLink, Outlet } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
} from "lucide-react";
import { AUTH_ME_KEY, api, endSession } from "../api";
import { HealthDot } from "./HealthDot";
import { CommandPalette, useCommandPalette } from "./CommandPalette";
import { useTheme, type Theme } from "./theme-provider";
import { REVIEW_DUE_KEY } from "../pages/ReviewPage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Feed", end: true },
  { to: "/tags", label: "Tags", end: false },
  { to: "/review", label: "Review", end: false },
  { to: "/chat", label: "Chat", end: false },
  { to: "/digests", label: "Digests", end: false },
  { to: "/settings", label: "Settings", end: false },
] as const;

export function Shell() {
  const palette = useCommandPalette();
  const qc = useQueryClient();

  // `onSettled`, not `onSuccess`: the point of the button is to end the session
  // here. If the POST never lands the cookie may survive on the server, but the
  // cache is still wiped and the gate still closes — a failed sign-out that left
  // the reader looking at their library would be the worse outcome.
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => endSession(qc),
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
          <NavLink to="/" className="text-lg font-semibold tracking-tight">
            TIL
          </NavLink>
          <nav aria-label="primary" className="flex items-center gap-1">
            {NAV.map(({ to, label, end }) => (
              <NavLink key={to} to={to} end={end}>
                {({ isActive }) => (
                  <span
                    className={cn(
                      "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {label}
                    {to === "/review" && <DueBadge />}
                  </span>
                )}
              </NavLink>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-1"
              onClick={() => palette.setOpen(true)}
              aria-label="Search (Command K)"
              title="Search (⌘K)"
            >
              <SearchIcon />
            </Button>
            <ThemeToggle />
            <IdentityChip />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOutIcon />
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-3xl px-4 py-4">
        <HealthDot />
      </footer>
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
    </div>
  );
}

/**
 * Who is signed in — the one place a multi-user app has to say so, because the
 * data on every other page looks identical no matter whose account it is. Reads
 * the same cache entry `App` already filled, so it costs no extra request; the
 * email is the title rather than visible text to keep it out of screenshots.
 * Deliberately not a menu: sign-out is the button beside it.
 */
function IdentityChip() {
  const { data } = useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: () => api.me(),
    staleTime: Infinity,
  });
  if (!data) return null;
  const label = data.name ?? data.email;
  if (data.picture !== null) {
    return (
      <img
        src={data.picture}
        alt={label}
        title={data.email}
        className="ml-1 size-6 rounded-full"
      />
    );
  }
  return (
    <span
      title={data.email}
      aria-label={label}
      className="ml-1 inline-flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase text-muted-foreground"
    >
      {label.slice(0, 1)}
    </span>
  );
}

/**
 * How many cards are waiting. Asks for a single card (`limit=1`) purely for the
 * `dueCount` that rides along with it, so the badge costs one indexed count rather
 * than a second endpoint. Grading invalidates the shared `["reviews"]` prefix,
 * which is what refreshes this.
 */
function DueBadge() {
  const { data } = useQuery({
    queryKey: REVIEW_DUE_KEY,
    queryFn: ({ signal }) => api.reviewQueue({ limit: 1, signal }),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });
  const count = data?.dueCount ?? 0;
  if (count === 0) return null;
  return (
    <Badge
      variant="secondary"
      className="ml-1.5 px-1.5 py-0 text-[0.6875rem]"
      aria-label={`${count} cards due`}
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme}`}
        >
          {resolvedTheme === "dark" ? <MoonIcon /> : <SunIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v as Theme)}
        >
          <DropdownMenuRadioItem value="light">
            <SunIcon />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
