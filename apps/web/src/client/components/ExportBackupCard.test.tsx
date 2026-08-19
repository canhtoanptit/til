// See src/client/pages/ReviewPage.test.tsx for the client-test pattern.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api";
import { renderWithProviders } from "../test-utils";
import { ExportBackupCard } from "./ExportBackupCard";

const mocks = vi.hoisted(() => ({
  exportBackup: vi.fn(),
  saveBlob: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { exportBackup: mocks.exportBackup } };
});

// Partial: `exportFormatLabel` is real (the pending copy reads it), only the
// browser-download side effect is replaced.
vi.mock("../export-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../export-file")>();
  return { ...actual, saveBlob: mocks.saveBlob };
});

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

function jsonButton() {
  return screen.getByRole("button", { name: /Download JSON backup|Preparing/ });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ExportBackupCard", () => {
  it("downloads the JSON backup and confirms with the filename", async () => {
    const blob = new Blob(["{}"], { type: "application/json" });
    mocks.exportBackup.mockResolvedValue({
      blob,
      filename: "til-export-2026-08-19.json",
    });
    const user = userEvent.setup();
    renderWithProviders(<ExportBackupCard />);

    await user.click(
      screen.getByRole("button", { name: "Download JSON backup" }),
    );

    await waitFor(() =>
      expect(mocks.saveBlob).toHaveBeenCalledWith(
        blob,
        "til-export-2026-08-19.json",
      ),
    );
    expect(mocks.exportBackup).toHaveBeenCalledWith("json");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Export ready", {
      description: "til-export-2026-08-19.json",
    });
  });

  it("downloads the markdown bundle from the second button", async () => {
    const blob = new Blob(["# til"], { type: "text/markdown" });
    mocks.exportBackup.mockResolvedValue({
      blob,
      filename: "til-export-2026-08-19.md",
    });
    const user = userEvent.setup();
    renderWithProviders(<ExportBackupCard />);

    await user.click(
      screen.getByRole("button", { name: "Download markdown bundle" }),
    );

    await waitFor(() =>
      expect(mocks.exportBackup).toHaveBeenCalledWith("markdown"),
    );
    expect(mocks.saveBlob).toHaveBeenCalledWith(
      blob,
      "til-export-2026-08-19.md",
    );
  });

  it("disables both buttons while one export is in flight", async () => {
    let release: (() => void) | undefined;
    mocks.exportBackup.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ blob: new Blob(["{}"]), filename: "til-export.json" });
        }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ExportBackupCard />);

    await user.click(
      screen.getByRole("button", { name: "Download JSON backup" }),
    );

    // Only one export may be in flight — it reads the whole library.
    const md = await screen.findByRole("button", {
      name: "Download markdown bundle",
    });
    expect((jsonButton() as HTMLButtonElement).disabled).toBe(true);
    expect((md as HTMLButtonElement).disabled).toBe(true);
    expect(jsonButton().textContent).toContain("Preparing");
    // Only the clicked one says "Preparing"; the other keeps its label.
    expect(md.textContent).toBe("Download markdown bundle");
    expect(screen.getByRole("status").textContent).toContain("JSON backup");

    release?.();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Download JSON backup",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("toasts and does not download when the export fails", async () => {
    mocks.exportBackup.mockRejectedValue(
      new ApiError("unknown", "export blew up", 500),
    );
    const user = userEvent.setup();
    renderWithProviders(<ExportBackupCard />);

    await user.click(
      screen.getByRole("button", { name: "Download JSON backup" }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not build the export",
        {
          description: "export blew up",
        },
      ),
    );
    expect(mocks.saveBlob).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    // The buttons come back so a failure is retryable.
    expect(
      (
        screen.getByRole("button", {
          name: "Download JSON backup",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("says out loud that the API key is not in the backup", () => {
    renderWithProviders(<ExportBackupCard />);
    expect(screen.getByText("deliberately not included")).toBeTruthy();
  });
});
