// See src/client/pages/ReviewPage.test.tsx for the client-test pattern.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, type FeedDTO } from "../api";
import { renderWithProviders } from "../test-utils";
import { DigestSourcesCard } from "./DigestSourcesCard";

const mocks = vi.hoisted(() => ({
  listFeeds: vi.fn(),
  createFeed: vi.fn(),
  setFeedEnabled: vi.fn(),
  deleteFeed: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      listFeeds: mocks.listFeeds,
      createFeed: mocks.createFeed,
      setFeedEnabled: mocks.setFeedEnabled,
      deleteFeed: mocks.deleteFeed,
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

function feed(over: Partial<FeedDTO> = {}): FeedDTO {
  return {
    id: "f1",
    url: "https://blog.example.com/feed.xml",
    title: "Example Blog",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Every mutation here invalidates ["feeds"], so a fixed list response would
 * un-do whatever the test just did. The fake keeps server-side state instead. */
function statefulFeeds(initial: FeedDTO[]) {
  let items = [...initial];
  mocks.listFeeds.mockImplementation(() => Promise.resolve({ items }));
  mocks.createFeed.mockImplementation((url: string) => {
    const created = feed({ id: `f${items.length + 1}`, url, title: null });
    items = [...items, created];
    return Promise.resolve(created);
  });
  mocks.setFeedEnabled.mockImplementation((id: string, enabled: boolean) => {
    const found = items.find((f) => f.id === id);
    if (!found) return Promise.reject(new ApiError("not_found", "gone", 404));
    const next = { ...found, enabled };
    items = items.map((f) => (f.id === id ? next : f));
    return Promise.resolve(next);
  });
  mocks.deleteFeed.mockImplementation((id: string) => {
    items = items.filter((f) => f.id !== id);
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DigestSourcesCard", () => {
  it("lists the configured sources", async () => {
    statefulFeeds([
      feed(),
      feed({
        id: "f2",
        url: "https://other.example.org/atom",
        title: null,
        enabled: false,
      }),
    ]);
    renderWithProviders(<DigestSourcesCard />);

    expect(await screen.findByText("Example Blog")).toBeTruthy();
    // No title, so the host stands in.
    expect(screen.getByText("other.example.org")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "https://blog.example.com/feed.xml" })
        .getAttribute("href"),
    ).toBe("https://blog.example.com/feed.xml");
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Disable source: Example Blog" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Enable source: other.example.org" }),
    ).toBeTruthy();
  });

  it("explains itself when there are no sources yet", async () => {
    statefulFeeds([]);
    renderWithProviders(<DigestSourcesCard />);

    expect(await screen.findByText(/No feeds yet/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Add source" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("adds a source, clears the input, and shows the new row", async () => {
    statefulFeeds([]);
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);
    await screen.findByText(/No feeds yet/);

    const input = screen.getByLabelText("Feed URL");
    await u.type(input, "https://new.example.net/rss  ");
    await u.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() =>
      expect(mocks.createFeed).toHaveBeenCalledWith(
        "https://new.example.net/rss",
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Source added", {
      description: "new.example.net",
    });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
    expect(await screen.findByText("new.example.net")).toBeTruthy();
  });

  it("treats a duplicate as already-done rather than a failure", async () => {
    statefulFeeds([feed()]);
    mocks.createFeed.mockRejectedValue(
      new ApiError("duplicate_url", "already there", 409),
    );
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);
    await screen.findByText("Example Blog");

    const input = screen.getByLabelText("Feed URL");
    await u.type(input, "https://blog.example.com/feed.xml");
    await u.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        "That source is already in your list",
      ),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("keeps the typed URL when the add really fails", async () => {
    statefulFeeds([]);
    mocks.createFeed.mockRejectedValue(
      new ApiError("invalid_url", "nope", 400),
    );
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);
    await screen.findByText(/No feeds yet/);

    const input = screen.getByLabelText("Feed URL");
    await u.type(input, "https://broken.example.net/rss");
    await u.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not add that source",
        {
          description: "That URL doesn't look right.",
        },
      ),
    );
    expect((input as HTMLInputElement).value).toBe(
      "https://broken.example.net/rss",
    );
  });

  it("toggles a source through the enable/disable API", async () => {
    statefulFeeds([feed()]);
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);

    await u.click(
      await screen.findByRole("switch", {
        name: "Disable source: Example Blog",
      }),
    );

    await waitFor(() =>
      expect(mocks.setFeedEnabled).toHaveBeenCalledWith("f1", false),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Source disabled", {
      description: "blog.example.com",
    });
    // The switch is driven by server state, so the label flips only after the refetch.
    expect(
      await screen.findByRole("switch", {
        name: "Enable source: Example Blog",
      }),
    ).toBeTruthy();
    // And with nothing enabled, the digest falls back to the built-in sources.
    expect(await screen.findByText(/Every feed is disabled/)).toBeTruthy();

    await u.click(
      screen.getByRole("switch", { name: "Enable source: Example Blog" }),
    );
    await waitFor(() =>
      expect(mocks.setFeedEnabled).toHaveBeenLastCalledWith("f1", true),
    );
  });

  it("does nothing when the remove confirmation is cancelled", async () => {
    statefulFeeds([feed()]);
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);

    await u.click(
      await screen.findByRole("button", {
        name: "Remove source: Example Blog",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      screen.getByRole("heading", { name: "Remove this source?" }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("https://blog.example.com/feed.xml");

    await u.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.deleteFeed).not.toHaveBeenCalled();
    expect(screen.getByText("Example Blog")).toBeTruthy();
  });

  it("deletes the source when the confirmation is confirmed", async () => {
    statefulFeeds([feed()]);
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);

    await u.click(
      await screen.findByRole("button", {
        name: "Remove source: Example Blog",
      }),
    );
    await screen.findByRole("alertdialog");
    await u.click(screen.getByRole("button", { name: "Remove permanently" }));

    await waitFor(() => expect(mocks.deleteFeed).toHaveBeenCalledWith("f1"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Source removed");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText(/No feeds yet/)).toBeTruthy();
  });

  it("closes the confirmation and toasts when the delete fails", async () => {
    statefulFeeds([feed()]);
    mocks.deleteFeed.mockRejectedValue(new ApiError("not_found", "gone", 404));
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);

    await u.click(
      await screen.findByRole("button", {
        name: "Remove source: Example Blog",
      }),
    );
    await screen.findByRole("alertdialog");
    await u.click(screen.getByRole("button", { name: "Remove permanently" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not remove that source",
        { description: "Not found." },
      ),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("Example Blog")).toBeTruthy();
  });

  it("surfaces a failed list with a retry", async () => {
    mocks.listFeeds.mockRejectedValue(
      new ApiError("network_error", "offline", 0),
    );
    const u = userEvent.setup();
    renderWithProviders(<DigestSourcesCard />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByText("Network error — could not reach the server."),
    ).toBeTruthy();

    mocks.listFeeds.mockResolvedValue({ items: [feed()] });
    await u.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Example Blog")).toBeTruthy();
  });
});
