import { NavLink, Outlet } from "react-router";
import { clearToken } from "../api";
import { HealthDot } from "./HealthDot";

export function Shell() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `rounded px-3 py-1.5 text-sm font-medium transition ${
      isActive
        ? "bg-slate-900 text-white"
        : "text-slate-700 hover:bg-slate-100"
    }`;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <NavLink to="/" className="text-lg font-semibold tracking-tight">
            TIL
          </NavLink>
          <nav aria-label="primary" className="flex items-center gap-1">
            <NavLink to="/" end className={linkClass}>
              Feed
            </NavLink>
            <NavLink to="/digests" className={linkClass}>
              Digests
            </NavLink>
            <NavLink to="/settings" className={linkClass}>
              Settings
            </NavLink>
            <button
              type="button"
              onClick={() => clearToken()}
              className="ml-2 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
              aria-label="Sign out"
              title="Sign out"
            >
              sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-3xl px-4 py-4">
        <HealthDot />
      </footer>
    </div>
  );
}
