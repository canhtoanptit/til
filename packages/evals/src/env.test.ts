import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadWorkersAiCredentials,
  parseDotVars,
  resolveLiveChatGate,
} from "./env.js";

function devVarsFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "til-evals-"));
  const path = join(dir, ".dev.vars");
  writeFileSync(path, body, "utf8");
  return path;
}

const MISSING = join(tmpdir(), "til-evals-does-not-exist", ".dev.vars");

describe("parseDotVars", () => {
  it("reads KEY=VALUE lines", () => {
    expect(parseDotVars("A=1\nB=two\n")).toEqual({ A: "1", B: "two" });
  });

  it("skips blanks and comments", () => {
    expect(parseDotVars("\n# comment\nA=1\n   \n")).toEqual({ A: "1" });
  });

  it("strips one layer of matching quotes", () => {
    expect(parseDotVars(`A="1"\nB='2'\nC="mixed'\n`)).toEqual({
      A: "1",
      B: "2",
      C: `"mixed'`,
    });
  });

  it("keeps '=' inside a value and tolerates an export prefix", () => {
    expect(parseDotVars("export A=a=b\n")).toEqual({ A: "a=b" });
  });

  it("ignores lines that are not assignments", () => {
    expect(parseDotVars("nonsense\n=oops\n1BAD=x\n")).toEqual({});
  });
});

describe("loadWorkersAiCredentials", () => {
  it("prefers the environment", () => {
    const path = devVarsFile(
      "CF_ACCOUNT_ID=from-file\nWORKERS_AI_API_TOKEN=tf\n",
    );
    expect(
      loadWorkersAiCredentials({
        env: { CF_ACCOUNT_ID: "from-env", WORKERS_AI_API_TOKEN: "te" },
        devVarsPath: path,
      }),
    ).toEqual({ accountId: "from-env", apiToken: "te" });
  });

  it("falls back to the dev vars file, per key", () => {
    const path = devVarsFile("CF_ACCOUNT_ID=acct\nWORKERS_AI_API_TOKEN=tok\n");
    expect(
      loadWorkersAiCredentials({
        env: { CF_ACCOUNT_ID: "from-env" },
        devVarsPath: path,
      }),
    ).toEqual({ accountId: "from-env", apiToken: "tok" });
  });

  it("treats blank values as absent", () => {
    const path = devVarsFile("CF_ACCOUNT_ID=\nWORKERS_AI_API_TOKEN=  \n");
    expect(() =>
      loadWorkersAiCredentials({ env: {}, devVarsPath: path }),
    ).toThrow(/CF_ACCOUNT_ID and WORKERS_AI_API_TOKEN/);
  });

  it("fails loudly, naming what is missing and where it looked", () => {
    expect(() =>
      loadWorkersAiCredentials({
        env: { CF_ACCOUNT_ID: "acct" },
        devVarsPath: MISSING,
      }),
    ).toThrow(/WORKERS_AI_API_TOKEN/);
    expect(() =>
      loadWorkersAiCredentials({ env: {}, devVarsPath: MISSING }),
    ).toThrow(/\.dev\.vars/);
  });

  it("never puts a credential value in the error message", () => {
    const path = devVarsFile("CF_ACCOUNT_ID=super-secret-account\n");
    try {
      loadWorkersAiCredentials({ env: {}, devVarsPath: path });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-account");
    }
  });
});

describe("resolveLiveChatGate", () => {
  const full = {
    EVAL_LIVE: "1",
    EVAL_PROVIDER: "groq",
    EVAL_MODEL: "openai/gpt-oss-20b",
    EVAL_API_KEY: "gsk-test",
    EVAL_CF_ACCOUNT_ID: "acct",
    EVAL_CF_GATEWAY_ID: "gw",
  };

  it("is closed unless EVAL_LIVE is exactly 1", () => {
    expect(resolveLiveChatGate({}).live).toBe(false);
    expect(resolveLiveChatGate({ ...full, EVAL_LIVE: "true" }).live).toBe(
      false,
    );
    expect(resolveLiveChatGate({ ...full, EVAL_LIVE: "0" }).live).toBe(false);
    expect(resolveLiveChatGate({}).reason).toContain("EVAL_LIVE");
  });

  it("opens with a full provider configuration", () => {
    const gate = resolveLiveChatGate(full);
    expect(gate.live).toBe(true);
    expect(gate.settings).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-20b",
      apiKey: "gsk-test",
      cfAccountId: "acct",
      cfGatewayId: "gw",
    });
  });

  it("names every missing variable", () => {
    const gate = resolveLiveChatGate({
      EVAL_LIVE: "1",
      EVAL_PROVIDER: "openai",
      EVAL_MODEL: "gpt-4o-mini",
    });
    expect(gate.live).toBe(false);
    expect(gate.reason).toContain("EVAL_API_KEY");
    expect(gate.reason).toContain("EVAL_CF_ACCOUNT_ID");
    expect(gate.reason).toContain("EVAL_CF_GATEWAY_ID");
  });

  it("rejects an unknown provider", () => {
    const gate = resolveLiveChatGate({ ...full, EVAL_PROVIDER: "mistral" });
    expect(gate.live).toBe(false);
    expect(gate.reason).toContain("EVAL_PROVIDER");
  });

  it("never leaks the key into the reason", () => {
    const gate = resolveLiveChatGate({
      ...full,
      EVAL_CF_GATEWAY_ID: "",
    });
    expect(gate.live).toBe(false);
    expect(gate.reason).not.toContain("gsk-test");
  });
});
