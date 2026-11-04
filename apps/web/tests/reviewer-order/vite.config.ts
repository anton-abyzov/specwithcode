import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));

// The production settings component over fixture stores: only the modules that
// read live app state (environments, scoped settings, scope, router, row chrome)
// are swapped, so the list, chips and picker render as shipped.
function fixtureStores(): Plugin {
  const stubs: Record<string, string> = {
    "../../state/environments": here("./stubs/environments.ts"),
    "./useScopedSettings": here("./stubs/scopedSettings.ts"),
    "./SettingsScopeContext": here("./stubs/scope.ts"),
    "./settingsLayout": here("./stubs/settingsLayout.tsx"),
    "@tanstack/react-router": here("./stubs/router.ts"),
  };
  return {
    name: "reviewer-order-fixture-stores",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer || importer.includes("/tests/reviewer-order/stubs/")) return null;
      if (
        !/components\/settings\/(AdversarialReviewSettings|ProviderLimitSettings)\.tsx$/.test(
          importer,
        )
      )
        return null;
      return stubs[id] ?? null;
    },
  };
}

export default defineConfig({
  root: here("."),
  plugins: [fixtureStores(), react(), tailwindcss()],
  resolve: { alias: { "~": here("../../src") } },
  build: { outDir: "../../../../.artifacts/reviewer-order/site", emptyOutDir: true },
});
