import { useEffect, useState } from "react";
import { Route, Routes } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getToken, subscribeToken } from "./api";
import { Shell } from "./components/Shell";
import { TokenGate } from "./components/TokenGate";
import { FeedPage } from "./pages/FeedPage";
import { EntryDetailPage } from "./pages/EntryDetailPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const qc = useQueryClient();
  const [token, setTokenState] = useState<string | null>(() => getToken());

  useEffect(
    () =>
      subscribeToken((t) => {
        setTokenState(t);
        if (t === null) {
          // Purge cached data so a new session doesn't inherit stale state.
          qc.clear();
        }
      }),
    [qc],
  );

  if (!token) return <TokenGate />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<FeedPage />} />
        <Route path="/entries/:id" element={<EntryDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="rounded border border-slate-200 bg-white p-6 text-center">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-1 text-sm text-slate-600">That page doesn't exist.</p>
    </div>
  );
}
