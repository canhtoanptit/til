import { describe, expect, it } from "vitest";
import {
  ftsTokens,
  fuseHybrid,
  HYBRID_DEFAULTS,
  sanitizeFtsQuery,
  SELECTIVE_KEYWORD_HITS,
  STOPWORDS,
} from "./hybrid.js";
import type { RankedId } from "./retrieval.js";

const ranks = (...ids: string[]): RankedId[] =>
  ids.map((id, index) => ({ id, rank: index + 1 }));

/** A semantic leg whose 12th hit is the right answer — `gr43`'s shape. */
const deep = [...Array.from({ length: 11 }, (_, i) => `s${i + 1}`), "target"];

describe("ftsTokens", () => {
  it("splits on every non-alphanumeric, as unicode61 does", () => {
    expect(ftsTokens("io_uring")).toEqual(["io", "uring"]);
    expect(ftsTokens("--max-old-space-size")).toEqual([
      "max",
      "old",
      "space",
      "size",
    ]);
    expect(ftsTokens("CVE-2021-44228")).toEqual(["cve", "2021", "44228"]);
    expect(ftsTokens("")).toEqual([]);
  });
});

describe("sanitizeFtsQuery", () => {
  it("quotes each term and joins them with OR", () => {
    expect(sanitizeFtsQuery("wal checkpoint")).toBe('"wal" OR "checkpoint"');
  });

  it("drops FTS operators and reserved words", () => {
    expect(sanitizeFtsQuery('wal AND "checkpoint*"')).toBe(
      '"wal" OR "checkpoint"',
    );
    expect(sanitizeFtsQuery("NEAR(bm25 ranking)")).toBe('"bm25" OR "ranking"');
  });

  it("returns null when nothing usable is left", () => {
    expect(sanitizeFtsQuery("")).toBeNull();
    expect(sanitizeFtsQuery("   ")).toBeNull();
    expect(sanitizeFtsQuery("AND OR NOT")).toBeNull();
    expect(sanitizeFtsQuery("-- ::")).toBeNull();
  });

  it("abstains on a query made only of function words", () => {
    expect(sanitizeFtsQuery("how do I get the thing to do that")).toBeNull();
    expect(sanitizeFtsQuery("what is it about")).toBeNull();
    expect(sanitizeFtsQuery("the")).toBeNull();
  });

  it("keeps the content words and drops the rest", () => {
    expect(sanitizeFtsQuery("how do I tune efConstruction in HNSW")).toBe(
      '"tune" OR "efConstruction" OR "HNSW"',
    );
  });

  // WHY this is pinned: unicode61 indexes `io_uring` as io+uring, and judging the
  // whole part instead of its tokens is how an identifier ends up stripped.
  it("never strips an identifier that only looks like function words", () => {
    expect(sanitizeFtsQuery("io_uring")).toBe('"io_uring"');
    expect(sanitizeFtsQuery("what about io_uring")).toBe('"io_uring"');
    expect(sanitizeFtsQuery("--max-old-space-size")).toBe(
      '"--max-old-space-size"',
    );
    expect(sanitizeFtsQuery("CVE-2021-44228")).toBe('"CVE-2021-44228"');
    expect(sanitizeFtsQuery("bge-m3 1024 dimensions")).toBe(
      '"bge-m3" OR "1024" OR "dimensions"',
    );
    expect(sanitizeFtsQuery("stale-while-revalidate")).toBe(
      '"stale-while-revalidate"',
    );
  });

  it("drops a hyphenated part whose every token is a function word", () => {
    expect(sanitizeFtsQuery("out-of-the-way")).toBeNull();
  });

  it("keeps a part with no ASCII token, which the list cannot judge", () => {
    expect(sanitizeFtsQuery("日本語")).toBe('"日本語"');
    expect(sanitizeFtsQuery("the größe of it")).toBe('"größe"');
  });

  it("keeps every token when stopwords are disabled", () => {
    expect(sanitizeFtsQuery("what is it about", { stopwords: null })).toBe(
      '"what" OR "is" OR "it" OR "about"',
    );
  });

  it("honours a caller-supplied stop list", () => {
    expect(
      sanitizeFtsQuery("wal checkpoint", {
        stopwords: new Set(["checkpoint"]),
      }),
    ).toBe('"wal"');
  });

  it("strips quotes out of a term so MATCH cannot be broken", () => {
    expect(sanitizeFtsQuery('sql NEAR * "unclosed')).toBe(
      '"sql" OR "unclosed"',
    );
  });

  it("shares one stop list with the rest of the monorepo", () => {
    expect(STOPWORDS.has("the")).toBe(true);
    expect(STOPWORDS.has("io")).toBe(false);
    expect(STOPWORDS.has("uring")).toBe(false);
  });
});

describe("fuseHybrid", () => {
  it("leaves the semantic order untouched when the keyword leg abstains", () => {
    const fused = fuseHybrid(ranks("zeta", "alpha", "mu"), []);
    expect(fused.map((hit) => hit.id)).toEqual(["zeta", "alpha", "mu"]);
  });

  it("returns the keyword order when the semantic leg is unavailable", () => {
    const fused = fuseHybrid([], ranks("zeta", "alpha"));
    expect(fused.map((hit) => hit.id)).toEqual(["zeta", "alpha"]);
  });

  it("applies the weights to each leg's contribution", () => {
    const fused = fuseHybrid([{ id: "s", rank: 1 }], [{ id: "k", rank: 1 }], {
      k: 9,
      weights: { semantic: 0.7, keyword: 0.3 },
    });
    expect(fused[0]?.id).toBe("s");
    expect(fused[0]?.score).toBeCloseTo(0.7 / 10, 12);
    expect(fused[1]?.score).toBeCloseTo(0.3 / 10, 12);
  });

  it("keeps the semantic leg's ranking ahead of keyword-only candidates", () => {
    // The defect P17 measured: with equal weights these interleave, and a
    // keyword hit for a paraphrase question displaces the right answer.
    const fused = fuseHybrid(
      ranks("sem1", "sem2", "sem3"),
      ranks("junk1", "junk2"),
      HYBRID_DEFAULTS,
    );
    expect(fused.map((hit) => hit.id)).toEqual([
      "sem1",
      "sem2",
      "sem3",
      "junk1",
      "junk2",
    ]);
  });

  it("promotes an entry both legs agree on above either leg's top hit", () => {
    // Two hits out of a 16-candidate budget: the keyword leg pinned documents,
    // so it votes at full strength.
    const fused = fuseHybrid(
      ranks("sem1", "sem2", "shared"),
      ranks("shared", "junk"),
      { ...HYBRID_DEFAULTS, pool: 16 },
    );
    expect(fused[0]?.id).toBe("shared");
    expect(fused[0]?.score).toBeCloseTo(0.7 / 23 + 0.3 / 21, 12);
  });

  it("breaks a tie toward the semantic leg, then by id", () => {
    const semanticFirst = fuseHybrid(
      [{ id: "zeta", rank: 1 }],
      [{ id: "alpha", rank: 1 }],
      { tiebreak: "semantic", weights: { semantic: 1, keyword: 1 } },
    );
    expect(semanticFirst.map((hit) => hit.id)).toEqual(["zeta", "alpha"]);
    expect(semanticFirst[0]?.score).toBe(semanticFirst[1]?.score);

    const alphabetical = fuseHybrid(
      [{ id: "zeta", rank: 1 }],
      [{ id: "alpha", rank: 1 }],
      { tiebreak: "id", weights: { semantic: 1, keyword: 1 } },
    );
    expect(alphabetical.map((hit) => hit.id)).toEqual(["alpha", "zeta"]);
  });

  it("falls back to id order when both candidates stand equal in the semantic leg", () => {
    const fused = fuseHybrid(
      [
        { id: "zeta", rank: 1 },
        { id: "alpha", rank: 1 },
      ],
      [],
      { tiebreak: "semantic" },
    );
    expect(fused.map((hit) => hit.id)).toEqual(["alpha", "zeta"]);
  });

  it("honours k, and a smaller k makes rank differences matter more", () => {
    const tight = fuseHybrid(ranks("a", "b"), [], { k: 1 });
    const loose = fuseHybrid(ranks("a", "b"), [], { k: 1000 });
    const tightRatio = (tight[0]?.score ?? 0) / (tight[1]?.score ?? 1);
    const looseRatio = (loose[0]?.score ?? 0) / (loose[1]?.score ?? 1);
    expect(tightRatio).toBeGreaterThan(looseRatio);
    expect(tight[0]?.score).toBeCloseTo(
      HYBRID_DEFAULTS.weights.semantic / 2,
      12,
    );
  });

  it("lets a selective keyword leg promote a deep semantic hit", () => {
    // The shape of the one case hybrid uniquely wins: an identifier that only the
    // body text carries, so the embedder ranks the right entry 12th.
    const semantic = ranks(...deep);
    const fused = fuseHybrid(semantic, [{ id: "target", rank: 1 }], {
      ...HYBRID_DEFAULTS,
      pool: 16,
    });
    expect(fused[0]?.id).toBe("target");
    expect(fused[0]?.score).toBeCloseTo(0.7 / 32 + 0.3 / 21, 12);
  });

  it("will not let a diffuse keyword leg displace the semantic top hit", () => {
    const semantic = ranks(...deep);
    const diffuse = ranks(
      "target",
      ...Array.from({ length: 15 }, (_, i) => `d${i}`),
    );
    const selective = fuseHybrid(semantic, diffuse, {
      ...HYBRID_DEFAULTS,
      pool: 16,
    });
    expect(selective[0]?.id).toBe("s1");
    // WHY the contrast: identical lists, and a flat vote gets this wrong — which
    // is what the pre-P17.1 fusion did on every paraphrase question.
    const flat = fuseHybrid(semantic, diffuse, {
      ...HYBRID_DEFAULTS,
      pool: 16,
      keywordVote: "flat",
    });
    expect(flat[0]?.id).toBe("target");
  });

  it("splits selective from diffuse at SELECTIVE_KEYWORD_HITS", () => {
    const semantic = ranks(...deep);
    const atLimit = ranks("target", "x1", "x2");
    const overLimit = ranks("target", "x1", "x2", "x3");
    expect(SELECTIVE_KEYWORD_HITS).toBe(3);
    expect(atLimit).toHaveLength(SELECTIVE_KEYWORD_HITS);
    expect(
      fuseHybrid(semantic, atLimit, { ...HYBRID_DEFAULTS, pool: 16 })[0]?.id,
    ).toBe("target");
    expect(
      fuseHybrid(semantic, overLimit, { ...HYBRID_DEFAULTS, pool: 16 })[0]?.id,
    ).toBe("s1");
  });

  it("treats a keyword leg that filled its budget as diffuse", () => {
    const semantic = ranks(...deep);
    const filled = ranks("target", "x1", "x2");
    // Three hits out of three offered: the list was truncated, so its length says
    // nothing about how selective the query was.
    expect(
      fuseHybrid(semantic, filled, { ...HYBRID_DEFAULTS, pool: 3 })[0]?.id,
    ).toBe("s1");
  });

  it("scales a diffuse keyword vote by the budget it was given", () => {
    const diffuse = ranks(...Array.from({ length: 16 }, (_, i) => `d${i}`));
    const fused = fuseHybrid([], diffuse, { ...HYBRID_DEFAULTS, pool: 16 });
    expect(fused[0]?.score).toBeCloseTo(0.3 / 16 / 21, 12);
  });

  it("defaults to a semantic-heavy policy at core's RRF k", () => {
    expect(HYBRID_DEFAULTS.weights.semantic).toBeGreaterThan(
      HYBRID_DEFAULTS.weights.keyword,
    );
    expect(HYBRID_DEFAULTS.tiebreak).toBe("semantic");
    expect(HYBRID_DEFAULTS.poolMultiplier).toBeGreaterThanOrEqual(2);
  });

  it("tolerates two empty legs and a non-finite rank", () => {
    expect(fuseHybrid([], [])).toEqual([]);
    const fused = fuseHybrid(
      [
        { id: "ok", rank: 1 },
        { id: "nan", rank: Number.NaN },
      ],
      [{ id: "pole", rank: -60 }],
      { k: 60 },
    );
    expect(fused.map((hit) => hit.id)).toEqual(["ok"]);
  });

  it("ignores a negative weight rather than inverting the ranking", () => {
    const fused = fuseHybrid(ranks("a"), ranks("b"), {
      weights: { semantic: 1, keyword: -5 },
    });
    expect(fused.map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(fused[1]?.score).toBe(0);
  });
});
