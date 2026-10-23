import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: here("."),
  plugins: [
    {
      name: "phone-setup-isolation",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.endsWith("/PairPhoneSettings.tsx") && source === "./settingsLayout")
          return here("./layout.tsx");
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      { find: "~/environments/primary", replacement: here("./primary.ts") },
      { find: "~", replacement: here("../../src") },
    ],
  },
  build: { target: "esnext", outDir: "../../../../.artifacts/phone-setup/site", emptyOutDir: true },
});
