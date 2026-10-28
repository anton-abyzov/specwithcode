import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const stubs = new Set(
  ["SettingsScopeContext", "useScopedSettings", "settingsLayout", "SettingsScopeNotice"].map(
    (name) => resolve(sourceRoot, "components/settings", name),
  ),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "synthetic-workspace-state",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !source.startsWith(".")) return;
        const target = resolve(dirname(importer), source).replace(/\.(tsx?|jsx?)$/, "");
        if (stubs.has(target)) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": sourceRoot } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/workspace-lifecycle/site",
    emptyOutDir: true,
  },
});
