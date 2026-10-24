import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = fileURLToPath(new URL(".", import.meta.url));
const app = resolve(root, "../../src");
const mocks = resolve(root, "mocks.tsx");
const stubs = new Set(
  [
    "hooks/useSettings",
    "state/environments",
    "state/session",
    "components/settings/SettingsScopeContext",
    "components/settings/useScopedSettings",
    "components/settings/SettingsScopeSentence",
    "components/settings/SettingInheritance",
    "components/settings/AcpSessionManagementSection",
  ].map((p) => resolve(app, p)),
);
export default defineConfig({
  root,
  plugins: [
    {
      name: "settings-design-isolation",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "@tanstack/react-router") return mocks;
        if (!importer) return;
        const target = source.startsWith("~/")
          ? resolve(app, source.slice(2))
          : source.startsWith(".")
            ? resolve(dirname(importer), source)
            : source;
        if (stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": app } },
  server: { host: "127.0.0.1", port: 5849, strictPort: true },
  build: { outDir: "../../../../.artifacts/settings-design/site", emptyOutDir: true },
});
