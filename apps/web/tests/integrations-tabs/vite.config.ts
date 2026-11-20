import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const root = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const app = NodePath.resolve(root, "../../src");
const mocks = NodePath.resolve(root, "mocks.tsx");
/** App modules that reach a server or a live store; the fixture stands in for them. */
const stubs = new Set(
  [
    "state/environments",
    "state/session",
    "state/entities",
    "state/query",
    "state/use-atom-command",
    "studio/projectWorkspace",
    "studio/machineNickname",
    "components/settings/SettingsScopeContext",
    "components/settings/useNamedEnvironments",
    "components/settings/useScopedSettings",
  ].map((path) => NodePath.resolve(app, path)),
);

export default defineConfig({
  root,
  plugins: [
    {
      name: "isolated-integrations-tabs",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !source.startsWith(".")) return;
        const target = NodePath.resolve(NodePath.dirname(importer), source).replace(
          /\.(tsx?|jsx?)$/,
          "",
        );
        if (stubs.has(target)) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  build: { outDir: "../../../../.artifacts/integrations-tabs/site", emptyOutDir: true },
});
