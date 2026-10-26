import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const stub = (file: string) => NodeURL.fileURLToPath(new URL(`./stubs/${file}`, import.meta.url));
const configs = stub("serverConfigs.ts");

// The real ProjectThreadHeader; only its data, commands and the controls beside the
// model chip are answered by the fixture.
const HEADER_STUBS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/env$/, stub("env.ts")],
  [/hooks\/useThreadActionMenu$/, stub("headerHooks.ts")],
  [/state\/threads$/, stub("headerHooks.ts")],
  [/state\/use-orchestration-command$/, stub("headerHooks.ts")],
  [/hooks\/useOpenThread$/, stub("headerHooks.ts")],
  [/state\/environments$/, stub("headerHooks.ts")],
  [/chat\/ThreadArtifacts$/, stub("headerChips.tsx")],
  [/chat\/TimelineDetailMenu$/, stub("headerChips.tsx")],
  [/\/RoutingDecisionChip$/, stub("headerChips.tsx")],
  [/\/SubagentsChip$/, stub("headerChips.tsx")],
  [/handoff\/HandoffBadge$/, stub("headerChips.tsx")],
];

const headerStubs: Plugin = {
  name: "thread-header-chip-stubs",
  enforce: "pre",
  resolveId(source, importer) {
    if (importer?.endsWith("ProjectThreadHeader.tsx"))
      for (const [pattern, file] of HEADER_STUBS) if (pattern.test(source)) return file;
    if (importer?.endsWith("ModelBadge.tsx") && /state\/entities$/.test(source)) return configs;
    return null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [headerStubs, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/thread-header-chip/site",
    emptyOutDir: true,
  },
});
