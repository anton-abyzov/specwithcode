import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// The Model row, its pickers and the settings layout are real; machine state and routing are not.
const owners = /(settingsLayout|ProjectDefaultsSettings)\.tsx?$/;
const mocked =
  /(\/state\/environments|\/state\/session|\/hooks\/useSettings|\/useScopedSettings|\/SettingsScopeContext|\/SettingInheritance|\/SettingsScopeSentence|\/scopedSettings|\/projectListVisibility|\/WorkspacePageContainer|\/useNamedEnvironments|\/useFolderTeamRules|\/useProjectFolderHealth|\/useSettingsProjectGroups|\/browserDefaults|\/ProviderLimitSettings|\/ModelLanesSettings|\/TaskRoutingSettings|\/ComputerUsePermissions|\/AccessGrantsList|^@tanstack\/react-router)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-default-model-fixture",
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
    outDir: "../../../../.artifacts/default-model/site",
    emptyOutDir: true,
  },
});
