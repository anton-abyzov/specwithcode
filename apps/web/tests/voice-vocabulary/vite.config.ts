import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const mock = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
const src = NodeURL.fileURLToPath(new URL("../../src/", import.meta.url));
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^~\//, replacement: src },
      { find: /.*\/hooks\/useSettings$/, replacement: mock },
      { find: /.*\/state\/environments$/, replacement: mock },
      { find: /.*\/state\/server$/, replacement: mock },
      { find: /^\.\/settingsLayout$/, replacement: mock },
      { find: /^\.\/settingsSearch$/, replacement: mock },
      { find: /.*\/state\/use-atom-command$/, replacement: mock },
      { find: /.*\/studio\/voiceCallAudio$/, replacement: mock },
      { find: /^\.\.\/\.\.\/keybindings$/, replacement: mock },
      { find: /^\.\.\/\.\.\/i18n$/, replacement: mock },
      { find: /^\.\.\/\.\.\/env$/, replacement: mock },
      { find: /^\.\.\/env$/, replacement: mock },
      { find: "@tanstack/react-router", replacement: mock },
      { find: "@effect/atom-react", replacement: mock },
    ],
  },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/voice-vocabulary",
    emptyOutDir: true,
  },
});
