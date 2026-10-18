import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
// Renders the real computer-use permission card, composer notice, Settings check and
// Connections note against a fake desktop bridge. The machine lookups are stubbed so no
// server or store is involved.
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^.*\/state\/primaryEnvironment$/, replacement: resolve(fixture, "stubs.ts") },
      { find: /^.*\/state\/environments$/, replacement: resolve(fixture, "stubs.ts") },
      { find: "~", replacement: appSource },
    ],
  },
  build: { outDir: "../../../../.artifacts/computer-use-permissions/site", emptyOutDir: true },
});
