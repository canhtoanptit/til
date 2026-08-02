# ADR-0002: AI stack — Pi (`pi-ai` + `pi-agent-core`) via Cloudflare AI Gateway (BYOK)

- **Status:** Proposed
- **Date:** 2026-08-02
- **Related:** [ADR-0005](./0005-byok-llmclient-abstraction-nodejs-compat.md), [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)

## Context

Part of the point of TIL is to *experiment building an AI system*: configurable agents and a BYOK LLM gateway. The stack is TypeScript and deploys on Cloudflare. We need: (a) a unified way to call multiple providers with the user's own key, (b) an agent runtime with tool-calling for the later digest/chat features, and (c) chat UI. We want a control plane (caching, rate limits, cost/observability) without building it ourselves.

Mario Zechner's **Pi** provides `pi-ai` (unified multi-provider LLM API — OpenAI/Anthropic/Google/OpenRouter/any OpenAI-compatible — with cost tracking), `pi-agent-core` (LLM + tool-call loop), and `pi-web-ui` (chat components). **Cloudflare AI Gateway** provides the control plane and BYOK routing.

## Decision

Use **Pi as the in-app AI layer**, with all LLM calls **routed through Cloudflare AI Gateway** using the user's own provider key (BYOK, entered in-app):

- `pi-ai` for provider-agnostic completions (M1 ingest digest).
- `pi-agent-core` for the tool-calling agents (M2 digest, M3 chat).
- `pi-web-ui` for the chat interface (M3).
- AI Gateway for caching, rate-limiting, cost tracking, and retries.

Research confirmed Pi supports per-provider `baseUrl` + per-request headers and already recognizes `cf-aig-authorization`, so it routes to AI Gateway cleanly.

## Alternatives considered

- **Cloudflare Agents SDK** (Durable-Object-backed stateful agents + AI Gateway). Deepest Cloudflare integration (built-in per-user state, scheduling, resumable inference). Rejected as the primary runtime because it's less portable and doesn't reuse Pi/`pi-web-ui`; may still be adopted selectively for stateful chat sessions in M3.
- **Pi only, no AI Gateway.** Most portable / not Cloudflare-locked, but we'd build caching, rate-limiting, and cost observability ourselves. Rejected — AI Gateway gives that for free and we're already on Cloudflare.

## Consequences

**Positive**
- Portable agent code + a Cloudflare control plane; unified multi-provider BYOK; ready-made chat UI.

**Negative / caveats**
- `pi-ai`'s barrel entry imports `node:fs` → the Worker needs `nodejs_compat`; contained via the `LLMClient` abstraction ([ADR-0005](./0005-byok-llmclient-abstraction-nodejs-compat.md)).
- Pi's package namespace is mid-migration (`@mariozechner/*` → `@earendil-works/*`) and moves fast → pin versions.
- Two evolving ecosystems (Pi + Cloudflare) to track.
