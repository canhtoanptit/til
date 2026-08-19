/**
 * ============================================================================
 * Client render tests — the pattern. Copy this file's shape, not its subject.
 * ============================================================================
 *
 * WHERE THIS RUNS
 *   `vitest.config.ts` defines two projects. Anything under `src/client` that
 *   matches `*.test.ts(x)` lands in the `client` project: happy-dom environment,
 *   the `@/` alias, and `src/client/test-setup.ts` (Testing Library `cleanup`
 *   after each test — this repo runs vitest without globals, so RTL's own
 *   auto-cleanup never registers itself). Nothing else is needed to add a test.
 *
 * MOCKING THE API
 *   Every client surface talks to the server through the `api` object in
 *   `src/client/api.ts`. Replace that object and nothing else:
 *
 *     vi.mock("../api", async (importOriginal) => {
 *       const actual = await importOriginal<typeof import("../api")>();
 *       return { ...actual, api: mockApi };
 *     });
 *
 *   The partial form matters: `ApiError` and `friendlyMessage` are real classes
 *   and functions that components branch on (`e instanceof ApiError`), and a
 *   whole-module mock breaks that in a way that looks like a component bug.
 *   `vi.mock` is hoisted above imports, so build `mockApi` with `vi.hoisted`.
 *
 * MOCKING TOASTS
 *   `sonner`'s real `<Toaster>` needs the ThemeProvider and renders into a
 *   portal. Mock the module instead and assert on the spy — a toast is an
 *   observable side effect, so that is the honest assertion either way.
 *
 * PROVIDERS
 *   `renderWithProviders` from `../test-utils` supplies the router and a
 *   react-query client with retries off. Its `currentPath()` reads the real
 *   router location, so navigation assertions go through actual routing rather
 *   than a mocked `useNavigate`.
 *
 * TIMERS
 *   Real ones, plus `waitFor`. Fake timers were tried and rejected: React 19
 *   flushes effects through a scheduler that `vi.advanceTimersByTime` does not
 *   drive, so a faked clock made debounce tests hang rather than settle. Where a
 *   test needs to prove something has *not* happened yet (a debounce), it
 *   asserts synchronously right after the interaction and then `waitFor`s the
 *   eventual call — which is deterministic without owning the clock.
 *
 * RADIX
 *   Query by role and accessible name. Never by `data-slot`: Radix's `asChild`
 *   triggers render the child element, whose own `data-slot` wins, so the
 *   attribute you read in the component source is not the one in the DOM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EntryDetailDTO,
  ReviewQueueItemDTO,
  ReviewQueueResponse,
} from "../api";
import { renderWithProviders } from "../test-utils";
import { ReviewPage } from "./ReviewPage";

const mocks = vi.hoisted(() => ({
  reviewQueue: vi.fn(),
  getEntry: vi.fn(),
  gradeReview: vi.fn(),
  enrollReview: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      reviewQueue: mocks.reviewQueue,
      getEntry: mocks.getEntry,
      gradeReview: mocks.gradeReview,
      enrollReview: mocks.enrollReview,
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

function card(over: Partial<ReviewQueueItemDTO> = {}): ReviewQueueItemDTO {
  return {
    entryId: "e1",
    title: "Structured concurrency",
    question: "What problem does structured concurrency solve?",
    url: "https://example.com/sc",
    sourceDomain: "example.com",
    state: "review",
    dueAt: 1,
    intervalDays: 3,
    ease: 2.5,
    lapses: 0,
    ...over,
  };
}

function entry(over: Partial<EntryDetailDTO> = {}): EntryDetailDTO {
  return {
    id: "e1",
    url: "https://example.com/sc",
    canonicalUrl: "https://example.com/sc",
    title: "Structured concurrency",
    sourceDomain: "example.com",
    summary: "A longer walk through nurseries and cancel scopes.",
    takeaway: "Every task has a parent that outlives it.",
    question: "What problem does structured concurrency solve?",
    tags: ["concurrency"],
    contentType: "article",
    favorite: false,
    archived: false,
    note: null,
    status: "ready",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    contentMarkdown: null,
    ...over,
  } as EntryDetailDTO;
}

/**
 * The queue endpoint is stateful in the app's terms: grading a card removes it.
 * A fixed mock response would make the graded card reappear on the invalidation
 * that `onSuccess` fires, so the fake keeps the same invariant the server does.
 */
function statefulQueue(items: ReviewQueueItemDTO[]) {
  let remaining = [...items];
  mocks.reviewQueue.mockImplementation((): Promise<ReviewQueueResponse> =>
    Promise.resolve({ items: remaining, dueCount: remaining.length }),
  );
  mocks.gradeReview.mockImplementation((entryId: string) => {
    remaining = remaining.filter((i) => i.entryId !== entryId);
    return Promise.resolve({
      entryId,
      state: "review" as const,
      dueAt: 2,
      intervalDays: 3,
      ease: 2.5,
      lapses: 0,
      lastGrade: 3 as const,
      reviewedAt: 1,
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReviewPage", () => {
  it("shows the question and withholds the answer until it is revealed", async () => {
    statefulQueue([card()]);
    mocks.getEntry.mockResolvedValue(entry());

    renderWithProviders(<ReviewPage />, { route: "/review" });

    expect(
      await screen.findByText(
        "What problem does structured concurrency solve?",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Structured concurrency" }),
    ).toBeTruthy();

    // The reveal is a second request on purpose, so the answer is not in the
    // queue payload at all. Nothing should have asked for the entry yet.
    expect(mocks.getEntry).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Every task has a parent that outlives it."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Good/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
  });

  it("fetches and shows the answer when Reveal is clicked", async () => {
    statefulQueue([card()]);
    mocks.getEntry.mockResolvedValue(entry());
    const user = userEvent.setup();

    renderWithProviders(<ReviewPage />, { route: "/review" });
    await user.click(await screen.findByRole("button", { name: "Reveal" }));

    expect(
      await screen.findByText("Every task has a parent that outlives it."),
    ).toBeTruthy();
    expect(mocks.getEntry).toHaveBeenCalledWith("e1", expect.anything());
    const takeaway = screen.getByLabelText("Takeaway");
    expect(within(takeaway).getByRole("heading").textContent).toBe("Takeaway");
    expect(
      screen.getByText("A longer walk through nurseries and cancel scopes."),
    ).toBeTruthy();
  });

  it("grades through the API and advances to the next card", async () => {
    statefulQueue([card(), card({ entryId: "e2", title: "Vector clocks" })]);
    mocks.getEntry.mockResolvedValue(entry());
    const user = userEvent.setup();

    renderWithProviders(<ReviewPage />, { route: "/review" });
    await user.click(await screen.findByRole("button", { name: "Reveal" }));
    await user.click(await screen.findByRole("button", { name: /^Good/ }));

    expect(mocks.gradeReview).toHaveBeenCalledWith("e1", 3);
    expect(
      await screen.findByRole("heading", { name: "Vector clocks" }),
    ).toBeTruthy();
    // Back to question-first for the new card.
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Good", {
        description: "Back in 3 days.",
      }),
    );
  });

  it("reveals on space and grades on 1-4 from the keyboard", async () => {
    statefulQueue([card(), card({ entryId: "e2", title: "Vector clocks" })]);
    mocks.getEntry.mockResolvedValue(entry());
    const user = userEvent.setup();

    renderWithProviders(<ReviewPage />, { route: "/review" });
    await screen.findByRole("button", { name: "Reveal" });

    await user.keyboard("[Space]");
    expect(
      await screen.findByText("Every task has a parent that outlives it."),
    ).toBeTruthy();

    await user.keyboard("1");
    await waitFor(() =>
      expect(mocks.gradeReview).toHaveBeenCalledWith("e1", 1),
    );
    expect(
      await screen.findByRole("heading", { name: "Vector clocks" }),
    ).toBeTruthy();

    await user.keyboard("[Space]");
    await screen.findByText("Every task has a parent that outlives it.");
    await user.keyboard("4");
    await waitFor(() =>
      expect(mocks.gradeReview).toHaveBeenCalledWith("e2", 4),
    );
  });

  it("explains what review is when nothing is due", async () => {
    statefulQueue([]);

    renderWithProviders(<ReviewPage />, { route: "/review" });

    expect(await screen.findByText("Nothing due. Nice work.")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "What is review?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add my saved entries" }),
    ).toBeTruthy();
    expect(screen.getByText("all caught up")).toBeTruthy();
    expect(mocks.getEntry).not.toHaveBeenCalled();
  });
});
