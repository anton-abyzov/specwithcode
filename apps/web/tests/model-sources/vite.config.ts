import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

// The real Sources card and track-row note over fictional providers. Settings
// writes, navigation, permissions and Team rules come from mocks.ts.
const MOCKED =
  /^(\.\.\/\.\.\/(hooks\/useSettings|state\/session|teamRules\/useTeamRules)|@tanstack\/react-router)$/;

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-model-sources-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (/ModelSourcesCard\.tsx$/.test(importer ?? "") && MOCKED.test(id))
          return NodeURL.fileURLToPath(new URL("./mocks.ts", import.meta.url));
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/model-sources/site",
    emptyOutDir: true,
  },
});
