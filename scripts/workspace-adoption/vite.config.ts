import { defineConfig } from "vite-plus";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const web = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { default: react } = await import(pathToFileURL(web.resolve("@vitejs/plugin-react")).href);
const { default: tailwindcss } = await import(pathToFileURL(web.resolve("@tailwindcss/vite")).href);
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^react-dom(\/.*)?$/,
        replacement: fileURLToPath(
          new URL("../../apps/web/node_modules/react-dom$1", import.meta.url),
        ),
      },
      {
        find: /^react(\/.*)?$/,
        replacement: fileURLToPath(new URL("../../apps/web/node_modules/react$1", import.meta.url)),
      },
    ],
  },
  build: { outDir: "../../.artifacts/workspace-adoption/site", emptyOutDir: true },
});
