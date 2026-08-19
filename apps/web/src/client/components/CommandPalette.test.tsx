// See src/client/pages/ReviewPage.test.tsx for the client-test pattern (api
// mocking, providers, timers, Radix querying).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EntryDTO } from "../api";
import { renderWithProviders } from "../test-utils";
import { CommandPalette, useCommandPalette } from "./CommandPalette";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { search: mocks.search } };
});

function result(over: Partial<EntryDTO> = {}): EntryDTO {
  return {
    id: "e1",
    url: "https://example.com/a",
    canonicalUrl: "https://example.com/a",
    title: "Structured concurrency",
    sourceDomain: "example.com",
    summary: null,
    takeaway: null,
    question: null,
    tags: [],
    contentType: "article",
    favorite: false,
    archived: false,
    note: null,
    status: "ready",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Mirrors how Shell mounts the palette: the hook owns `open`, the component
 * renders it. Testing them apart would not prove that ⌘K reaches the dialog. */
function Host() {
  const { open, setOpen } = useCommandPalette();
  return <CommandPalette open={open} onOpenChange={setOpen} />;
}

function openPalette() {
  return renderWithProviders(<Host />, { route: "/" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CommandPalette", () => {
  it("opens on Cmd+K and closes on a second press", async () => {
    const user = userEvent.setup();
    openPalette();

    expect(
      screen.queryByPlaceholderText(/Search your saved entries/),
    ).toBeNull();

    await user.keyboard("{Meta>}k{/Meta}");
    expect(
      await screen.findByPlaceholderText(/Search your saved entries/),
    ).toBeTruthy();

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/Search your saved entries/),
      ).toBeNull(),
    );
  });

  it("opens on Ctrl+K too", async () => {
    const user = userEvent.setup();
    openPalette();
    await user.keyboard("{Control>}k{/Control}");
    expect(
      await screen.findByPlaceholderText(/Search your saved entries/),
    ).toBeTruthy();
  });

  it("lists every nav destination and navigates on select", async () => {
    const user = userEvent.setup();
    const view = openPalette();
    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByPlaceholderText(/Search your saved entries/);

    for (const label of [
      "Go to Feed",
      "Go to Tags",
      "Go to Review",
      "Go to Chat",
      "Go to Digests",
      "Go to Settings",
    ]) {
      expect(screen.getByRole("option", { name: label })).toBeTruthy();
    }
    expect(mocks.search).not.toHaveBeenCalled();

    await user.click(screen.getByRole("option", { name: "Go to Review" }));
    await waitFor(() => expect(view.currentPath()).toBe("/review"));
  });

  it("debounces the query, then renders the server's results", async () => {
    mocks.search.mockResolvedValue({ items: [result()] });
    const user = userEvent.setup();
    openPalette();
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByPlaceholderText(
      /Search your saved entries/,
    );

    await user.type(input, "concurrency");
    // Typing eleven characters must not be eleven requests: the 200ms debounce
    // means nothing has been asked for at the moment the last key lands.
    expect(mocks.search).not.toHaveBeenCalled();

    expect(
      await screen.findByRole("option", { name: /Structured concurrency/ }),
    ).toBeTruthy();
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith("concurrency", expect.anything());
    // The nav list gives way to results while searching.
    expect(screen.queryByRole("option", { name: "Go to Feed" })).toBeNull();
  });

  it("navigates to the entry when a result is selected", async () => {
    mocks.search.mockResolvedValue({ items: [result({ id: "e 1/x" })] });
    const user = userEvent.setup();
    const view = openPalette();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      await screen.findByPlaceholderText(/Search your saved entries/),
      "conc",
    );

    await user.click(
      await screen.findByRole("option", { name: /Structured concurrency/ }),
    );
    await waitFor(() => expect(view.currentPath()).toBe("/entries/e%201%2Fx"));
  });

  it("does not re-filter server results client-side", async () => {
    // "qqqq" shares no character with the title or the domain, so cmdk's fuzzy
    // filter would score this row zero and hide it. The palette turns the filter
    // off while searching precisely so a semantic match still shows up.
    mocks.search.mockResolvedValue({ items: [result()] });
    const user = userEvent.setup();
    openPalette();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      await screen.findByPlaceholderText(/Search your saved entries/),
      "qqqq",
    );

    expect(
      await screen.findByRole("option", { name: /Structured concurrency/ }),
    ).toBeTruthy();
  });

  it("falls back to the URL when a result has no title", async () => {
    mocks.search.mockResolvedValue({
      items: [
        result({ title: "   ", canonicalUrl: "https://example.com/raw" }),
      ],
    });
    const user = userEvent.setup();
    openPalette();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      await screen.findByPlaceholderText(/Search your saved entries/),
      "raw",
    );

    expect(
      await screen.findByRole("option", { name: /https:\/\/example.com\/raw/ }),
    ).toBeTruthy();
  });

  it("reports an empty result set with the query in it", async () => {
    mocks.search.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    openPalette();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      await screen.findByPlaceholderText(/Search your saved entries/),
      "nothing",
    );

    expect(await screen.findByText('No entries match "nothing".')).toBeTruthy();
  });

  it("clears the query between openings", async () => {
    mocks.search.mockResolvedValue({ items: [result()] });
    const user = userEvent.setup();
    openPalette();
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByPlaceholderText(
      /Search your saved entries/,
    );
    await user.type(input, "conc");
    await screen.findByRole("option", { name: /Structured concurrency/ });

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/Search your saved entries/),
      ).toBeNull(),
    );
    await user.keyboard("{Meta>}k{/Meta}");

    const reopened = await screen.findByPlaceholderText(
      /Search your saved entries/,
    );
    expect((reopened as HTMLInputElement).value).toBe("");
    expect(
      await screen.findByRole("option", { name: "Go to Feed" }),
    ).toBeTruthy();
  });
});
