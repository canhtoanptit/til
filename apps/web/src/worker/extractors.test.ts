import { describe, expect, it } from "vitest";
import { ReadabilityExtractor, WorkersAIExtractor } from "./extractors.js";
import { ExtractionError } from "@til/core";

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
