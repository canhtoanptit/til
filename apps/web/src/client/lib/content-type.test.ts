import { describe, expect, it } from "vitest";
import { contentTypeBadge } from "./content-type";

describe("contentTypeBadge", () => {
  it("leaves an article unbadged", () => {
    // The badge marks what is *not* a web page; badging every card marks nothing.
    expect(contentTypeBadge("article")).toBeNull();
  });

  it("labels a pdf", () => {
    expect(contentTypeBadge("pdf")).toEqual({
      label: "PDF",
      hint: expect.stringContaining("PDF"),
    });
  });

  it("labels a video and calls transcript capture experimental", () => {
    const badge = contentTypeBadge("video");
    expect(badge?.label).toBe("Video");
    // Required copy: any UI that mentions the YouTube path says it is experimental.
    expect(badge?.hint).toMatch(/experimental/i);
    expect(badge?.hint).toMatch(/youtube/i);
  });
});
