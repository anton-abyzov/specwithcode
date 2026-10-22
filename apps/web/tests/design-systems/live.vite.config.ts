// The real web app for live.mjs, built to .artifacts/ so the worktree's own
// apps/web/dist stays untouched. Build from apps/web:
//   node ../../node_modules/vite-plus/bin/vp build --config tests/design-systems/live.vite.config.ts
import * as NodeURL from "node:url";
import { defineConfig, mergeConfig } from "vite-plus";

import base from "../../vite.config.ts";

const outDir = NodeURL.fileURLToPath(
  new URL("../../../../.artifacts/design-systems/live-web", import.meta.url),
);

export default defineConfig(async (env) => {
  const resolved = typeof base === "function" ? await base(env) : base;
  return mergeConfig(resolved, {
    build: { outDir, emptyOutDir: true, sourcemap: false },
  });
});
