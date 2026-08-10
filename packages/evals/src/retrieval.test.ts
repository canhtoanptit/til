import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { HYBRID_DEFAULTS } from "@til/core";
import type { CorpusEntry } from "./datasets.js";
import {
  CONTROL_POLICY,
  DEFAULT_RETRIEVAL_CONFIG,
  ftsRanks,
  FUSION_POLICIES,
  retrieve,
  SHIPPED_POLICY,
  vectorRanks,
} from "./retrieval.js";
import {
  buildEvalStack,
  EVAL_NOW,
  removeEntries,
  seedExtraEntry,
} from "./runner.js";
import type { EvalStack } from "./runner.js";
import { stubEmbed } from "./test-support.js";

const TOPICS = [
  ["wal", "checkpoint", "concurrent", "sqlite"],
  ["fusion", "hybrid", "ranking", "rrf"],
  ["kubernetes", "container", "pod"],
];
const DIMENSIONS = 8;
const embed = stubEmbed(TOPICS, { dimensions: DIMENSIONS });

function entry(id: string, over: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    id,
    url: over.url ?? `https://example.test/${id}`,
    title: over.title ?? `Title ${id}`,
    summary: over.summary ?? `Summary ${id}`,
    takeaway: over.takeaway ?? `Takeaway ${id}`,
    question: over.question ?? `Question ${id}`,
    tags: over.tags ?? ["alpha", "beta"],
    contentMarkdown: over.contentMarkdown ?? `Body ${id}`,
  };
}

const CORPUS: CorpusEntry[] = [
  entry("a1", {
    title: "SQLite WAL mode and concurrent readers",
    summary: "Checkpointing copies frames back into the main file.",
    tags: ["sqlite", "wal"],
  }),
  entry("a2", {
    title: "Reciprocal rank fusion for hybrid ranking",
    summary: "Fusion uses positions rather than raw scores.",
    tags: ["retrieval", "rrf"],
  }),
  entry("a3", {
    title: "Running pods on kubernetes",
    summary: "A container scheduler with a control loop.",
    tags: ["kubernetes", "ops"],
  }),
  entry("a4", {
    title: "Unrelated notes about gardening",
    summary: "Tomatoes need sun.",
    tags: ["garden", "misc"],
  }),
];

let stack: EvalStack;

beforeAll(async () => {
  stack = await buildEvalStack({
    corpus: CORPUS,
    embed,
    embedModel: "stub-embed",
    dimensions: DIMENSIONS,
  });
});

afterAll(() => stack.close());

async function queryVector(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  if (vector === undefined) throw new Error("no stub vector");
  return vector;
}

describe("the seeded stack", () => {
  it("indexes every entry into FTS through the real triggers", () => {
    const ranks = ftsRanks(stack, "gardening", 10);
    expect(ranks.map((hit) => hit.id)).toEqual(["a4"]);
  });

  it("stores one vector per entry", async () => {
    const ranks = await vectorRanks(stack, await queryVector("wal"), 10);
    expect(ranks).toHaveLength(CORPUS.length);
    expect(ranks[0]?.id).toBe("a1");
  });

  it("honours the limit on both legs", async () => {
    expect(ftsRanks(stack, "sqlite wal fusion kubernetes", 2)).toHaveLength(2);
    expect(await vectorRanks(stack, await queryVector("wal"), 1)).toHaveLength(
      1,
    );
  });

  it("returns nothing for a non-positive limit", async () => {
    expect(ftsRanks(stack, "wal", 0)).toEqual([]);
    expect(await vectorRanks(stack, await queryVector("wal"), 0)).toEqual([]);
  });

  it("pins createdAt to the fixed eval clock", () => {
    expect(stack.now()).toBe(EVAL_NOW);
  });
});

describe("retrieve", () => {
  it("fts mode finds an exact term", async () => {
    const ranked = await retrieve(
      stack,
      "fts",
      "checkpointing",
      await queryVector("checkpointing"),
    );
    expect(ranked[0]).toBe("a1");
  });

  it("vector mode ranks by the semantic leg alone", async () => {
    const ranked = await retrieve(
      stack,
      "vector",
      "zzz",
      await queryVector("hybrid fusion"),
    );
    expect(ranked[0]).toBe("a2");
  });

  it("hybrid mode fuses both legs", async () => {
    const ranked = await retrieve(
      stack,
      "hybrid",
      "kubernetes",
      await queryVector("kubernetes pods"),
    );
    expect(ranked[0]).toBe("a3");
  });

  it("hybrid recovers an entry only one leg can see", async () => {
    // 'tomatoes' is keyword-only (no topic axis matches it).
    const ranked = await retrieve(
      stack,
      "hybrid",
      "tomatoes",
      await queryVector("tomatoes"),
    );
    expect(ranked).toContain("a4");
  });

  it("truncates every mode to topK", async () => {
    const config = { ...DEFAULT_RETRIEVAL_CONFIG, topK: 2 };
    for (const mode of ["fts", "vector", "hybrid"] as const) {
      const ranked = await retrieve(
        stack,
        mode,
        "sqlite wal fusion kubernetes gardening",
        await queryVector("wal fusion kubernetes"),
        config,
      );
      expect(ranked.length, mode).toBeLessThanOrEqual(2);
    }
  });

  it("fts mode returns nothing when the query has no usable term", async () => {
    const ranked = await retrieve(stack, "fts", "***", await queryVector("x"));
    expect(ranked).toEqual([]);
  });

  it("changing rrfK changes fused order, not membership", async () => {
    const vector = await queryVector("wal fusion");
    const tight = await retrieve(stack, "hybrid", "gardening", vector, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      rrfK: 1,
    });
    const loose = await retrieve(stack, "hybrid", "gardening", vector, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      rrfK: 500,
    });
    expect([...tight].sort()).toEqual([...loose].sort());
  });
});

describe("fusion policies", () => {
  const STOPWORD_QUERY = "what is it that they do with the thing";

  it("abstains on a function-word query unless the control arm says otherwise", () => {
    expect(ftsRanks(stack, STOPWORD_QUERY, 10)).toEqual([]);
    expect(
      ftsRanks(stack, STOPWORD_QUERY, 10, { abstain: false }).length,
    ).toBeGreaterThan(0);
  });

  it("degrades hybrid to vector-only when the keyword leg abstains", async () => {
    const vector = await queryVector("wal");
    const hybrid = await retrieve(stack, "hybrid", STOPWORD_QUERY, vector);
    const vectorOnly = await retrieve(stack, "vector", STOPWORD_QUERY, vector);
    expect(hybrid).toEqual(vectorOnly);

    const control = await retrieve(stack, "hybrid", STOPWORD_QUERY, vector, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      policy: CONTROL_POLICY,
    });
    expect(control).not.toEqual(vectorOnly);
  });

  // The P17 defect in miniature: rank 1 of either leg scores 1/(k+1) under equal
  // weights, so the winner was whichever entry id sorted first.
  it("stops an alphabetically-lucky keyword hit from displacing the semantic top hit", async () => {
    const budget = { ...DEFAULT_RETRIEVAL_CONFIG, topK: 1, poolMultiplier: 1 };
    const vector = await queryVector("kubernetes pods");
    const control = await retrieve(stack, "hybrid", "wal", vector, {
      ...budget,
      policy: CONTROL_POLICY,
    });
    const shipped = await retrieve(stack, "hybrid", "wal", vector, {
      ...budget,
      policy: SHIPPED_POLICY,
    });
    expect(control).toEqual(["a1"]);
    expect(shipped).toEqual(["a3"]);
  });

  it("measures what core ships, under unique labels", () => {
    expect(SHIPPED_POLICY.weights).toEqual(HYBRID_DEFAULTS.weights);
    expect(SHIPPED_POLICY.tiebreak).toBe(HYBRID_DEFAULTS.tiebreak);
    expect(DEFAULT_RETRIEVAL_CONFIG.rrfK).toBe(HYBRID_DEFAULTS.k);
    expect(DEFAULT_RETRIEVAL_CONFIG.poolMultiplier).toBe(
      HYBRID_DEFAULTS.poolMultiplier,
    );
    const ids = FUSION_POLICIES.map((policy) => policy.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(CONTROL_POLICY.id);
    expect(
      FUSION_POLICIES.some(
        (policy) =>
          policy.abstain &&
          policy.weights.semantic === HYBRID_DEFAULTS.weights.semantic &&
          policy.weights.keyword === HYBRID_DEFAULTS.weights.keyword,
      ),
    ).toBe(true);
  });
});

describe("seedExtraEntry and removeEntries", () => {
  it("adds an entry to both legs and takes it away again", async () => {
    const extra = entry("z9", {
      title: "Ephemeral hostile entry",
      summary: "Some unmistakable phrase: bramblewick.",
    });
    await seedExtraEntry(stack, extra, { embed, embedModel: "stub-embed" });
    expect(ftsRanks(stack, "bramblewick", 5).map((h) => h.id)).toEqual(["z9"]);
    expect(
      (await vectorRanks(stack, await queryVector("bramblewick"), 99)).length,
    ).toBe(CORPUS.length + 1);

    removeEntries(stack, ["z9"]);
    expect(ftsRanks(stack, "bramblewick", 5)).toEqual([]);
    // The vector row goes with it: entry_vectors cascades on entry delete.
    expect(
      (await vectorRanks(stack, await queryVector("bramblewick"), 99)).length,
    ).toBe(CORPUS.length);
  });
});
