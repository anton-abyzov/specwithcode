import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-add-folder-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (
          /(AddFolderPanel|FolderBrowser)\.tsx$/.test(importer ?? "") &&
          // Only the app's own state modules, not the client-runtime package of the same name.
          /^(\.\.\/)+state\/(filesystem|query|use-atom-command)$/.test(id)
        )
          return NodeURL.fileURLToPath(new URL("./mocks.ts", import.meta.url));
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/add-folder/site",
    emptyOutDir: true,
  },
});
