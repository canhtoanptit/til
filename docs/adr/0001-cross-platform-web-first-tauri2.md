# ADR-0001: Web-first frontend, wrapped by Tauri 2 for desktop & mobile

- **Status:** Proposed
- **Date:** 2026-08-02
- **Related:** [ADR-0002](./0002-ai-stack-pi-cloudflare-ai-gateway.md), [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)

## Context

TIL must run on web, desktop, and mobile. The rest of the stack is TypeScript (Cloudflare Workers, Pi), we deploy on Cloudflare, and we want maximum code reuse across platforms with the smallest team (one person). The chat UI we plan to reuse (`pi-web-ui`) ships as DOM web components.

## Decision

Build **one React + Vite web app** as the source of truth. It deploys to Cloudflare as the web target. For desktop and mobile (milestone M4), wrap that *same* build with **Tauri 2**, which hosts the static web assets in a native webview.

- Web: React + Vite + Tailwind + React Router + TanStack Query.
- Desktop (Win/Mac/Linux): Tauri 2 — production-ready today.
- Mobile (iOS/Android): Tauri 2 — usable, with caveats (below).

## Alternatives considered

- **Expo / React Native.** Best *native* mobile feel and web via `react-native-web`. Rejected because: `pi-web-ui` (DOM components) can't be reused — the chat UI would be rebuilt in RN; desktop is the weak spot (community Electron wrappers); larger divergence from our all-TS/DOM stack.
- **Flutter.** Single Dart codebase, best native feel on every platform. Rejected because it abandons the TypeScript/Pi/Cloudflare synergy on the frontend — no `pi-web-ui`, and a language split from the backend, for a solo project.

## Consequences

**Positive**
- One codebase, one language end-to-end; `pi-web-ui` reusable as-is.
- Web ships first and independently; desktop/mobile are additive later.

**Negative / caveats**
- Mobile is a **webview**, not native UI; Tauri mobile is younger than desktop and not every plugin is ported.
- Must keep the client's **API base URL configurable** — inside Tauri there is no co-located Worker, so it points at the deployed (or local) Worker.
- Webview differences across OSes (WKWebView vs Android WebView) require testing.
- Store distribution friction: iOS needs macOS + Xcode + Apple Developer; Android needs a Play Console account and a manual first upload.
