import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { buildDeps } from "./build-deps.js";
import { runDigest, type DigestRunOutcome } from "./digest-run.js";
import {
  clampMaxItems,
  clampWindowDays,
  normalizeDigestKind,
  type DigestRunParams,
  type DigestStep,
  type DigestStepConfig,
} from "./digest.js";
import type { Env } from "./env.js";

interface LooseWorkflowStep {
  do(
    name: string,
    config: DigestStepConfig,
    callback: () => Promise<unknown>,
  ): Promise<unknown>;
}

// WHY: `WorkflowStep.do` constrains its result to `Rpc.Serializable<T>`, which a
// generic pass-through cannot prove. The cast is confined here so the run logic
// stays free of `cloudflare:workers` types (and therefore unit-testable in node).
export function toDigestStep(step: WorkflowStep): DigestStep {
  const loose = step as unknown as LooseWorkflowStep;
  return {
    do: <T>(name: string, config: DigestStepConfig, fn: () => Promise<T>) =>
      loose.do(name, config, fn) as Promise<T>,
  };
}

export class DigestWorkflow extends WorkflowEntrypoint<Env, DigestRunParams> {
  override async run(
    event: Readonly<WorkflowEvent<DigestRunParams>>,
    step: WorkflowStep,
  ): Promise<DigestRunOutcome> {
    const deps = buildDeps(this.env, this.ctx);
    const payload = event.payload as Partial<DigestRunParams> | undefined;
    // A payload with no `kind` is a run started before P26 — normalize to weekly,
    // which is what it was.
    const kind = normalizeDigestKind(payload?.kind);
    const params: DigestRunParams = {
      digestId: payload?.digestId ?? event.instanceId,
      windowDays: clampWindowDays(payload?.windowDays, kind),
      maxItems: clampMaxItems(payload?.maxItems),
      kind,
      now: payload?.now ?? event.timestamp.getTime(),
    };
    return runDigest(deps, params, toDigestStep(step));
  }
}
