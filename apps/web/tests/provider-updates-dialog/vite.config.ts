import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("."),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^~\/state\/(environments|session|server|use-atom-command)$/,
        replacement: here("./mocks/$1.ts"),
      },
      { find: "~", replacement: here("../../src") },
    ],
  },
  build: { outDir: "../../../../.artifacts/provider-updates-dialog/site", emptyOutDir: true },
});
