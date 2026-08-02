# ADR-0001: Web-first frontend, wrapped by Tauri 2 for desktop & mobile

- **Status:** Accepted (amended 2026-08-02: `pi-web-ui` no longer exists — chat-UI rationale updated to React libraries; decision unchanged)
- **Date:** 2026-08-02
- **Related:** [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)

## Context

TIL must run on web, desktop, and mobile. The rest of the stack is TypeScript (Cloudflare Workers, AI SDK), we deploy on Cloudflare, and we want maximum code reuse across platforms with the smallest team (one person). The chat UI (M3) will use React component libraries (AI Elements / assistant-ui — see [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)), which are DOM/React-native.

## Decision

Build **one React + Vite web app** as the source of truth. It deploys to Cloudflare as the web target. For desktop and mobile (milestone M4), wrap that _same_ build with **Tauri 2**, which hosts the static web assets in a native webview.

- Web: React + Vite + Tailwind + React Router + TanStack Query.
- Desktop (Win/Mac/Linux): Tauri 2 — production-ready today.
- Mobile (iOS/Android): Tauri 2 — usable, with caveats (below).

## Alternatives considered

- **Expo / React Native.** Best _native_ mobile feel and web via `react-native-web`. Rejected because: React-DOM chat UI libraries (AI Elements / assistant-ui) can't be reused — the chat UI would be rebuilt in RN; desktop is the weak spot (community Electron wrappers); larger divergence from our all-TS/DOM stack.
- **Flutter.** Single Dart codebase, best native feel on every platform. Rejected because it abandons the TypeScript/DOM/Cloudflare synergy on the frontend and splits languages from the backend, for a solo project.
- **PWA instead of Tauri (M4).** Installable on desktop and mobile home screens with zero store friction — a serious cheapener for M4. Kept as the _first_ M4 step; Tauri remains the path when native-shell capabilities (system tray, share targets, offline SQLite) are wanted.

## Consequences

**Positive**

- One codebase, one language end-to-end; React chat-UI libraries reusable as-is.
- Web ships first and independently; desktop/mobile are additive later.

**Negative / caveats**

- Mobile is a **webview**, not native UI; Tauri mobile is younger than desktop and not every plugin is ported.
- Must keep the client's **API base URL configurable** — inside Tauri there is no co-located Worker, so it points at the deployed (or local) Worker. The API must add **CORS headers** for the Tauri origin, and the bearer-token auth ([ADR-0007](./0007-single-user-local-first.md)) already fits this remote-client model.
- Webview differences across OSes (WKWebView vs Android WebView) require testing.
- Store distribution friction: iOS needs macOS + Xcode + Apple Developer; Android needs a Play Console account and a manual first upload.
