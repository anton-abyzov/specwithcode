import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { excalidrawAssetsPlugin } from "../../vite/excalidrawAssets";

const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");

// The whiteboard view and its Excalidraw frame as shipped, with an in-memory
// file standing in for the project folder. Fonts come from the same plugin the
// app build uses, so the fixture proves the editor draws with no network.
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwindcss(), excalidrawAssetsPlugin(NodePath.resolve(fixture, "../.."))],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/office-whiteboard/site",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: NodePath.join(fixture, "index.html"),
        whiteboard: NodePath.join(fixture, "whiteboard.html"),
      },
    },
  },
});
