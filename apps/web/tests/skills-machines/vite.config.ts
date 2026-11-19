import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

// Each listed file reads these modules from the fixture's mocks instead of live state.
const SWAPS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "/components/settings/ProjectSkillsSettings.tsx": [
    "@tanstack/react-router",
    "../../state/query",
    "../../state/environments",
    "../../state/session",
    "../../studio/projectWorkspace",
    "../../studio/machineNickname",
    "../studio/shell/ModelBadge",
  ],
  "/components/skills/SkillMachineMatrix.tsx": [
    "../../state/environments",
    "../../studio/fleet",
    "../../studio/machineNickname",
  ],
  "/components/skills/skillMachineReads.ts": [
    "../../state/environments",
    "../../state/query",
    "../../studio/projectWorkspace",
  ],
  "/components/settings/SettingsScopeSentence.tsx": [
    "@tanstack/react-router",
    "./SettingsScopeContext",
    "./useNamedEnvironments",
    "../../state/entities",
    "../../state/environments",
  ],
};
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "skills-machines-fixture",
      enforce: "pre",
      transform(code, id) {
        const swaps = Object.entries(SWAPS).find(([file]) => id.endsWith(file))?.[1];
        if (!swaps) return;
        return swaps.reduce(
          (next, source) => next.replaceAll(`from "${source}"`, 'from "/mocks.tsx"'),
          code,
        );
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: { outDir: "../../../../.artifacts/skills-machines/site", emptyOutDir: true },
});
