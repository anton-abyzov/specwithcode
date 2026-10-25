import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// Only the chip's provider catalogue and detail store are mocked. The subagent
// verdict, the row status words, the groups and the components are real.
const owners = /SubagentsChip\.tsx$/;
const mocked = /(\/state\/entities|\/ModelBadge)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-subagent-continuity-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer && owners.test(importer) && mocked.test(id)) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/subagent-handoff-continuity/site",
    emptyOutDir: true,
  },
});
