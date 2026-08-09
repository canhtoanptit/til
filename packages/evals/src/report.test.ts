import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEntrypoint } from "./cli.js";
import { appendHistory, gitSha, renderTable } from "./report.js";

describe("renderTable", () => {
  it("aligns the header, a rule and the rows", () => {
    const out = renderTable(
      [
        { key: "slice", label: "slice" },
        { key: "ndcg", label: "nDCG", decimals: 3 },
      ],
      [
        { slice: "overall", ndcg: 0.5 },
        { slice: "semantic", ndcg: 0.25 },
      ],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("slice      nDCG");
    expect(lines[1]).toBe("--------  -----");
    expect(lines[2]).toBe("overall   0.500");
    expect(lines[3]).toBe("semantic  0.250");
  });

  it("prints a number without decimals when none are asked for", () => {
    const out = renderTable([{ key: "n", label: "n" }], [{ n: 41 }]);
    expect(out.split("\n")[2]).toBe("41");
  });

  it("leaves a missing cell blank rather than printing undefined", () => {
    const out = renderTable(
      [
        { key: "a", label: "a" },
        { key: "b", label: "b" },
      ],
      [{ a: "x" }],
    );
    expect(out).not.toContain("undefined");
  });

  it("handles an empty row set", () => {
    expect(renderTable([{ key: "a", label: "a" }], [])).toBe("a\n-");
  });
});

describe("appendHistory", () => {
  it("appends one JSON object per line", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "til-evals-hist-")),
      "h.jsonl",
    );
    const entry = {
      timestamp: "2026-08-09T00:00:00.000Z",
      gitSha: "abc1234",
      suite: "retrieval",
      config: { rrfK: 60 },
      scores: { ndcg: 0.5 },
    };
    appendHistory(entry, path);
    appendHistory({ ...entry, gitSha: "def5678" }, path);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual(entry);
    expect(JSON.parse(lines[1] ?? "").gitSha).toBe("def5678");
  });

  it("creates the history directory on demand", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "til-evals-hist-")),
      "nested",
      "deep",
      "h.jsonl",
    );
    appendHistory(
      {
        timestamp: "t",
        gitSha: "s",
        suite: "chat",
        config: {},
        scores: {},
      },
      path,
    );
    expect(readFileSync(path, "utf8")).toContain('"suite":"chat"');
  });
});

describe("gitSha", () => {
  it("returns a short sha or the string 'unknown', never throws", () => {
    expect(gitSha()).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
  });
});

describe("isEntrypoint", () => {
  it("is false when the module is merely imported", () => {
    expect(isEntrypoint(import.meta.url)).toBe(false);
  });

  it("is true when argv names this file", () => {
    const path = new URL(import.meta.url).pathname;
    expect(isEntrypoint(import.meta.url, ["node", path])).toBe(true);
  });

  it("is false without an argv entry", () => {
    expect(isEntrypoint(import.meta.url, ["node"])).toBe(false);
  });
});
