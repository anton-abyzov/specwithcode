import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

// The settings frame pulls environment state and routing; the team-rules fixture's mocks stand in.
const mocks = NodeURL.fileURLToPath(new URL("../team-rules/mocks.tsx", import.meta.url));
const owners = /settingsLayout\.tsx?$/;
const mocked =
  /(\/state\/environments|\/state\/session|\/hooks\/useSettings|\/useScopedSettings|\/SettingInheritance|\/SettingsScopeSentence|\/scopedSettings|\/projectListVisibility|\/WorkspacePageContainer|^@tanstack\/react-router)$/;
// Renders the device approval pop-up, the waiting card and the device list (1327).
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-device-approval-fixture",
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
    outDir: "../../../../.artifacts/device-approval/site",
    emptyOutDir: true,
  },
});
