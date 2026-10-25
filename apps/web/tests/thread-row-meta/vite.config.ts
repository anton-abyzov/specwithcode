import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const progress = NodeURL.fileURLToPath(new URL("./incrementProgress.ts", import.meta.url));
const configs = NodeURL.fileURLToPath(new URL("./serverConfigs.ts", import.meta.url));

// The Threads pane reads increment progress and provider config from its host; the fixture answers both.
const syntheticProgress: Plugin = {
  name: "thread-row-meta-progress",
  enforce: "pre",
  resolveId(source, importer) {
    if (importer?.endsWith("ThreadsPane.tsx") && /useThreadIncrementProgress$/.test(source))
      return progress;
    if (importer?.endsWith("ModelBadge.tsx") && /state\/entities$/.test(source)) return configs;
    return null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [syntheticProgress, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/thread-row-meta/site",
    emptyOutDir: true,
  },
});
