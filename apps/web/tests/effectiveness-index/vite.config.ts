import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");

// The ring panel's "Used before reset" summary as shipped, over fictional
// periods and live windows; it reads no store, so nothing is swapped.
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/effectiveness-index/site",
    emptyOutDir: true,
  },
});
