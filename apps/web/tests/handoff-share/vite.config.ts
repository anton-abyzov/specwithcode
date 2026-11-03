import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "handoff-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (
          importer?.endsWith("/HandoffShare.tsx") &&
          /HandoffCopyScope|state\/(entities|projectClones|sourceControl|use-atom-command)|studio\/addToMachineCopy/.test(
            id,
          )
        )
          return fileURLToPath(new URL("./mocks.ts", import.meta.url));
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/handoff-share/site",
    emptyOutDir: true,
  },
});
