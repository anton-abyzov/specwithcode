import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const stubs = new Set(
  [
    "state/query",
    "state/environments",
    "state/session",
    "state/use-atom-command",
    "studio/projectWorkspace",
    "studio/fleet",
    "components/settings/ProjectSkillControls",
  ].map((path) => resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "skill-detail-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return;
        const target = source.startsWith("~/")
          ? resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? resolve(dirname(importer), source)
            : null;
        if (target && stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
      transform(code, id) {
        if (id.endsWith("/components/settings/ProjectSkillsSettings.tsx"))
          return `${code}\nexport { SkillDetails };`;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: { outDir: "../../../../.artifacts/skill-management/site", emptyOutDir: true },
});
