import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const { fileURLToPath } = NodeURL;

// The real StudioSidebar and its sort; only data, routing and settings hooks are simulated.
const MOCKED =
  /\/(state\/(entities|environments|projects|server|session|threads|use-atom-command|use-orchestration-command)|hooks\/(useSettings|useScratchProject|useThreadActions)|lib\/chatThreadActions|threadRoutes|settings\/useSettingsProjectGroups|sidebar\/(SidebarPlanProgress|SidebarChrome)|ProjectFavicon|shell\/ModelBadge|ThreadMoveDialog)$/;
const mocks = fileURLToPath(new URL("./mocks.tsx", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-sidebar-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer || importer === mocks || !importer.includes("/apps/web/")) return null;
        if (id === "@effect/atom-react" || id === "@tanstack/react-router") return mocks;
        if (id.startsWith(".") && MOCKED.test(id)) return mocks;
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/sidebar-stable-order/site",
    emptyOutDir: true,
  },
});
