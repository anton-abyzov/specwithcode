import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// Rows, locks and the composer notice are real; only environment state and routing are not.
const owners = /(settingsLayout|useTeamRules)\.tsx?$/;
const mocked =
  /(\/state\/environments|\/state\/session|\/hooks\/useSettings|\/useScopedSettings|\/SettingInheritance|\/SettingsScopeSentence|\/scopedSettings|\/projectListVisibility|\/WorkspacePageContainer|^@tanstack\/react-router)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-team-rules-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer && owners.test(importer) && mocked.test(id)) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/team-rules/site",
    emptyOutDir: true,
  },
});
