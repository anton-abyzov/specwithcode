import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

// The real creation dialogs and design editor with synthetic data: no server, account,
// provider, network or store.
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/design-create/site",
    emptyOutDir: true,
  },
});
