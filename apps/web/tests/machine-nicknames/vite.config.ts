import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));
// Real cards, banner and picker labels; nicknames and thread state come from stubs.
export default defineConfig({
  root: here("."),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^.*\/studio\/machineNickname$/, replacement: here("./stubs/machineNickname.ts") },
      { find: /^.*\/state\/entities$/, replacement: here("./stubs/entities.ts") },
      { find: /^.*\/hooks\/useOpenThread$/, replacement: here("./stubs/useOpenThread.ts") },
      { find: /^.*\/hooks\/useLiveRefresh$/, replacement: here("./stubs/useLiveRefresh.ts") },
      { find: /^.*\/studio\/fleet$/, replacement: here("./stubs/fleet.ts") },
      { find: "~", replacement: here("../../src") },
    ],
  },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/machine-nicknames/site",
    emptyOutDir: true,
  },
});
