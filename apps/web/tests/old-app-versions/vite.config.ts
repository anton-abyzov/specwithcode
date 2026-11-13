import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
// Renders the low disk card before and after old app versions got their own line.
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": appSource } },
  build: { outDir: "../../../../.artifacts/old-app-versions/site", emptyOutDir: true },
});
