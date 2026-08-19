import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// P0: use a bare vitest config that does NOT load the Cloudflare Vite plugin.
// The plugin manages its own Worker environment and rejects `resolve.external`
// injected by vitest's node runner. Later phases can switch to
// @cloudflare/vitest-pool-workers for tests that need Worker bindings.
//
// P28a: split into two vitest *projects* instead of tagging individual files
// with `// @vitest-environment` docblocks. Two reasons. The environment then
// follows from where a file lives, so there is no per-file comment to forget on
// the next test. And the client half needs more than an environment — a setup
// file for Testing Library cleanup and the `@/` alias — neither of which a
// docblock can carry, so a docblock split would still need a second mechanism.
// `test.projects` is the supported form in Vitest 4; `test.workspace` and
// `environmentMatchGlobs` were both removed before this version.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        // Worker tests stay on node: they run real better-sqlite3 and a Hono
        // app, and never touch a DOM.
        test: {
          name: "worker",
          environment: "node",
          include: ["src/worker/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "client",
          // happy-dom rather than jsdom, on two pieces of evidence:
          //  1. jsdom@30 (current major) declares
          //     `node: ^22.22.2 || ^24.15.0 || >=26.0.0`, which this repo's
          //     `engines.node: >=20` does not satisfy. Adopting jsdom would mean
          //     pinning the previous major and being unable to upgrade until the
          //     repo's Node baseline moves.
          //  2. jsdom@29 has no `ResizeObserver`, which cmdk constructs on mount,
          //     so every CommandPalette test would need a global shim first.
          // happy-dom@20 supports node >=20, ships ResizeObserver, and starts an
          // environment in ~190ms against jsdom's ~525ms. If a future surface
          // needs DOM behaviour happy-dom lacks, the fallback is jsdom@29 plus a
          // ResizeObserver shim in test-setup.ts.
          environment: "happy-dom",
          include: ["src/client/**/*.test.ts", "src/client/**/*.test.tsx"],
          setupFiles: ["./src/client/test-setup.ts"],
        },
        resolve: {
          alias: {
            // Mirrors vite.config.ts. Vitest does not load the app config here,
            // so without repeating the alias every `@/components/ui/*` import in
            // a client test fails to resolve.
            "@": fileURLToPath(new URL("./src/client", import.meta.url)),
          },
        },
      },
    ],
  },
});
