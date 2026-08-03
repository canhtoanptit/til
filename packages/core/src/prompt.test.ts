import { describe, expect, it } from "vitest";
import { DigestError } from "./errors.js";
import {
  buildUserMessage,
  DIGEST_JSON_SCHEMA,
  DIGEST_SYSTEM_PROMPT,
  MAX_MARKDOWN_CHARS,
  parseDigest,
} from "./prompt.js";

describe("buildUserMessage", () => {
  it("includes url, title, and body wrapped in <article>", () => {
    const msg = buildUserMessage("body content", {
      url: "https://example.com",
      title: "Ex",
    });
    expect(msg).toContain("URL: https://example.com");
    expect(msg).toContain("Title: Ex");
    expect(msg).toContain("<article>\nbody content\n</article>");
  });

  it("omits Title line when title is missing", () => {
    const msg = buildUserMessage("body", { url: "https://example.com" });
    expect(msg).not.toContain("Title:");
  });

  it("truncates content over the limit and notes truncation", () => {
    const long = "a".repeat(MAX_MARKDOWN_CHARS + 10);
    const msg = buildUserMessage(long, { url: "https://example.com" });
    expect(msg).toContain("truncated");
    const articleMatch = msg.match(/<article>\n([\s\S]*)\n<\/article>/);
    expect(articleMatch).not.toBeNull();
    expect(articleMatch![1]!.length).toBe(MAX_MARKDOWN_CHARS);
  });
});

describe("DIGEST_SYSTEM_PROMPT", () => {
  it("marks article as untrusted", () => {
    expect(DIGEST_SYSTEM_PROMPT.toLowerCase()).toContain("untrusted");
  });
  it("specifies 3-6 tags in kebab-case", () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain("3");
    expect(DIGEST_SYSTEM_PROMPT).toContain("6");
    expect(DIGEST_SYSTEM_PROMPT).toContain("kebab-case");
  });
});

describe("DIGEST_JSON_SCHEMA", () => {
  it("lists all required fields", () => {
    expect(DIGEST_JSON_SCHEMA.required).toEqual([
      "title",
      "summary",
      "takeaway",
      "question",
      "tags",
    ]);
  });
  it("constrains tags to 3-6", () => {
    expect(DIGEST_JSON_SCHEMA.properties.tags.minItems).toBe(3);
    expect(DIGEST_JSON_SCHEMA.properties.tags.maxItems).toBe(6);
  });
});

describe("parseDigest", () => {
  const valid = {
    title: "Ownership in Rust",
    summary: "A short summary.",
    takeaway: "It's compile-time memory safety.",
    question: "How does it compare with GC?",
    tags: ["rust", "memory-safety", "systems"],
  };

  it("accepts a valid digest", () => {
    expect(parseDigest(valid)).toEqual(valid);
  });

  it("trims and lowercases tags", () => {
    const d = parseDigest({ ...valid, tags: ["  Rust ", "MEMORY-SAFETY", "systems"] });
    expect(d.tags).toEqual(["rust", "memory-safety", "systems"]);
  });

  it("rejects non-object input", () => {
    expect(() => parseDigest(null)).toThrow(DigestError);
    expect(() => parseDigest("hello")).toThrow(DigestError);
  });

  it("rejects when a field is missing", () => {
    const bad = { ...valid, question: undefined };
    expect(() => parseDigest(bad)).toThrow(DigestError);
  });

  it("rejects when tags is not an array", () => {
    expect(() => parseDigest({ ...valid, tags: "one,two,three" })).toThrow(
      DigestError,
    );
  });

  it("rejects when tags entry is not a string", () => {
    expect(() => parseDigest({ ...valid, tags: [1, 2, 3] })).toThrow(
      DigestError,
    );
  });

  it("rejects when there are fewer than 3 tags", () => {
    expect(() => parseDigest({ ...valid, tags: ["a", "b"] })).toThrow(
      DigestError,
    );
  });

  it("rejects when there are more than 6 tags", () => {
    expect(() =>
      parseDigest({
        ...valid,
        tags: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ).toThrow(DigestError);
  });

  it("rejects when a tag has spaces", () => {
    expect(() =>
      parseDigest({ ...valid, tags: ["memory safety", "rust", "systems"] }),
    ).toThrow(DigestError);
  });

  it("rejects empty-string field", () => {
    expect(() => parseDigest({ ...valid, title: "   " })).toThrow(DigestError);
  });
});
