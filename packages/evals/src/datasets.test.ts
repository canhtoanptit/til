import { describe, expect, it } from "vitest";
import {
  indexedTextFor,
  loadChatScenarios,
  loadCorpus,
  loadInjectionSuite,
  loadRetrievalGold,
} from "./datasets.js";
import { contentWords, sharedContentWords } from "./text.js";

const corpus = loadCorpus();
const gold = loadRetrievalGold();
const scenarios = loadChatScenarios();
const injections = loadInjectionSuite();
const byId = new Map(corpus.map((entry) => [entry.id, entry]));
const CHAT_TOOL_NAMES = new Set(["search_entries", "get_entry", "stats"]);

describe("fixture corpus", () => {
  it("is big enough to make the metrics mean something", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(50);
  });

  it("has a unique url per entry", () => {
    const urls = new Set(corpus.map((entry) => entry.url));
    expect(urls.size).toBe(corpus.length);
  });

  it("has parseable urls and at least two tags each", () => {
    for (const entry of corpus) {
      expect(() => new URL(entry.url)).not.toThrow();
      expect(entry.tags.length).toBeGreaterThanOrEqual(2);
      for (const tag of entry.tags) expect(tag).toBe(tag.toLowerCase());
    }
  });

  it("spreads across many domains, so top_domains is not one row", () => {
    const domains = new Set(corpus.map((entry) => new URL(entry.url).hostname));
    expect(domains.size).toBeGreaterThanOrEqual(30);
  });

  it("keeps the deliberate keyword traps: one phrase, two unrelated entries", () => {
    const traps: [string, string[]][] = [
      ["cold start", ["e20", "e26"]],
      ["partition", ["e10", "e11"]],
      ["garbage collection", ["e40", "e41"]],
      ["token", ["e22", "e30", "e46"]],
      ["race", ["e35", "e36"]],
      ["cache", ["e27", "e28"]],
    ];
    for (const [phrase, ids] of traps) {
      for (const id of ids) {
        const entry = byId.get(id);
        expect(entry, `${id} missing`).toBeDefined();
        const haystack = indexedTextFor(entry!).toLowerCase();
        expect(haystack, `${id} lost the trap phrase '${phrase}'`).toContain(
          phrase,
        );
      }
    }
  });
});

describe("retrieval gold set", () => {
  it("has enough cases in every kind", () => {
    expect(gold.length).toBeGreaterThanOrEqual(40);
    for (const kind of ["semantic", "keyword", "mixed"] as const) {
      expect(
        gold.filter((item) => item.kind === kind).length,
        kind,
      ).toBeGreaterThanOrEqual(10);
    }
  });

  it("only expects entries that exist", () => {
    for (const item of gold) {
      for (const id of item.expected) {
        expect(byId.has(id), `${item.id} expects unknown ${id}`).toBe(true);
      }
    }
  });

  it("documents the intent of every case", () => {
    for (const item of gold) {
      expect(item.note.length, item.id).toBeGreaterThan(20);
    }
  });

  // The load-bearing property of the whole suite: if a semantic query shares a
  // content word with its target, the keyword leg can find it too and the case
  // stops measuring the semantic leg.
  it("semantic cases share no content word with their target", () => {
    for (const item of gold) {
      if (item.kind !== "semantic") continue;
      for (const id of item.expected) {
        const entry = byId.get(id);
        expect(entry).toBeDefined();
        const shared = sharedContentWords(item.query, indexedTextFor(entry!));
        expect(shared, `${item.id} leaks into ${id}`).toEqual([]);
      }
    }
  });

  it("keyword cases carry a discriminating term and hit their target", () => {
    for (const item of gold) {
      if (item.kind !== "keyword") continue;
      const words = [...contentWords(item.query)];
      const rarest = Math.min(
        ...words.map(
          (word) =>
            corpus.filter((entry) =>
              contentWords(indexedTextFor(entry)).has(word),
            ).length,
        ),
      );
      expect(rarest, `${item.id} has no rare term`).toBeLessThanOrEqual(3);
      for (const id of item.expected) {
        const entry = byId.get(id);
        const target = contentWords(indexedTextFor(entry!));
        const overlap = words.filter((word) => target.has(word));
        expect(overlap.length, `${item.id} cannot match ${id}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("keeps at least three near-duplicate cases with two expected entries", () => {
    const pairs = gold.filter((item) => item.expected.length > 1);
    expect(pairs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("chat scenarios", () => {
  it("covers tool selection, refusal and the no-tool case", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
    expect(scenarios.some((s) => s.expectTool === null)).toBe(true);
    expect(scenarios.some((s) => s.expectRefusal === true)).toBe(true);
    expect(scenarios.some((s) => s.turns.length > 1)).toBe(true);
    for (const name of CHAT_TOOL_NAMES) {
      expect(
        scenarios.some((s) => s.expectTool === name),
        name,
      ).toBe(true);
    }
  });

  it("only expects tools that exist", () => {
    for (const scenario of scenarios) {
      if (scenario.expectTool === null) continue;
      expect(CHAT_TOOL_NAMES.has(scenario.expectTool), scenario.id).toBe(true);
    }
  });
});

describe("injection suite", () => {
  it("has ten cases with unique canaries", () => {
    expect(injections.length).toBeGreaterThanOrEqual(10);
    const canaries = new Set(injections.map((item) => item.canary));
    expect(canaries.size).toBe(injections.length);
  });

  it("plants each canary in the seed entry and nowhere in the clean corpus", () => {
    const clean = corpus.map((entry) => indexedTextFor(entry)).join("\n");
    for (const item of injections) {
      expect(
        indexedTextFor(item.seedEntry).includes(item.canary),
        `${item.id} seed lacks its canary`,
      ).toBe(true);
      expect(clean).not.toContain(item.canary);
    }
  });

  it("uses seed ids that cannot collide with the corpus", () => {
    for (const item of injections) {
      expect(byId.has(item.seedEntry.id)).toBe(false);
    }
  });

  it("asks a question that can retrieve the seeded entry", () => {
    for (const item of injections) {
      const shared = sharedContentWords(
        item.question,
        indexedTextFor(item.seedEntry),
      );
      expect(shared.length, `${item.id} is unretrievable`).toBeGreaterThan(0);
    }
  });
});
