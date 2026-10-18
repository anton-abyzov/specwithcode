import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "skills-fixture-query",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/components/settings/ProjectSkillsSettings.tsx")) return;
        return code
          .replaceAll('from "../../state/query"', 'from "/mocks.ts"')
          .replaceAll('from "../../studio/projectWorkspace"', 'from "/mocks.ts"')
          .replaceAll('from "../studio/shell/ModelBadge"', 'from "/mocks.ts"');
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: { outDir: "../../../../.artifacts/skills-and-logos/site", emptyOutDir: true },
});
