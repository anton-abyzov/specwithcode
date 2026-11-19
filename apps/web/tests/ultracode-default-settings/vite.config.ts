import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// The Agents page, its rows and the settings layout are real; machine state and routing are not.
const owners = /(settingsLayout|AgentInstructionsSettings)\.tsx?$/;
const mocked =
  /(\/state\/environments|\/hooks\/useSettings|\/state\/session|\/useScopedSettings|\/SettingsScopeContext|\/SettingInheritance|\/SettingsScopeSentence|\/scopedSettings|\/projectListVisibility|\/WorkspacePageContainer|^@tanstack\/react-router)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-ultracode-default-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer || importer === mocks) return;
        // No router runs here, so every link and navigation is a stand-in.
        if (id === "@tanstack/react-router" || (owners.test(importer) && mocked.test(id)))
          return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/ultracode-default-settings/site",
    emptyOutDir: true,
  },
});
