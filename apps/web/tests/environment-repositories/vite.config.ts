import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { resolve, dirname } = NodePath;

// The real Environment page, thread repositories and composer control over fictional data: no server.
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const stubs = new Set(
  [
    "studio/projectWorkspace",
    "studio/machineNickname",
    "state/query",
    "state/vcs",
    "state/use-atom-command",
  ].map((path) => resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-environment-repositories",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || importer === mocks) return;
        if (source === "@tanstack/react-router" && importer.endsWith("ProjectEnvironment.tsx"))
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
  build: { outDir: "../../../../.artifacts/environment-repositories/site", emptyOutDir: true },
});
