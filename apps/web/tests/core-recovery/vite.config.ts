import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// Only the drawer sees the mocks: its stores and RPCs. The queue derivation
// (thread-workflows), the banner kit and the tooltips are real.
const owners = /QueuedRunsControl\.tsx$/;
const mocked =
  /(\/state\/entities|\/state\/threads|\/state\/use-atom-command|\/assets\/assetUrls|^@specweave-studio\/client-runtime\/state\/runtime)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-core-recovery-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer && owners.test(importer) && mocked.test(id)) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/core-recovery/site",
    emptyOutDir: true,
  },
});
