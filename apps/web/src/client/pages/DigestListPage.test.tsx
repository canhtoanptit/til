// See src/client/pages/ReviewPage.test.tsx for the client-test pattern.
//
// What is worth testing here: the page has two buttons that hit one endpoint and
// differ only by the `kind` they send. A wrong kind is invisible on this page —
// the run goes off to a Workflow and comes back minutes later as the wrong thing
// — so the posted body is the assertion, not the rendering.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, type DigestSummaryDTO } from "../api";
import { renderWithProviders } from "../test-utils";
import { DigestListPage } from "./DigestListPage";

const mocks = vi.hoisted(() => ({
  listDigests: vi.fn(),
  runDigest: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { listDigests: mocks.listDigests, runDigest: mocks.runDigest },
  };
});

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const WEEKLY = "Run now";
const REPORT = "Run monthly report";

function summary(over: Partial<DigestSummaryDTO> = {}): DigestSummaryDTO {
  return {
    id: "d1",
    runAt: 1_700_000_000_000,
    windowDays: 7,
    kind: "weekly",
    status: "ready",
    title: "Week in review",
    intro: "Four things worth your time.",
    itemCount: 4,
    error: null,
    ...over,
  } as DigestSummaryDTO;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDigests.mockResolvedValue({ items: [] });
  mocks.runDigest.mockResolvedValue({ id: "new-run" });
});

describe("DigestListPage runs", () => {
  it("posts the weekly kind from Run now", async () => {
    const u = userEvent.setup();
    const { currentPath } = renderWithProviders(<DigestListPage />, {
      route: "/digests",
    });

    await u.click(await screen.findByRole("button", { name: WEEKLY }));

    expect(mocks.runDigest).toHaveBeenCalledWith({ kind: "weekly" });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Digest run started", {
        description:
          "Gathering and ranking candidates — this takes a minute or two.",
      }),
    );
    // And it lands on the run it just started.
    await waitFor(() => expect(currentPath()).toBe("/digests/new-run"));
  });

  it("posts the monthly-report kind from the report button", async () => {
    const u = userEvent.setup();
    renderWithProviders(<DigestListPage />, { route: "/digests" });

    await u.click(await screen.findByRole("button", { name: REPORT }));

    expect(mocks.runDigest).toHaveBeenCalledWith({ kind: "monthly-report" });
    expect(mocks.runDigest).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Report run started", {
        description:
          "Reading back over the month — this takes a minute or two.",
      }),
    );
  });

  it("disables both buttons while either run is in flight", async () => {
    let release: (() => void) | undefined;
    mocks.runDigest.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ id: "r1" }))),
    );
    const u = userEvent.setup();
    renderWithProviders(<DigestListPage />, { route: "/digests" });

    await u.click(await screen.findByRole("button", { name: REPORT }));

    // One run at a time: the weekly button cannot start a second one, and only
    // the button that was pressed says so.
    const weekly = screen.getByRole("button", { name: WEEKLY });
    expect((weekly as HTMLButtonElement).disabled).toBe(true);
    const starting = screen.getByRole("button", { name: "Starting…" });
    expect((starting as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: REPORT })).toBeNull();

    await u.click(weekly);
    expect(mocks.runDigest).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: WEEKLY }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("toasts in the failed run's own words", async () => {
    mocks.runDigest.mockRejectedValue(
      new ApiError("network_error", "offline", 0),
    );
    const u = userEvent.setup();
    renderWithProviders(<DigestListPage />, { route: "/digests" });

    await u.click(await screen.findByRole("button", { name: REPORT }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not start a report run",
        { description: "Network error — could not reach the server." },
      ),
    );
    // A failed run leaves both buttons usable.
    expect(
      (screen.getByRole("button", { name: WEEKLY }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("lists existing runs without offering to start one twice", async () => {
    mocks.listDigests.mockResolvedValue({
      items: [
        summary(),
        summary({ id: "d2", kind: "monthly-report", title: "Your July" }),
      ],
    });

    renderWithProviders(<DigestListPage />, { route: "/digests" });

    expect(await screen.findByText("Week in review")).toBeTruthy();
    expect(screen.getByText("Your July")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: WEEKLY })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: REPORT })).toHaveLength(1);
    expect(mocks.runDigest).not.toHaveBeenCalled();
  });
});
