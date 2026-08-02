import { defineConfig } from "vitest/config";

// P0: use a bare vitest config that does NOT load the Cloudflare Vite plugin.
// The plugin manages its own Worker environment and rejects `resolve.external`
// injected by vitest's node runner. Later phases can switch to
// @cloudflare/vitest-pool-workers for tests that need Worker bindings.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
