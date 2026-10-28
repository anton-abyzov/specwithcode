import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-folder-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (
          /(HandoffFolderPicker|RemoteFolderBrowser)\.tsx$/.test(importer ?? "") &&
          /\/state\/(filesystem|query|projects|use-atom-command)$/.test(id)
        )
          return fileURLToPath(new URL("./mocks.ts", import.meta.url));
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/machine-folders/site",
    emptyOutDir: true,
  },
});
