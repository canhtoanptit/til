import { NavLink, Outlet } from "react-router";
import { LogOutIcon, MonitorIcon, MoonIcon, SearchIcon, SunIcon } from "lucide-react";
import { clearToken } from "../api";
import { HealthDot } from "./HealthDot";
import { CommandPalette, useCommandPalette } from "./CommandPalette";
import { useTheme, type Theme } from "./theme-provider";
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
