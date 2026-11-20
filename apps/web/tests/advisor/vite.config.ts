import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
const inApp = (paths: readonly string[]) =>
  new Set(paths.map((path) => NodePath.resolve(appSource, path)));

// The advisor components, the real settings row chrome and the real menu,
// timeline row and Markdown render as shipped. Only the stores they read
// (scope, settings, environments, thread shell, commands, item detail) and the
// router are swapped, and only for these importers.
const owners = inApp([
  "components/settings/AdvisorSettings.tsx",
  "components/settings/settingsLayout.tsx",
  "components/chat/ThreadAdvisorMenu.tsx",
  "components/chat/AdvisorConsultRow.tsx",
]);
const stubbed = inApp([
  "components/settings/SettingsScopeContext",
  "components/settings/useScopedSettings",
  "components/settings/SettingsScopeSentence",
  "state/environments",
  "state/session",
  "hooks/useSettings",
  "state/entities",
  "state/threads",
  "state/use-orchestration-command",
  "state/queries",
]);

export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-advisor-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !owners.has(importer)) return;
        if (source === "@tanstack/react-router") return mocks;
        const target = source.startsWith("~/")
          ? NodePath.resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? NodePath.resolve(NodePath.dirname(importer), source)
            : source;
        if (stubbed.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/advisor/site",
    emptyOutDir: true,
  },
});
