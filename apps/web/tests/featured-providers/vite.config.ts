import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "repair-fixture-commands",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/components/settings/AcpRegistryRepair.tsx")) return;
        return code
          .replaceAll('from "../../state/server"', 'from "/repair-mocks.ts"')
          .replaceAll('from "../../state/session"', 'from "/repair-mocks.ts"')
          .replaceAll('from "../../state/use-atom-command"', 'from "/repair-mocks.ts"');
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: { outDir: "../../../../.artifacts/featured-providers/site", emptyOutDir: true },
});
