import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// The DiffPanel is real; only its stores, RPC queries and editor bridge are not.
const panelOwner = /\/components\/DiffPanel\.tsx$/;
const panelMocked =
  /(\/state\/(entities|filesystem|query|use-atom-command|server|review|vcs)|\/editorPreferences|\/fileContextMenu|\/studio\/machineNickname|^@effect\/atom-react)$/;
// The timeline reads the thread shell; the inspector and the checkpoint diff hook read RPC queries.
const timelineOwner = /\/components\/chat\/MessagesTimeline\.tsx$/;
const queryOwners = /(\/components\/chat\/V2ItemInspector\.tsx|\/lib\/checkpointDiffState\.ts)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-activity-diffs-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer) return;
        if (panelOwner.test(importer) && panelMocked.test(id)) return mocks;
        if (
          (timelineOwner.test(importer) || /\/components\/chat\/ChatHeader\.tsx$/.test(importer)) &&
          /\/state\/entities$/.test(id)
        )
          return mocks;
        if (
          /\/components\/chat\/TimelineDetailMenu\.tsx$/.test(importer) &&
          /\/settings\/(SettingsScopeContext|useSettingsProjectGroups|useScopedSettings)$/.test(id)
        )
          return mocks;
        if (queryOwners.test(importer) && /\/state\/queries$/.test(id)) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/activity-diffs/site",
    emptyOutDir: true,
  },
});
