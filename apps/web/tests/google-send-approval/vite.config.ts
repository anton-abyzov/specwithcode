import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const local = (name: string) => NodeURL.fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  root: local("."),
  plugins: [
    {
      name: "google-approval-offline-state",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/components/settings/GoogleAccountSettings.tsx")) return;
        return code
          .replace(
            /from "(?:\.\.\/\.\.\/(?:state\/(?:entities|environments|query|server|session|use-atom-command)|hooks\/useSettings))"/gu,
            `from "${local("./mocks.tsx")}"`,
          )
          .replace('from "./settingsLayout"', `from "${local("./mocks.tsx")}"`);
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": local("../../src") } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/google-send-approval/site",
    emptyOutDir: true,
  },
});
