import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
// Renders Usage > Machines over synthetic reports, or over a data file passed as ?data=.
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": appSource } },
  build: { outDir: "../../../../.artifacts/usage-machine-share/site", emptyOutDir: true },
});
