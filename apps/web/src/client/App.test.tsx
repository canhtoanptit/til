// See src/client/pages/DigestListPage.test.tsx for the client-test pattern.
//
// Only the gate is under test here, not the routes behind it. The session cookie
// is HttpOnly, so "signed in?" is a question only the server can answer — and the
// two ways that goes wrong are both invisible in a screenshot: rendering the
// library for a split second before the answer arrives, or leaving one reader's
// cached data in place when their session ends and the next one signs in.
//
// `../api` is deliberately NOT mocked. The 401 handoff lives inside `request()`,
// so a mocked `api` would test the harness rather than the wiring; `fetch` is
// stubbed instead and the real client code runs over it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { AUTH_ME_KEY, api, type MeDTO } from "./api";
import { renderWithProviders } from "./test-utils";
import { ThemeProvider } from "./components/theme-provider";
import { App } from "./App";

/** The one provider `renderWithProviders` does not supply — `Shell`'s theme
 * toggle throws without it, and the signed-in half of the gate renders `Shell`. */
function gate() {
  return (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

const USER: MeDTO = {
  id: "u1",
  email: "reader@example.com",
  name: "Reader",
  picture: null,
};

/** Path → response, as the worker would answer it. Anything unlisted 404s, which
 * every query in the tree already tolerates; only a 401 moves the gate. */
let routes: Record<string, { status: number; body: unknown }>;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const { pathname } = new URL(input, window.location.origin);
      const hit = routes[pathname] ?? {
        status: 404,
        body: { error: { code: "not_found", message: "Not found." } },
      };
      return Promise.resolve({
        status: hit.status,
        ok: hit.status >= 200 && hit.status < 300,
        json: () => Promise.resolve(hit.body),
        headers: { get: () => null },
      } as unknown as Response);
    }),
  );
}

beforeEach(() => {
  routes = {
    "/api/auth/me": { status: 401, body: {} },
    "/api/health": {
      status: 200,
      body: { ok: true, stack: "cloud", embedder: "ok" },
    },
    "/api/reviews/queue": {
      status: 200,
      body: { items: [], dueCount: 0, enrolledCount: 0 },
    },
  };
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const GOOGLE = { name: "Continue with Google" };

describe("App session gate", () => {
  it("waits for the session answer instead of guessing", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderWithProviders(gate());

    expect(screen.getByText("Checking your session…")).toBeTruthy();
    expect(screen.queryByRole("link", GOOGLE)).toBe(null);
    expect(screen.queryByRole("navigation", { name: "primary" })).toBe(null);
  });

  it("shows the sign-in page when there is no session", async () => {
    renderWithProviders(gate());

    expect(await screen.findByRole("link", GOOGLE)).toBeTruthy();
  });

  it("renders the app for a signed-in reader", async () => {
    routes["/api/auth/me"] = { status: 200, body: USER };
    renderWithProviders(gate());

    expect(
      await screen.findByRole("navigation", { name: "primary" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", GOOGLE)).toBe(null);
  });

  it("drops back to sign-in and empties the cache on a 401 anywhere", async () => {
    routes["/api/auth/me"] = { status: 200, body: USER };
    const { queryClient } = renderWithProviders(gate(), { route: "/nope" });

    await screen.findByRole("navigation", { name: "primary" });
    queryClient.setQueryData(["tags"], { items: [{ tag: "css", count: 3 }] });

    // Any call, not just the session one: this is the expired-mid-session case.
    routes["/api/tags"] = { status: 401, body: {} };
    await act(async () => {
      await api.listTags().catch(() => undefined);
    });

    expect(await screen.findByRole("link", GOOGLE)).toBeTruthy();
    await waitFor(() =>
      expect(queryClient.getQueryData(["tags"])).toBe(undefined),
    );
    // Pinned to null rather than merely cleared, so the gate closes without a
    // second spinner while a refetch decides the same thing.
    expect(queryClient.getQueryData(AUTH_ME_KEY)).toBe(null);
  });
});
