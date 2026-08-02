# ADR-0005: BYOK access via an `LLMClient` abstraction + `nodejs_compat`

- **Status:** Proposed
- **Date:** 2026-08-02
- **Related:** [ADR-0002](./0002-ai-stack-pi-cloudflare-ai-gateway.md), [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)

## Context

We chose Pi as the AI layer ([ADR-0002](./0002-ai-stack-pi-cloudflare-ai-gateway.md)). Research surfaced two realities:

1. `@mariozechner/pi-ai`'s barrel entry transitively imports `node:fs` (and registers a Bedrock provider pulling the AWS SDK). It is **not** clean in a bare Workers isolate — it needs the Worker `nodejs_compat` flag, or careful deep-imports.
2. Pi's package namespace is migrating (`@mariozechner/*` → `@earendil-works/*`) and moves quickly.

The M1 ingest call is a single **structured completion** — something achievable with or without Pi. We want to validate the chosen stack early *without* betting the milestone on Pi behaving perfectly inside Workers.

## Decision

Introduce a thin internal boundary in `packages/core`:

```ts
export interface LLMClient {
  digest(markdown: string, meta: { url: string; title?: string }): Promise<Digest>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}
```

- **`PiLLMClient`** implements it with `pi-ai` (pinned version), `baseUrl` → AI Gateway, BYOK header from settings, Worker `fetch` injected.
- **`DirectLLMClient`** implements it with a plain `fetch` to the same AI Gateway URL — a guaranteed fallback.
- Enable **`nodejs_compat`** on the Worker so Pi loads.
- Nothing outside `packages/core` imports Pi directly.

`pi-agent-core` is added behind a similar boundary when agents arrive (M2/M3).

## Alternatives considered

- **Bind directly to Pi throughout the app.** Rejected: couples every layer to Pi's fast-moving surface and the Node-compat gotcha; hard to fall back.
- **`DirectLLMClient` only (skip Pi).** Rejected: loses Pi's agent runtime and unified provider features needed for M2/M3; contradicts the stated experiment.

## Consequences

**Positive**
- Risk contained: M1 ships even if Pi fights the runtime (swap the impl, no rearchitecture).
- Swappable providers/implementations; a clean seam for testing.

**Negative / caveats**
- One extra abstraction layer to maintain.
- `nodejs_compat` adds bundle overhead ([ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)).
- Must pick and pin a Pi namespace/version at install time (tracked as an open question).
