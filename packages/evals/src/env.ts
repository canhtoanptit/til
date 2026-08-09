import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The app's gitignored dev vars, used as a fallback source of credentials. */
export const DEV_VARS_PATH = join(
  packageRoot,
  "..",
  "..",
  "apps",
  "web",
  ".dev.vars",
);

export interface WorkersAiCredentials {
  accountId: string;
  apiToken: string;
}

export interface LiveChatSettings {
  provider: "openai" | "anthropic" | "groq";
  model: string;
  apiKey: string;
  cfAccountId: string;
  cfGatewayId: string;
}

export type EnvLike = Record<string, string | undefined>;

const SETUP_HELP = `
Set them in the environment, or in apps/web/.dev.vars (gitignored):

  CF_ACCOUNT_ID=<Cloudflare account id>
  WORKERS_AI_API_TOKEN=<API token with the "Workers AI - Read" permission>

The retrieval eval needs a real embedder: without one only the keyword leg
exists, and measuring half of a hybrid system silently is worse than failing.`;

/**
 * A `KEY=VALUE` file in the shape wrangler reads. Values are taken verbatim
 * apart from one layer of surrounding quotes; `export ` prefixes, blank lines
 * and `#` comments are ignored.
 */
export function parseDotVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(withoutExport.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Environment first, then `apps/web/.dev.vars`. Values are never logged —
 * whether a credential was found is the only thing this reports.
 */
export function loadWorkersAiCredentials(
  opts: { env?: EnvLike; devVarsPath?: string } = {},
): WorkersAiCredentials {
  const env = opts.env ?? (process.env as EnvLike);
  const path = opts.devVarsPath ?? DEV_VARS_PATH;
  const fromFile = readDotVars(path);
  const accountId = pick(env.CF_ACCOUNT_ID, fromFile.CF_ACCOUNT_ID);
  const apiToken = pick(
    env.WORKERS_AI_API_TOKEN,
    fromFile.WORKERS_AI_API_TOKEN,
  );

  const missing: string[] = [];
  if (accountId === null) missing.push("CF_ACCOUNT_ID");
  if (apiToken === null) missing.push("WORKERS_AI_API_TOKEN");
  if (accountId === null || apiToken === null) {
    throw new Error(
      `@til/evals: missing ${missing.join(" and ")} (looked in the environment and in ${path}).${SETUP_HELP}`,
    );
  }
  return { accountId, apiToken };
}

export interface LiveChatGate {
  live: boolean;
  settings: LiveChatSettings | null;
  reason: string;
}

const PROVIDERS = new Set(["openai", "anthropic", "groq"]);

/**
 * Live chat runs are opt-in: `EVAL_LIVE=1` plus a full set of `EVAL_*` provider
 * settings. Anything short of that returns `live: false` with the reason, so
 * `eval:chat` can explain itself instead of quietly measuring nothing or
 * spending somebody's key by accident.
 */
export function resolveLiveChatGate(env: EnvLike = process.env): LiveChatGate {
  if ((env.EVAL_LIVE ?? "").trim() !== "1") {
    return {
      live: false,
      settings: null,
      reason: "EVAL_LIVE is not 1, so no provider calls will be made",
    };
  }
  const provider = (env.EVAL_PROVIDER ?? "").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    return {
      live: false,
      settings: null,
      reason: `EVAL_PROVIDER must be one of ${[...PROVIDERS].join(", ")}`,
    };
  }
  const required = {
    model: env.EVAL_MODEL,
    apiKey: env.EVAL_API_KEY,
    cfAccountId: env.EVAL_CF_ACCOUNT_ID,
    cfGatewayId: env.EVAL_CF_GATEWAY_ID,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => (value ?? "").trim().length === 0)
    .map(([key]) => `EVAL_${camelToEnv(key)}`);
  if (missing.length > 0) {
    return {
      live: false,
      settings: null,
      reason: `missing ${missing.join(", ")}`,
    };
  }
  return {
    live: true,
    reason: "live",
    settings: {
      provider: provider as LiveChatSettings["provider"],
      model: (required.model ?? "").trim(),
      apiKey: (required.apiKey ?? "").trim(),
      cfAccountId: (required.cfAccountId ?? "").trim(),
      cfGatewayId: (required.cfGatewayId ?? "").trim(),
    },
  };
}

function camelToEnv(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

function readDotVars(path: string): Record<string, string> {
  try {
    return parseDotVars(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function pick(...candidates: (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();
    if (value.length > 0) return value;
  }
  return null;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}
