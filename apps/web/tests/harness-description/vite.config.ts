import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve, dirname } from "node:path";
const root = import.meta.dirname;
const source = resolve(root, "../../src");
const mocks = resolve(root, "mocks.tsx");
export default defineConfig({
  root,
  plugins: [
    {
      name: "isolated-picker-state",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "@effect/atom-react") return mocks;
        if (!importer) return;
        const target = id.startsWith("~/")
          ? resolve(source, id.slice(2))
          : id.startsWith(".")
            ? resolve(dirname(importer), id)
            : id;
        if (
          [resolve(source, "state/server"), resolve(source, "hooks/useSettings")].includes(
            target.replace(/\.tsx?$/, ""),
          )
        )
          return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": source } },
  build: { outDir: "../../../../.artifacts/harness-description/site", emptyOutDir: true },
});
