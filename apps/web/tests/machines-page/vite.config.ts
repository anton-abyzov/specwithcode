import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

import { mockFor } from "./isolation.mjs";

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-machines-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        const mock = mockFor(id, importer);
        if (mock) return NodeURL.fileURLToPath(new URL(`./${mock}`, import.meta.url));
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/machines-page/site",
    emptyOutDir: true,
  },
});
