import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const { fileURLToPath } = NodeURL;

// The real StudioSidebar, Run on menu, assistant rules and machine names; only
// data, routing, settings and RPC hooks are simulated.
const SIDEBAR_MOCKED =
  /\/(state\/(entities|environments|projects|server|session|threads|use-atom-command|use-orchestration-command)|hooks\/(useSettings|useScratchProject|useThreadActions)|lib\/chatThreadActions|threadRoutes|settings\/useSettingsProjectGroups|sidebar\/(SidebarPlanProgress|SidebarChrome)|ProjectFavicon|shell\/ModelBadge)$/;
const PICKER_OWNERS = /(DraftMachinePicker|RenameMachineDialog)\.tsx$/;
const PICKER_MOCKED =
  /(\/hooks\/useProjectCoordinatorHandoff|\/studio\/useRenameMachine|\/AddToMachineDialog|\/studio\/ProjectLinkDialog|\/connection\/catalog|\/connection\/desktopLocal|\/state\/use-atom-command|\/state\/environments|\/state\/entities|\/state\/session|\/hooks\/useSettings|\/logicalProject|\/hooks\/useScratchProject|\/lib\/machineLastSeen)$/;
const mocks = fileURLToPath(new URL("./mocks.tsx", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-aide-per-machine-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer || importer === mocks || !importer.includes("/apps/web/")) return null;
        if (id === "@effect/atom-react" || id === "@tanstack/react-router") return mocks;
        if (PICKER_OWNERS.test(importer) && PICKER_MOCKED.test(id)) return mocks;
        if (id.startsWith(".") && SIDEBAR_MOCKED.test(id)) return mocks;
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/aide-per-machine/site",
    emptyOutDir: true,
  },
});
