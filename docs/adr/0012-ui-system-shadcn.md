# ADR-0012: UI system — adopt shadcn/ui (vendored), before the feature wave

- **Status:** Accepted
- **Date:** 2026-08-08
- **Related:** [ADR-0001](./0001-cross-platform-web-first-tauri2.md), [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)

## Context

At P4 (three plain screens) the call was raw Tailwind, with shadcn expected to arrive implicitly via AI Elements in M3. Reality diverged: M3's chat used `useAgentChat` with hand-rolled components, so shadcn never arrived — while the UI grew to six pages and ~a dozen components. The seams now show: delete confirmations are `window.confirm`, mutations have no toasts, the stats tool renders bare tables, collapsibles and badges are hand-rolled per page, and there is no dark mode. The owner has asked for shadcn twice; a features wave is about to add several new screens.

## Decision

Adopt **shadcn/ui** in a dedicated UI-refresh phase that lands **before** the feature wave, so new feature UIs are built on the system rather than restyled after.

- Components are **vendored** into `apps/web/src/client/components/ui/` (shadcn is a generator, not a runtime dependency — consistent with this project's lock-in philosophy; the only runtime additions are Radix primitives + small utilities).
- Tailwind **v4 CSS-variable theming**, mapped to the existing slate palette so the refresh is a restyle, not a redesign.
- Scope of the swap: `Button, Input, Textarea, Select, Dialog (kills window.confirm), DropdownMenu, Badge (tags), Skeleton, Table (stats/digests), Collapsible (chat tool parts), Card`, plus **sonner** for mutation toasts.
- Two cheap adds that fall out of the system: **dark mode** (class strategy + CSS vars + a Shell toggle) and a **⌘K command palette** (cmdk) wired to the existing hybrid search.
- Pure refactor otherwise: no behaviour changes, all existing tests stay green, bundle impact reported.
- Exact shadcn init/config details are verified at phase kickoff against current docs (per standing practice), not assumed from this ADR.

## Alternatives considered

- **Keep hand-rolling Tailwind.** Fine at 3 screens; at 6+ pages it repeats primitives, ships a11y gaps (`window.confirm`, unlabeled collapsibles), and every new feature pays the styling tax again.
- **A component library dependency (Mantine/MUI/HeroUI).** Faster day one, but a runtime dependency with its own theme system and upgrade treadmill — the opposite of the vendored-code posture this repo prefers.
- **Radix directly, no shadcn.** Same runtime, more work: shadcn's generated code _is_ the Radix wiring we'd hand-write.
- **AI Elements first.** It presumes shadcn, so it cannot come first; adopting shadcn now keeps AI Elements available later for the chat surface.
- **Defer until after the features.** Guarantees double work: feature UIs built on the old idiom then migrated.

## Consequences

**Positive**

- Consistent primitives + accessibility (focus traps, aria) for free on every future screen; feature wave builds on the system.
- Dark mode and ⌘K at near-zero marginal cost; AI Elements becomes adoptable later.
- Vendored components mean no upstream upgrade pressure — we own the code we ship.

**Negative / caveats**

- One-time visual churn and a large mechanical diff (isolated to `src/client`).
- Radix adds client-bundle weight (currently ~91 kB gzip; expect growth — measured and reported in the phase).
- Owning vendored code cuts both ways: upstream fixes arrive only if we re-generate.
