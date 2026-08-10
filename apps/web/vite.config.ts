import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), cloudflare(), tailwindcss()],
  resolve: {
    alias: {
      // Client-only alias: `@/` is `src/client`, which is what the shadcn
      // generator emits imports against. Worker code never uses it.
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
});
