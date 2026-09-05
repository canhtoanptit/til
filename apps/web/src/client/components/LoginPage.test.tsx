// See src/client/pages/DigestListPage.test.tsx for the client-test pattern.
//
// What is worth testing here: this page is the only door into the app, and two
// of its three behaviours fail silently. A `fetch`ed Google button would follow
// the 302 in the background and appear to do nothing; a dev-login form rendered
// against a deployed worker would post to an endpoint that only exists locally.
// So the assertions are the anchor's href, the stack gate, and that a successful
// dev sign-in actually seeds the session cache the app gate reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { AUTH_ME_KEY, ApiError, type MeDTO } from "../api";
import { renderWithProviders } from "../test-utils";
import { LoginPage } from "./LoginPage";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  devLogin: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { health: mocks.health, devLogin: mocks.devLogin },
  };
});

/**
 * Stands in for the observer `App` keeps on the session query — both so the
 * seeded value is visible in the DOM, and because without an observer the test
 * client's `gcTime: 0` collects the entry the moment it is written.
 */
function SessionProbe() {
  const { data } = useQuery<MeDTO | null>({
    queryKey: AUTH_ME_KEY,
    queryFn: () => Promise.resolve(null),
    enabled: false,
  });
  return <span data-session="">{data ? data.email : "signed out"}</span>;
}

const DEV_USER: MeDTO = {
  id: "owner",
  email: "dev@example.com",
  name: "Dev",
  picture: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.health.mockResolvedValue({
    ok: true,
    stack: "local",
    embedder: "ok",
  });
  mocks.devLogin.mockResolvedValue(DEV_USER);
});

describe("LoginPage", () => {
  it("sends Google sign-in through a top-level navigation, not a fetch", async () => {
    renderWithProviders(<LoginPage />);

    const link = await screen.findByRole("link", {
      name: "Continue with Google",
    });
    expect(link.getAttribute("href")).toBe("/api/auth/google");
  });

  it("offers the dev sign-in only on the local stack", async () => {
    mocks.health.mockResolvedValue({
      ok: true,
      stack: "cloud",
      embedder: "ok",
    });
    renderWithProviders(<LoginPage />);

    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Dev sign-in" })).toBeNull();
    // The Google button is the only way in either way.
    expect(
      screen.getByRole("link", { name: "Continue with Google" }),
    ).toBeTruthy();
  });

  it("signs in with the dev endpoint and seeds the session query", async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <>
        <LoginPage />
        <SessionProbe />
      </>,
    );

    await u.click(await screen.findByRole("button", { name: "Dev sign-in" }));

    // The default email matches .dev.vars.example's OWNER_EMAIL, so the
    // out-of-the-box dev session claims the pre-seeded owner row.
    expect(mocks.devLogin).toHaveBeenCalledWith("dev@example.com");
    // Seeding the cache is the whole handoff — the app gate reads this entry and
    // nothing else, so a sign-in that did not write it would leave the reader
    // staring at the sign-in page they just used.
    await waitFor(() => expect(screen.getByText(DEV_USER.email)).toBeTruthy());
  });

  it("posts the edited email", async () => {
    const u = userEvent.setup();
    renderWithProviders(<LoginPage />);

    const input = await screen.findByLabelText("Email");
    await u.clear(input);
    await u.type(input, "alice@example.com");
    await u.click(screen.getByRole("button", { name: "Dev sign-in" }));

    expect(mocks.devLogin).toHaveBeenCalledWith("alice@example.com");
  });

  it("shows the server's reason when dev sign-in is refused", async () => {
    mocks.devLogin.mockRejectedValue(
      new ApiError("not_found", "Not found.", 404),
    );
    const u = userEvent.setup();
    renderWithProviders(
      <>
        <LoginPage />
        <SessionProbe />
      </>,
    );

    await u.click(await screen.findByRole("button", { name: "Dev sign-in" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Not found.");
    // And the gate stays shut.
    expect(screen.getByText("signed out")).toBeTruthy();
  });
});
