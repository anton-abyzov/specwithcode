import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const fixture = dirname(fileURLToPath(import.meta.url));
const source = resolve(fixture, "../../src");
export default defineConfig({
  root: fixture,
  cacheDir: resolve(fixture, "../../../../.artifacts/active-project-pickers/vite-cache"),
  plugins: [
    {
      name: "synthetic-project-icons",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer) return;
        const target = id.startsWith("~/")
          ? resolve(source, id.slice(2))
          : id.startsWith(".")
            ? resolve(dirname(importer), id)
            : id;
        if (target.replace(/\.tsx?$/, "") === resolve(source, "state/assets"))
          return resolve(fixture, "mocks.ts");
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": source } },
  server: {
    host: "127.0.0.1",
    port: 5873,
    strictPort: true,
    fs: { allow: [resolve(fixture, "../../../..")] },
  },
});
