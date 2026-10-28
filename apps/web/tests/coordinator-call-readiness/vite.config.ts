import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
const mock = fileURLToPath(new URL("./mocks.tsx", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /.*\/hooks\/useSettings$/, replacement: mock },
      { find: /.*\/state\/environments$/, replacement: mock },
      { find: /.*\/state\/server$/, replacement: mock },
      { find: /.*\/connection\/runtime$/, replacement: mock },
      { find: /.*\/rpc\/atomRegistry$/, replacement: mock },
      { find: /.*\/studio\/voiceCallAudio$/, replacement: mock },
      { find: /^\.\/VoiceSettings$/, replacement: mock },
      { find: /^\.\.\/\.\.\/env$/, replacement: mock },
      { find: /^\.\.\/env$/, replacement: mock },
      { find: "@specweave-studio/client-runtime/state/runtime", replacement: mock },
      { find: "@effect/atom-react", replacement: mock },
    ],
  },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/coordinator-call-readiness",
    emptyOutDir: true,
  },
});
