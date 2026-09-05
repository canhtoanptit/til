import { useEffect } from "react";
import { Route, Routes } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AUTH_ME_KEY, api, endSession, onUnauthorized } from "./api";
import { Shell } from "./components/Shell";
import { LoginPage } from "./components/LoginPage";
import { Spinner } from "./components/Spinner";
import { FeedPage } from "./pages/FeedPage";
import { EntryDetailPage } from "./pages/EntryDetailPage";
import { ChatListPage } from "./pages/ChatListPage";
import { ChatPage } from "./pages/ChatPage";
import { ReviewPage } from "./pages/ReviewPage";
import { TagsPage } from "./pages/TagsPage";
import { TagFeedPage } from "./pages/TagFeedPage";
import { DigestListPage } from "./pages/DigestListPage";
import { DigestDetailPage } from "./pages/DigestDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Card } from "@/components/ui/card";

export function App() {
  const qc = useQueryClient();

  // The session cookie is HttpOnly, so "am I signed in?" is a question only the
  // server can answer. Asked once per load and never refetched on its own
  // (`staleTime: Infinity`); `retry: false` because a 401 is already folded into
  // `api.me()` as null, so a rejection here is a real outage, not a logged-out
  // state worth three attempts.
  const me = useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: () => api.me(),
    staleTime: Infinity,
    retry: false,
  });

  // A 401 from any call means the cookie died under us. On first load that call
  // is this very query — harmless, `endSession` only pins the answer it is about
  // to get anyway — and mid-session it is whatever page the reader was on.
  useEffect(() => onUnauthorized(() => endSession(qc)), [qc]);

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Spinner label="Checking your session…" />
      </div>
    );
  }

  if (!me.data) return <LoginPage />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<FeedPage />} />
        <Route path="/entries/:id" element={<EntryDetailPage />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/tags/:tag" element={<TagFeedPage />} />
        <Route path="/chat" element={<ChatListPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/digests" element={<DigestListPage />} />
        <Route path="/digests/:id" element={<DigestDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <Card className="gap-0 p-6 text-center">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        That page doesn't exist.
      </p>
    </Card>
  );
}
