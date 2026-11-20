import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const stubs = NodeURL.fileURLToPath(new URL("./projectStubs.tsx", import.meta.url));

// The header's project lookups, answered by the fixture so ?project=1 shows the reply style.
const projectStubs: Plugin = {
  name: "timeline-detail-project-stubs",
  enforce: "pre",
  resolveId(source, importer) {
    if (importer?.endsWith("ChatHeader.tsx") && /state\/entities$/.test(source)) return stubs;
    if (
      importer?.endsWith("TimelineDetailMenu.tsx") &&
      /settings\/(useSettingsProjectGroups|useScopedSettings|SettingsScopeContext)$/.test(source)
    )
      return stubs;
    return null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [projectStubs, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: { outDir: "../../../../.artifacts/timeline-detail/site", emptyOutDir: true },
});
