import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

// The waiting device's join code: floating card, sidebar row and Settings > Machines.
const environments = NodeURL.fileURLToPath(new URL("./environments.mock.tsx", import.meta.url));
const ownDeviceId = NodeURL.fileURLToPath(new URL("./ownDeviceId.mock.ts", import.meta.url));
// The settings frame pulls environment state and routing; the team-rules fixture's mocks stand in.
const settingsMocks = NodeURL.fileURLToPath(new URL("../team-rules/mocks.tsx", import.meta.url));
const owners = /settingsLayout\.tsx?$/;
const mocked =
  /(\/state\/environments|\/state\/session|\/hooks\/useSettings|\/useScopedSettings|\/SettingInheritance|\/SettingsScopeSentence|\/scopedSettings|\/projectListVisibility|\/WorkspacePageContainer|^@tanstack\/react-router)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-join-code-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer && owners.test(importer) && mocked.test(id)) return settingsMocks;
        if (importer && importer !== environments && /\/state\/environments$/.test(id))
          return environments;
        if (id.endsWith("/ownDeviceId")) return ownDeviceId;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/join-code-popup/site",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: NodeURL.fileURLToPath(new URL("./index.html", import.meta.url)),
      },
    },
  },
});
