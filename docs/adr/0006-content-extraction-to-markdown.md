# ADR-0006: Content extraction — `env.AI.toMarkdown()` default, Browser Rendering fallback

- **Status:** Accepted (amended 2026-08-02: accessed via an `Extractor` seam)
- **Date:** 2026-08-02
- **Related:** [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md), [ADR-0005](./0005-byok-llmclient-abstraction.md)

## Context

The core loop needs clean article text/markdown from an arbitrary URL, produced **inside a Cloudflare Worker** (no full Node runtime), to feed the LLM. Options differ in bundle cost, CPU, and ability to handle JavaScript-rendered pages.

## Decision

Default to Cloudflare's native **`env.AI.toMarkdown()`** to convert fetched HTML to markdown. Reserve **Browser Rendering** (`/markdown` endpoint / `@cloudflare/puppeteer`) as a **fallback for JavaScript-heavy pages**, added in a later milestone. When both are unavailable/blocked, fail the entry gracefully (`status = failed`) with a retry path.

Extraction is accessed through an **`Extractor` interface in `packages/core`** (mirroring `LLMClient`, [ADR-0005](./0005-byok-llmclient-abstraction.md)) so `toMarkdown` stays the one-line default rather than a hard dependency — swappable for Browser Rendering, Readability-in-isolate, or an external reader (e.g. Jina Reader) without touching the pipeline.

## Alternatives considered

- **`@mozilla/readability` + `linkedom` + Turndown, in the isolate.** Self-contained reader-view extraction with fine control, but ~400 KB bundle and CPU-bound (practically a paid Workers plan), and still only sees server-rendered HTML. Rejected as the default (kept as a possible option if we want reader-view control without the Workers-AI dependency).
- **External scraping/extraction API.** Rejected for M1: added cost, another dependency, and another key to manage.

## Consequences

**Positive**

- Least code, cheap, no bundle cost; simplest path to a working slice.
- Clear, known upgrade path (Browser Rendering) for JS-heavy pages.

**Negative / caveats**

- Depends on the Workers **AI** binding.
- **Universal limits:** paywalls, bot-protection (challenges/IP rate-limits), and heavy client-side rendering will defeat `toMarkdown` — some URLs simply won't ingest; the UI must surface this, not hang.
- Extraction/Browser-Rendering usage likely implies a **paid Workers plan**.
