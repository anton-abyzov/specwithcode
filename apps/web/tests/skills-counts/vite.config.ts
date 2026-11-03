import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "skills-fixture",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/chat/ComposerSkillsPopover.tsx")) return;
        return code
          .replaceAll('from "../../state/query"', 'from "/mocks.ts"')
          .replaceAll('from "../../studio/projectWorkspace"', 'from "/mocks.ts"')
          .replaceAll('from "../../state/server"', 'from "/mocks.ts"')
          .replaceAll('from "../../state/use-atom-command"', 'from "/mocks.ts"')
          .replaceAll('from "../settings/useSettingsProjectGroups"', 'from "/mocks.ts"');
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: { outDir: "../../../../.artifacts/skills-counts/site", emptyOutDir: true },
});
