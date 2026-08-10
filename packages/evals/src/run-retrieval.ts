import { createWorkersAIRestEmbedder } from "@til/core";
import { createEmbeddingCache } from "./cache.js";
import { fail, isEntrypoint } from "./cli.js";
import { loadCorpus, loadRetrievalGold } from "./datasets.js";
import type { GoldCase, GoldKind } from "./datasets.js";
import { loadWorkersAiCredentials } from "./env.js";
import { mean, mrr, ndcgAtK, recallAtK } from "./metrics.js";
import { appendHistory, gitSha, printTable } from "./report.js";
import type { TableRow } from "./report.js";
import {
  CONTROL_POLICY,
  DEFAULT_RETRIEVAL_CONFIG,
  FUSION_POLICIES,
  RETRIEVAL_MODES,
  retrieve,
} from "./retrieval.js";
import type {
  FusionPolicy,
  RetrievalConfig,
  RetrievalMode,
} from "./retrieval.js";
import { buildEvalStack } from "./runner.js";
import type { EvalStack } from "./runner.js";

const KINDS: readonly GoldKind[] = ["semantic", "keyword", "mixed"];
const SHALLOW_K = 3;
const RRF_K_SWEEP = [20, 60];
const POOL_SWEEP = [2, 3, 4];

export interface CaseScore {
  id: string;
  kind: GoldKind;
  recallShallow: number;
  recallTopK: number;
  rr: number;
  ndcg: number;
  ranked: string[];
}

export interface Aggregate {
  n: number;
  recallShallow: number;
  recallTopK: number;
  mrr: number;
  ndcg: number;
}

export function scoreCase(
  gold: GoldCase,
  ranked: string[],
  topK: number,
): CaseScore {
  return {
    id: gold.id,
    kind: gold.kind,
    recallShallow: recallAtK(ranked, gold.expected, SHALLOW_K),
    recallTopK: recallAtK(ranked, gold.expected, topK),
    rr: mrr(ranked, gold.expected),
    ndcg: ndcgAtK(ranked, gold.expected, topK),
    ranked,
  };
}

export function aggregate(scores: CaseScore[]): Aggregate {
  return {
    n: scores.length,
    recallShallow: mean(scores.map((s) => s.recallShallow)),
    recallTopK: mean(scores.map((s) => s.recallTopK)),
    mrr: mean(scores.map((s) => s.rr)),
    ndcg: mean(scores.map((s) => s.ndcg)),
  };
}

export function bySlice(scores: CaseScore[]): Record<string, Aggregate> {
  const out: Record<string, Aggregate> = { overall: aggregate(scores) };
  for (const kind of KINDS) {
    out[kind] = aggregate(scores.filter((score) => score.kind === kind));
  }
  return out;
}

export interface ModeRun {
  mode: RetrievalMode;
  label: string;
  scores: CaseScore[];
  slices: Record<string, Aggregate>;
}

export function describePolicy(policy: FusionPolicy): string {
  return `${policy.id} (abstain=${policy.abstain ? "yes" : "no"}, w=${policy.weights.semantic}/${policy.weights.keyword}, tie=${policy.tiebreak})`;
}

export async function runMode(
  stack: EvalStack,
  gold: GoldCase[],
  queryVectors: Map<string, number[]>,
  mode: RetrievalMode,
  config: RetrievalConfig,
  label: string = mode,
): Promise<ModeRun> {
  const scores: CaseScore[] = [];
  for (const item of gold) {
    const vector = queryVectors.get(item.id);
    if (vector === undefined) {
      throw new Error(`run-retrieval: no query vector for ${item.id}`);
    }
    const ranked = await retrieve(stack, mode, item.query, vector, config);
    scores.push(scoreCase(item, ranked, config.topK));
  }
  return { mode, label, scores, slices: bySlice(scores) };
}

const METRIC_COLUMNS = [
  { key: "slice", label: "slice" },
  { key: "n", label: "n" },
  { key: "recall3", label: `recall@${SHALLOW_K}`, decimals: 3 },
  { key: "recallK", label: "recall@k", decimals: 3 },
  { key: "mrr", label: "MRR", decimals: 3 },
  { key: "ndcg", label: "nDCG@k", decimals: 3 },
];

function sliceRows(slices: Record<string, Aggregate>): TableRow[] {
  const order = ["overall", ...KINDS];
  return order
    .filter((slice) => slices[slice] !== undefined)
    .map((slice) => {
      const value = slices[slice] as Aggregate;
      return {
        slice,
        n: value.n,
        recall3: value.recallShallow,
        recallK: value.recallTopK,
        mrr: value.mrr,
        ndcg: value.ndcg,
      };
    });
}

function comparisonRows(runs: ModeRun[]): TableRow[] {
  const rows: TableRow[] = [];
  for (const slice of ["overall", ...KINDS]) {
    for (const run of runs) {
      const value = run.slices[slice];
      if (value === undefined) continue;
      rows.push({
        slice: `${slice}/${run.label}`,
        n: value.n,
        recall3: value.recallShallow,
        recallK: value.recallTopK,
        mrr: value.mrr,
        ndcg: value.ndcg,
      });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const credentials = loadWorkersAiCredentials();
  const embedder = createWorkersAIRestEmbedder(credentials);
  const cache = createEmbeddingCache(embedder);
  const corpus = loadCorpus();
  const gold = loadRetrievalGold();
  const config = DEFAULT_RETRIEVAL_CONFIG;

  console.log(
    `[evals] corpus=${corpus.length} gold=${gold.length} embedder=${embedder.model}/${embedder.dimensions}d cache=${cache.path}`,
  );

  const known = new Set(corpus.map((entry) => entry.id));
  for (const item of gold) {
    for (const id of item.expected) {
      if (!known.has(id)) {
        throw new Error(`${item.id} expects ${id}, which is not in the corpus`);
      }
    }
  }

  const stack = await buildEvalStack({
    corpus,
    embed: (texts) => cache.embed(texts),
    embedModel: embedder.model,
    dimensions: embedder.dimensions,
  });
  try {
    const queryTexts = gold.map((item) => item.query);
    const vectors = await cache.embed(queryTexts);
    const queryVectors = new Map<string, number[]>();
    gold.forEach((item, index) => {
      const vector = vectors[index];
      if (vector !== undefined) queryVectors.set(item.id, vector);
    });
    cache.save();

    const runs: ModeRun[] = [];
    for (const mode of RETRIEVAL_MODES) {
      runs.push(await runMode(stack, gold, queryVectors, mode, config));
    }
    // The pre-P17.1 fusion at the same budget: the before/after every claim in
    // the report is measured against, on this dataset rather than an older one.
    const controlRun = await runMode(
      stack,
      gold,
      queryVectors,
      "hybrid",
      { ...config, policy: CONTROL_POLICY },
      "hybrid-control",
    );
    runs.push(controlRun);

    console.log(`[evals] shipped policy: ${describePolicy(config.policy)}`);
    printTable(
      `Retrieval modes (topK=${config.topK}, pool=${config.poolMultiplier}x, rrfK=${config.rrfK})`,
      METRIC_COLUMNS,
      comparisonRows(runs),
    );

    for (const run of runs) {
      printTable(`mode=${run.label}`, METRIC_COLUMNS, sliceRows(run.slices));
    }

    const ablations: TableRow[] = [];
    let best = { label: "", ndcg: -1 };
    for (const policy of FUSION_POLICIES) {
      for (const rrfK of RRF_K_SWEEP) {
        for (const poolMultiplier of POOL_SWEEP) {
          const run = await runMode(stack, gold, queryVectors, "hybrid", {
            ...config,
            rrfK,
            poolMultiplier,
            policy,
          });
          const overall = run.slices.overall as Aggregate;
          const label = `${policy.id} k=${rrfK} pool=${poolMultiplier}x`;
          ablations.push({
            slice: label,
            n: overall.n,
            recall3: overall.recallShallow,
            recallK: overall.recallTopK,
            mrr: overall.mrr,
            ndcg: overall.ndcg,
            semantic: (run.slices.semantic as Aggregate).ndcg,
            keyword: (run.slices.keyword as Aggregate).ndcg,
            mixed: (run.slices.mixed as Aggregate).ndcg,
          });
          if (overall.ndcg > best.ndcg) best = { label, ndcg: overall.ndcg };
        }
      }
    }
    printTable(
      "Hybrid ablations: policy x rrfK x pool (nDCG columns are per-kind)",
      [
        ...METRIC_COLUMNS,
        { key: "semantic", label: "sem nDCG", decimals: 3 },
        { key: "keyword", label: "kw nDCG", decimals: 3 },
        { key: "mixed", label: "mix nDCG", decimals: 3 },
      ],
      ablations,
    );

    const failures = failingCases(runs);
    if (failures.length > 0) {
      console.log(
        `\nCases no mode retrieved at all (${failures.length}):\n  ${failures.join("\n  ")}`,
      );
    }

    const stats = cache.stats();
    console.log(
      `\n[evals] embedding cache: ${stats.hits} hit(s), ${stats.misses} miss(es), ${stats.requests} REST call(s)`,
    );
    console.log(`[evals] best hybrid ablation by overall nDCG: ${best.label}`);

    appendHistory({
      timestamp: new Date().toISOString(),
      gitSha: gitSha(),
      suite: "retrieval",
      config: {
        corpus: corpus.length,
        gold: gold.length,
        embedModel: embedder.model,
        dimensions: embedder.dimensions,
        topK: config.topK,
        poolMultiplier: config.poolMultiplier,
        rrfK: config.rrfK,
        shallowK: SHALLOW_K,
        policy: config.policy,
      },
      scores: {
        modes: Object.fromEntries(runs.map((run) => [run.label, run.slices])),
        ablations: ablations.map((row) => ({
          config: row.slice,
          recallTopK: row.recallK,
          mrr: row.mrr,
          ndcg: row.ndcg,
        })),
        bestAblation: best.label,
      },
    });
  } finally {
    cache.save();
    stack.close();
  }
}

function failingCases(runs: ModeRun[]): string[] {
  const out: string[] = [];
  const first = runs[0];
  if (first === undefined) return out;
  first.scores.forEach((_, index) => {
    const missedEverywhere = runs.every(
      (run) => (run.scores[index]?.recallTopK ?? 0) === 0,
    );
    if (missedEverywhere) {
      const score = first.scores[index];
      if (score !== undefined) out.push(`${score.id} (${score.kind})`);
    }
  });
  return out;
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
