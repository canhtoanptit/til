import { describe, expect, it } from "vitest";
import {
  exportFormatLabel,
  fallbackExportFilename,
  filenameFromDisposition,
} from "./export-file";

describe("filenameFromDisposition", () => {
  it("reads the quoted filename the worker sends", () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="til-export-2026-08-13.json"',
      ),
    ).toBe("til-export-2026-08-13.json");
    expect(
      filenameFromDisposition('attachment; filename="til-export-2026-08-13.md"'),
    ).toBe("til-export-2026-08-13.md");
  });

  it("reads the unquoted and RFC 5987 forms too", () => {
    expect(
      filenameFromDisposition("attachment; filename=til-export-2026-08-13.json"),
    ).toBe("til-export-2026-08-13.json");
    expect(
      filenameFromDisposition(
        "attachment; filename*=UTF-8''til-export-2026-08-13.json",
      ),
    ).toBe("til-export-2026-08-13.json");
    // The star form wins when both are present, which is what the RFC says.
    expect(
      filenameFromDisposition(
        `attachment; filename="fallback.json"; filename*=UTF-8''til-export-2026-08-13.json`,
      ),
    ).toBe("til-export-2026-08-13.json");
  });

  it("returns null when there is nothing usable, so the caller can fall back", () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("")).toBeNull();
    expect(filenameFromDisposition("attachment")).toBeNull();
    expect(filenameFromDisposition('attachment; filename=""')).toBeNull();
  });

  it("refuses a header that tries to steer the download somewhere else", () => {
    // A response header is remote input and this value lands in a `download`
    // attribute, so a path is not a filename.
    expect(
      filenameFromDisposition('attachment; filename="../../etc/passwd"'),
    ).toBeNull();
    expect(
      filenameFromDisposition('attachment; filename="/absolute/evil.json"'),
    ).toBeNull();
    expect(
      filenameFromDisposition(String.raw`attachment; filename="..\windows\x"`),
    ).toBeNull();
    expect(filenameFromDisposition('attachment; filename=".."')).toBeNull();
    // A newline could split what the browser sees as the name.
    expect(
      filenameFromDisposition('attachment; filename="ok\ninjected"'),
    ).toBeNull();
  });
});

describe("fallbackExportFilename", () => {
  it("dates in UTC, matching the stamp the worker writes into the file", () => {
    // 23:30 UTC on the 12th is already the 13th at +02:00 — a local date here
    // would disagree with `exportedAt` inside the export.
    const lateUtc = Date.parse("2026-08-12T23:30:00.000Z");
    expect(fallbackExportFilename("json", lateUtc)).toBe(
      "til-export-2026-08-12.json",
    );
    expect(fallbackExportFilename("markdown", lateUtc)).toBe(
      "til-export-2026-08-12.md",
    );
  });
});

describe("exportFormatLabel", () => {
  it("names the two formats the way the buttons do", () => {
    expect(exportFormatLabel("json")).toBe("JSON backup");
    expect(exportFormatLabel("markdown")).toBe("Markdown bundle");
  });
});
