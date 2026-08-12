import { NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LogOutIcon, MonitorIcon, MoonIcon, SearchIcon, SunIcon } from "lucide-react";
import { api, clearToken } from "../api";
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
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => clearToken()}
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
