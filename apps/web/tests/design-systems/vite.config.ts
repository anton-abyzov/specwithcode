import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const { fileURLToPath } = NodeURL;

// The real design-system views, review, flows and picker with synthetic data.
// They take data and callbacks as props; only the router is simulated.
const mocks = fileURLToPath(new URL("./mocks.tsx", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "design-systems-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer || importer === mocks || !importer.includes("/apps/web/")) return null;
        return id === "@tanstack/react-router" ? mocks : null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/design-systems/site",
    emptyOutDir: true,
  },
});
