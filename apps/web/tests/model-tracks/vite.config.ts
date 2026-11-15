import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));

// The production tracks and Sources lists over fixture stores: only the
// modules that read live app state are swapped (the reviewer-order stubs), so
// the rows, chips, picker and drag handling render as shipped.
function fixtureStores(): Plugin {
  const stubs: Record<string, string> = {
    "../../state/environments": here("../reviewer-order/stubs/environments.ts"),
    "./useScopedSettings": here("../reviewer-order/stubs/scopedSettings.ts"),
    "./SettingsScopeContext": here("../reviewer-order/stubs/scope.ts"),
    "./settingsLayout": here("../reviewer-order/stubs/settingsLayout.tsx"),
  };
  return {
    name: "model-tracks-fixture-stores",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer || !/components\/settings\/ModelTracksSettings\.tsx$/.test(importer))
        return null;
      return stubs[id] ?? null;
    },
  };
}

export default defineConfig({
  root: here("."),
  plugins: [fixtureStores(), react(), tailwindcss()],
  resolve: { alias: { "~": here("../../src") } },
  build: { outDir: "../../../../.artifacts/model-tracks/site", emptyOutDir: true },
});
