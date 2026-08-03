import { useState, type FormEvent } from "react";
import { setToken } from "../api";

export function TokenGate() {
  const [value, setValue] = useState("");
  const [showHint, setShowHint] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setToken(trimmed);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-slate-900">TIL</h1>
        <p className="mt-1 text-sm text-slate-600">
          Enter your app token to continue.
        </p>
        <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="til-token">
          App token
        </label>
        <input
          id="til-token"
          name="token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          aria-describedby="til-token-hint"
        />
        <button
          type="button"
          onClick={() => setShowHint((s) => !s)}
          className="mt-2 text-xs text-slate-500 underline"
        >
          {showHint ? "hide hint" : "hint"}
        </button>
        {showHint && (
          <p id="til-token-hint" className="mt-1 text-xs text-slate-500">
            Local dev token is <code className="rounded bg-slate-100 px-1">dev-token</code>.
          </p>
        )}
        <button
          type="submit"
          disabled={!value.trim()}
          className="mt-4 w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Save
        </button>
      </form>
    </div>
  );
}
