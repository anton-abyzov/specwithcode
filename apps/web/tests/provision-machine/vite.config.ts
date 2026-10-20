import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-provision-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (
          importer?.endsWith("ProvisionMachineSheet.tsx") &&
          (id === "@effect/atom-react" ||
            /\/state\/(server|session|use-atom-command)$/.test(id) ||
            /\/studio\/machineProvision$/.test(id))
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
    outDir: "../../../../.artifacts/provision-machine/site",
    emptyOutDir: true,
  },
});
