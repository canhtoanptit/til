# ADR-0005: BYOK access via an `LLMClient` abstraction (AI SDK primary, hand-rolled fallback)

- **Status:** Accepted (v2, 2026-08-02)
- **Date:** 2026-08-02
- **Related:** [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)
- **History:** v1 introduced this seam to contain Pi's Workers risk (`node:fs` → `nodejs_compat`, namespace churn). Pi was replaced by the Vercel AI SDK ([ADR-0002 v2](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)); the seam **survives** with new implementations and new purposes. `nodejs_compat` is not required _by the LLM layer_ — note it was re-enabled at M3 for the Agents SDK ([ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)).

## Context

The M1 ingest call is a single structured completion; M3 adds streaming chat. BYOK means provider clients must be instantiated **per request** from user `settings` (provider, model, key, gateway ids) — never from build-time env. The seam originally hedged a dependency risk; it now serves four purposes:

1. **BYOK wiring** — one place that turns `settings` into a configured client with `baseURL` → Cloudflare AI Gateway.
2. **Fallback** — a zero-dependency implementation guarantees the slice ships regardless of SDK issues.
3. **Learning** — writing the raw-HTTP client first, then diffing it against the SDK client, teaches exactly what the SDK abstracts (a stated project goal).
4. **Exit hatch** — contains AI SDK major-version churn ([ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md) consequences).

## Decision

Keep the thin boundary in `packages/core`:

```ts
export interface LLMClient {
  digest(
    markdown: string,
    meta: { url: string; title?: string },
  ): Promise<Digest>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}
```

- **`DirectLLMClient`** — hand-written first, plain `fetch` against both provider dialects (OpenAI `chat/completions` with `response_format: json_schema`; Anthropic `v1/messages` with forced tool use), through the CF AI Gateway URL. The learning exercise and the guaranteed fallback.
- **`AISDKClient`** — the primary. `ai` v6 with explicit `createOpenAI`/`createAnthropic` instances (never plain model-string IDs — [ADR-0002 guardrail 1](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)), structured output via the v6 API.
- **`createLLMClient(settings)`** factory selects the implementation (`AISDKClient` default; `DirectLLMClient` via config flag).
- Nothing outside `packages/core` imports `ai` or provider packages directly.
- Treat article content as **untrusted data** in prompts: the digest prompt instructs the model to never follow instructions found inside the content, and the digest path exposes **no tools**.

The M3 chat path follows the same rule: `streamChat` in `packages/core` owns the `streamText` call, tool wiring and step bound (`stopWhen: stepCountIs(6)`), while the Durable Object supplies only tool _implementations_ and messages. The loop itself came from `@cloudflare/ai-chat`'s `AIChatAgent` rather than being hand-rolled — the protocol adapter turned out to be the boring, working option, so `pi-agent-core` stayed reference reading only.

## Alternatives considered

- **Bind directly to the AI SDK throughout the app.** Rejected: spreads a fast-moving surface (v4→v5→v6→v7) across every layer; loses the fallback and the per-request BYOK choke point.
- **`DirectLLMClient` only (skip the SDK).** Rejected: hand-maintains two provider dialects forever and gives up structured-output validation, streaming helpers, and the M3 tool loop for no benefit beyond M1.

## Consequences

**Positive**

- Risk contained: implementations swap without rearchitecture; clean seam for testing (mock `LLMClient`).
- The LLM layer needs no Node compat, so provider churn can't reintroduce a compat problem here (the flag now on the Worker is the Agents SDK's, [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)).
- The seam paid off a third time at M3: `streamChat` (chat streaming + tool loop) lives in `packages/core` too, so the Durable Object never imports `ai` — verified structurally, since `import from "ai"` does not resolve inside `apps/web`.
- The two-implementation diff is a deliberate learning artifact.

**Negative / caveats**

- One extra abstraction layer to maintain; the interface must stay task-shaped (`digest`, `ping`, later `answer`) rather than leaking SDK types.
- Two implementations to keep passing the same contract tests.
