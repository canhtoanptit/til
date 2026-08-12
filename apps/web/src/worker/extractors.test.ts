import { describe, expect, it } from "vitest";
import { ReadabilityExtractor, WorkersAIExtractor } from "./extractors.js";
import { ExtractionError } from "@til/core";
import type { Extractor } from "@til/core";

const ARTICLE_URL = "https://example.dev/posts/ownership";

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Ownership in Rust &amp; why it matters | example.dev</title>
    <meta name="description" content="A tour of the borrow checker." />
    <style>.ad { display: none }</style>
    <script>window.analytics = { track(){} };</script>
  </head>
  <body>
    <header id="site-header"><a href="/">example.dev</a></header>
    <nav class="site-nav"><ul><li><a href="/archive">Archive</a></li><li><a href="/about">About Me</a></li></ul></nav>
    <aside class="sidebar"><h3>Sponsored</h3><p>Buy our JavaScript course today for only nine dollars!</p></aside>
    <article>
      <h1>Ownership in Rust and why it matters</h1>
      <p>The borrow checker is the part of the Rust compiler that enforces
      ownership rules. Every value has exactly one owner, and when that owner
      goes out of scope the value is dropped. This is the whole trick: memory
      safety without a garbage collector, decided entirely at compile time.</p>
      <h2>Borrowing</h2>
      <p>A reference borrows a value without taking ownership of it. You may
      have any number of shared references, or exactly one mutable reference,
      but never both at once. That single rule is what rules out data races in
      safe Rust, and it is checked statically rather than at runtime.</p>
      <pre><code>fn main() {
    let s = String::from("hi");
    takes(&amp;s);
}</code></pre>
      <ul>
        <li>One owner per value, always.</li>
        <li>Shared references are immutable.</li>
        <li>Lifetimes describe how long a borrow may live.</li>
      </ul>
      <p>Once these rules are internalised, most fights with the compiler turn
      into fights you would otherwise have had with a debugger, months later in
      production, at three in the morning.</p>
      <img src="/img/diagram.png" alt="Ownership moves from caller to callee" />
      <p>See the <a href="/book/ch04">ownership chapter</a> for the full story.</p>
    </article>
    <footer><p>Copyright 2026 example.dev. All rights reserved worldwide.</p></footer>
    <script>document.body.classList.add('loaded');</script>
  </body>
</html>`;

describe("ReadabilityExtractor", () => {
  it("extracts the article and strips nav, sidebar, script and style", async () => {
    const out = await new ReadabilityExtractor().toMarkdown(
      ARTICLE_HTML,
      ARTICLE_URL,
    );

    expect(out.markdown).toContain("borrow checker");
    expect(out.markdown).toContain(
      "Lifetimes describe how long a borrow may live",
    );

    expect(out.markdown).not.toContain("window.analytics");
    expect(out.markdown).not.toContain("classList");
    expect(out.markdown).not.toContain("display: none");
    expect(out.markdown).not.toContain("JavaScript course");
    expect(out.markdown).not.toContain("Archive");
  });

  it("finds the title and decodes entities in it", async () => {
    const out = await new ReadabilityExtractor().toMarkdown(
      ARTICLE_HTML,
      ARTICLE_URL,
    );
    expect(out.title).toContain("Ownership in Rust");
    expect(out.title).not.toContain("&amp;");
  });

  it("renders markdown structure rather than flat text", async () => {
    const out = await new ReadabilityExtractor().toMarkdown(
      ARTICLE_HTML,
      ARTICLE_URL,
    );
    expect(out.markdown).toMatch(/^## Borrowing$/m);
    expect(out.markdown).toContain("```");
    expect(out.markdown).toMatch(/^- +One owner per value, always\.$/m);
  });

  it("resolves relative links against the page url", async () => {
    const out = await new ReadabilityExtractor().toMarkdown(
      ARTICLE_HTML,
      ARTICLE_URL,
    );
    expect(out.markdown).toContain("https://example.dev/book/ch04");
  });

  it("reduces images to alt text so data URIs cannot bloat the digest", async () => {
    const out = await new ReadabilityExtractor().toMarkdown(
      ARTICLE_HTML,
      ARTICLE_URL,
    );
    expect(out.markdown).toContain("Ownership moves from caller to callee");
    expect(out.markdown).not.toContain("/img/diagram.png");
  });

  it("throws ExtractionError on junk HTML with no article", async () => {
    await expect(
      new ReadabilityExtractor().toMarkdown(
        "<html><body><div><span>404</span></div></body></html>",
        "https://example.dev/missing",
      ),
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it("throws ExtractionError on empty input", async () => {
    await expect(
      new ReadabilityExtractor().toMarkdown("", "https://example.dev/"),
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it("throws ExtractionError on non-HTML noise", async () => {
    await expect(
      new ReadabilityExtractor().toMarkdown(
        "<<<>>> not markup at all",
        "https://example.dev/",
      ),
    ).rejects.toBeInstanceOf(ExtractionError);
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

/**
 * The mock's shape is the contract, so it is written out in full rather than
 * minimally: `{ id, name, mimeType, format, tokens, data }`, a single object for a
 * single input document, `format: "error"` in band for a per-file failure. Verified
 * 2026-08-12 against @cloudflare/workers-types 5.20260801.1 and the Workers AI
 * markdown-conversion binding reference (docs page last updated 2026-07-13).
 */
describe("WorkersAIExtractor.documentToMarkdown (PDF)", () => {
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

  function recordingAi(result: unknown) {
    const calls: { name: string; type: string; size: number }[] = [];
    return {
      calls,
      ai: {
        toMarkdown: async (input: { name: string; blob: Blob }) => {
          calls.push({
            name: input.name,
            type: input.blob.type,
            size: input.blob.size,
          });
          return result as never;
        },
      },
    };
  }

  it("submits the bytes as an application/pdf blob under a .pdf name", async () => {
    const { ai, calls } = recordingAi({
      id: "01JZ",
      name: "paper.pdf",
      mimeType: "application/pdf",
      format: "markdown",
      tokens: 4096,
      data: "# Attention Is All You Need\n\nThe dominant sequence transduction models...",
    });
    const out = await new WorkersAIExtractor(ai).documentToMarkdown(
      PDF_BYTES,
      "https://arxiv.test/pdf/paper.pdf",
      "application/pdf",
    );

    // The name and mime type are how the service picks its converter, so both are
    // part of the contract, not decoration.
    expect(calls).toEqual([
      { name: "paper.pdf", type: "application/pdf", size: PDF_BYTES.byteLength },
    ]);
    expect(out.markdown).toContain("dominant sequence transduction");
    // A PDF has no <title>; the first heading is the closest thing to one.
    expect(out.title).toBe("Attention Is All You Need");
  });

  it("falls back to a host-based .pdf name when the url has no filename", async () => {
    const { ai, calls } = recordingAi({
      format: "markdown",
      data: "Body text with no heading at all, which is normal for a scanned-in report.",
    });
    const out = await new WorkersAIExtractor(ai).documentToMarkdown(
      PDF_BYTES,
      "https://arxiv.test/pdf/2401.00001",
      "application/pdf",
    );
    expect(calls[0]?.name).toBe("arxiv.test.pdf");
    // No heading means no title hint — the digest writes its own.
    expect(out.title).toBeUndefined();
  });

  it("accepts an array response for a single document", async () => {
    // The binding mirrors input arity, but a single-element array is cheap to
    // tolerate and the alternative is a crash if that ever changes.
    const { ai } = recordingAi([
      { id: "1", format: "markdown", data: "# Paper\n\nSome prose." },
    ]);
    const out = await new WorkersAIExtractor(ai).documentToMarkdown(
      PDF_BYTES,
      "https://example.test/a.pdf",
      "application/pdf",
    );
    expect(out.markdown).toContain("Some prose");
  });

  it("turns an in-band per-file error into an ExtractionError carrying its message", async () => {
    // A failed conversion does not throw — it comes back as format: "error".
    const { ai } = recordingAi({
      id: "1",
      name: "a.pdf",
      mimeType: "application/pdf",
      format: "error",
      error: "Some error that prevented this file from being converted",
    });
    await expect(
      new WorkersAIExtractor(ai).documentToMarkdown(
        PDF_BYTES,
        "https://example.test/a.pdf",
        "application/pdf",
      ),
    ).rejects.toThrow(/prevented this file from being converted/);
  });

  it("explains an empty result as a scanned PDF rather than 'markdown was empty'", async () => {
    // There is no OCR in the PDF path, so a picture of a page yields nothing and
    // the owner deserves to be told why.
    const { ai } = recordingAi({ format: "markdown", data: "   \n  " });
    await expect(
      new WorkersAIExtractor(ai).documentToMarkdown(
        PDF_BYTES,
        "https://example.test/scan.pdf",
        "application/pdf",
      ),
    ).rejects.toThrow(/no extractable text.*does not run OCR/s);
  });

  it("turns a thrown binding failure into an ExtractionError", async () => {
    const ai = {
      toMarkdown: async () => {
        throw new Error("AI binding unavailable");
      },
    };
    await expect(
      new WorkersAIExtractor(ai).documentToMarkdown(
        PDF_BYTES,
        "https://example.test/a.pdf",
        "application/pdf",
      ),
    ).rejects.toThrow(/env\.AI\.toMarkdown failed: AI binding unavailable/);
  });

  it("rejects an empty body before spending a conversion on it", async () => {
    const { ai, calls } = recordingAi({ format: "markdown", data: "x" });
    await expect(
      new WorkersAIExtractor(ai).documentToMarkdown(
        new Uint8Array(0),
        "https://example.test/a.pdf",
        "application/pdf",
      ),
    ).rejects.toBeInstanceOf(ExtractionError);
    expect(calls).toEqual([]);
  });
});

describe("ReadabilityExtractor as the local stack's extractor", () => {
  it("has no documentToMarkdown — the capability ingest reads as 'no PDFs here'", () => {
    // This is the seam the local-stack PDF failure is derived from, so it is
    // asserted rather than assumed. Typed as the interface, which is how ingest sees
    // it: on the concrete class the optional method is not even in the type.
    const local: Extractor = new ReadabilityExtractor();
    expect(local.documentToMarkdown).toBeUndefined();
    const cloud: Extractor = new WorkersAIExtractor({
      toMarkdown: async () => ({}),
    });
    expect(cloud.documentToMarkdown).toBeTypeOf("function");
  });
});
