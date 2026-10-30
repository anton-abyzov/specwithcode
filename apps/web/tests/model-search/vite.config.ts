import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { resolve, dirname } = NodePath;

// The real model picker searching one model across many providers. Fictional data.
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
const mocks = resolve(fixture, "../picker-usage/mocks.tsx");
const stubs = new Set(
  [
    "hooks/useSettings",
    "state/server",
    "state/presentation",
    "components/chat/ChatGptSharingControl",
  ].map((path) => resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-model-search",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return;
        const target = source.startsWith("~/")
          ? resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? resolve(dirname(importer), source)
            : source.startsWith("/")
              ? source
              : null;
        if (target && stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: { outDir: "../../../../.artifacts/model-search/site", emptyOutDir: true },
});
