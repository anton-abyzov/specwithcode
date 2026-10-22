import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const { fileURLToPath } = NodeURL;

// The real gallery view, dialogs, thumbnails and Library pane. Only data,
// routing and permission hooks are simulated, with synthetic designs.
const MOCKED =
  /(?:^|\/)(state\/(query|use-atom-command|session)|studio\/(design|projectWorkspace)|files\/useDirectoryEntries|browser\/useOpenLink|LibraryFileViewer)$/;
const mocks = fileURLToPath(new URL("./mocks.tsx", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "design-workspace-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer || importer === mocks || !importer.includes("/apps/web/")) return null;
        if (id === "@tanstack/react-router") return mocks;
        if ((id.startsWith(".") || id.startsWith("~/")) && MOCKED.test(id)) return mocks;
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/design-workspace/site",
    emptyOutDir: true,
  },
});
