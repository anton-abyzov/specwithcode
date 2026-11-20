import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const underTest = resolve(sourceRoot, "components/settings") + "/";
const isolated = new Set(
  [
    "state/server",
    "state/query",
    "state/use-atom-command",
    "localApi",
    "hooks/useCopyToClipboard",
    "components/settings/settingsLayout",
    "components/settings/SettingsGroup",
  ].map((name) => resolve(sourceRoot, name)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-device-auth-state",
      enforce: "pre",
      resolveId(source, importer) {
        // Only the components under test get fixture boundaries. Shared state
        // modules they pull in keep their real imports, or the build breaks on
        // exports the fixture never needed.
        if (!importer?.startsWith(underTest)) return;
        if (source === "@specweave-studio/client-runtime/state/runtime") return mocks;
        // Only the wizard step reads the provider list through an atom.
        if (
          source === "@effect/atom-react" &&
          importer?.includes("ProviderWizardAuthenticationStep")
        )
          return mocks;
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
