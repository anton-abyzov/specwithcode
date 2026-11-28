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

// The install chooser, the search panel and the receipt render as shipped.
// Only the stores they read (settings, project, scope, nickname, commands) and
// the "Also add on" step are swapped, and only for these importers.
const owners = inApp([
  "components/skills/SkillInstallScopeChoice.tsx",
  "components/skills/SkillSearch.tsx",
  "components/skills/SkillUpdateOutcome.tsx",
]);
const stubbed = inApp([
  "state/server",
  "state/entities",
  "state/session",
  "state/use-atom-command",
  "hooks/useSettings",
  "studio/machineNickname",
  "studio/projectWorkspace",
  "components/skills/SkillRollout",
]);

export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-skill-install-scope-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !owners.has(importer)) return;
        if (source === "@effect/atom-react") return mocks;
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
    outDir: "../../../../.artifacts/skill-install-scope/site",
    emptyOutDir: true,
  },
});
