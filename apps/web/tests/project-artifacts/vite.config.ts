import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { resolve, dirname } = NodePath;

// The real artifacts shelf and Library Artifacts view over fictional artifacts: no server.
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const stubs = new Set(
  [
    "assets/assetUrls",
    "browser/useOpenLink",
    "components/studio/shell/LibraryFileViewer",
    "components/files/projectFilesQueryState",
  ].map((path) => resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-project-artifacts",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return;
        if (source === "@tanstack/react-router" && importer.endsWith("ProjectArtifactShelf.tsx"))
          return mocks;
        const target = source.startsWith("~/")
          ? resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? resolve(dirname(importer), source)
            : null;
        if (target && stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: { outDir: "../../../../.artifacts/project-artifacts/site", emptyOutDir: true },
});
