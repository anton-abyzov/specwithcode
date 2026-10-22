import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const stub = NodeURL.fileURLToPath(new URL("./stubs.tsx", import.meta.url));
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /(?:\.\.\/)+state\/(use-atom-command|filesystem|query)$/, replacement: stub },
      { find: /(?:\.\.\/)+studio\/(machineHandoff|projectLink)$/, replacement: stub },
      { find: "@specweave-studio/client-runtime/state/runtime", replacement: stub },
      { find: /(?:\.\.\/)+settings\/MachineReadinessChecklist$/, replacement: stub },
      { find: "./ProjectLinkDialog", replacement: stub },
      { find: "~", replacement: NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) },
    ],
  },
  build: { target: "esnext", outDir: "../../../../.artifacts/folder-copy/site", emptyOutDir: true },
});
