import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
// App modules that reach a server, store or router answer from mocks.tsx instead.
const MOCKED = new Set(
  [
    "components/studio/WhatYouCanDo",
    "studio/useProjectAttention",
    "components/settings/useSettingsProjectGroups",
    "components/ProjectFavicon",
    "hooks/useSettings",
    "state/entities",
    "state/environments",
    "state/session",
    "hooks/useNewChatDestination",
    "composerDraftStore",
    "env",
    "components/WorkspacePageHeader",
    "components/ui/sidebar",
    "components/studio/CapacityFleet",
    "components/studio/shell/ModelBadge",
    "studio/useThreadIncrementProgress",
    "studio/projectPaneThreads",
    "components/ui/select",
  ].map((path) => NodePath.resolve(appSource, path)),
);
const OVERVIEW = ["components/studio/StudioOverview.tsx", "components/studio/OverviewRows.tsx"].map(
  (path) => NodePath.resolve(appSource, path),
);
function mockApp(): Plugin {
  return {
    name: "overview-1249-mocks",
    enforce: "pre",
    async resolveId(source, importer) {
      // Only Overview's own imports are redirected; the rest of the app stays real.
      if (!importer || !OVERVIEW.some((file) => importer.startsWith(file))) return null;
      if (source === "@tanstack/react-router") return mocks;
      if (!source.startsWith(".")) return null;
      const target = NodePath.resolve(importer, "..", source).replace(/\.(tsx?|js)$/, "");
      return MOCKED.has(target) ? mocks : null;
    },
  };
}
// Renders the real Overview with synthetic chats, projects and machines.
export default defineConfig({
  root: fixture,
  plugins: [mockApp(), react(), tailwindcss()],
  resolve: { alias: { "~": appSource } },
  build: { outDir: "../../../../.artifacts/overview-1249/site", emptyOutDir: true },
});
