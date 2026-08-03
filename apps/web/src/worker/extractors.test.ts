import { describe, expect, it } from "vitest";
import { DevFallbackExtractor, WorkersAIExtractor } from "./extractors.js";
import { ExtractionError } from "@til/core";

describe("DevFallbackExtractor", () => {
  it("strips scripts/styles and decodes entities", async () => {
    const e = new DevFallbackExtractor();
    const html = `
      <html>
        <head><title>Hello &amp; World</title><style>a{color:red}</style></head>
        <body>
          <script>alert('x')</script>
          <nav>Menu</nav>
          <p>First &lt;paragraph&gt;.</p>
          <p>Second paragraph.</p>
        </body>
      </html>
    `;
    const out = await e.toMarkdown(html, "https://example.com");
    expect(out.title).toBe("Hello & World");
    expect(out.markdown).toContain("First <paragraph>.");
    expect(out.markdown).toContain("Second paragraph.");
    expect(out.markdown).not.toContain("alert");
    expect(out.markdown).not.toContain("color:red");
    expect(out.markdown).not.toContain("Menu");
  });

  it("throws on empty input", async () => {
    const e = new DevFallbackExtractor();
    await expect(e.toMarkdown("", "https://example.com")).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });
});

describe("WorkersAIExtractor", () => {
  it("returns markdown from ConversionResult", async () => {
    const ai = {
      toMarkdown: async () => ({
        id: "1",
        name: "a.html",
        format: "markdown" as const,
        mimetype: "text/html",
        tokens: 10,
        data: "# Hello\n\nWorld",
      }),
    };
    const e = new WorkersAIExtractor(ai);
    const out = await e.toMarkdown(
      "<title>Doc</title><p>x</p>",
      "https://example.com/",
    );
    expect(out.markdown).toBe("# Hello\n\nWorld");
    expect(out.title).toBe("Doc");
  });

  it("throws ExtractionError on error format", async () => {
    const ai = {
      toMarkdown: async () => ({ format: "error" as const, error: "boom" }),
    };
    const e = new WorkersAIExtractor(ai);
    await expect(
      e.toMarkdown("<html/>", "https://example.com"),
    ).rejects.toBeInstanceOf(ExtractionError);
  });
});
