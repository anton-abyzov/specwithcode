import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
const mocks = fileURLToPath(new URL("./mocks.ts", import.meta.url));
const stubbed =
  /(\/state\/(query|use-atom-command|entities|projects|threads)|\/rpc\/atomRegistry|\/studio\/projectWorkspace|\/studio\/useThreadIncrementProgress|\/localApi)$/;
// Plan card criteria, the paged increment picker and the folder check, with synthetic data only.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-increment-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (
          (importer?.endsWith("LinkIncrementDialog.tsx") ||
            importer?.endsWith("ProjectFolderChange.tsx")) &&
          stubbed.test(id)
        )
          return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/increment-traceability/site",
    emptyOutDir: true,
  },
});
