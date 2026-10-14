import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const isolated = new Set(
  [
    "state/server",
    "state/query",
    "state/use-atom-command",
    "localApi",
    "hooks/useCopyToClipboard",
    "components/settings/settingsLayout",
  ].map((name) => resolve(sourceRoot, name)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-device-auth-state",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "@specweave-studio/client-runtime/state/runtime") return mocks;
        if (!importer || !source.startsWith(".")) return;
        const target = resolve(dirname(importer), source).replace(/\.(tsx?|jsx?)$/, "");
        if (isolated.has(target)) return mocks;
        if (target === resolve(sourceRoot, "components/settings/ProviderAuthTerminal"))
          return resolve(fixture, "terminal.tsx");
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": sourceRoot } },
  build: { outDir: "../../../../.artifacts/provider-device-auth/site", emptyOutDir: true },
});
