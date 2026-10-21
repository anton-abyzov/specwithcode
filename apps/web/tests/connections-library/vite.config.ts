import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
const root = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const app = NodePath.resolve(root, "../../src");
const mocks = NodePath.resolve(root, "mocks.tsx");
const stubs = new Set(
  [
    "state/environments",
    "state/session",
    "state/query",
    "studio/projectWorkspace",
    "state/use-atom-command",
    "components/settings/SettingsScopeContext",
    "components/settings/settingsLayout",
  ].map((p) => NodePath.resolve(app, p)),
);
export default defineConfig({
  root,
  plugins: [
    {
      name: "isolated-connections",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !source.startsWith(".")) return;
        if (
          stubs.has(
            NodePath.resolve(NodePath.dirname(importer), source).replace(/\.(tsx?|jsx?)$/, ""),
          )
        )
          return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  build: { outDir: "../../../../.artifacts/connections-library/site", emptyOutDir: true },
});
