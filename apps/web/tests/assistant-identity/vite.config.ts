import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
// Everything that would reach a server reads these stand-ins.
const stubs = new Set(
  ["state/server", "state/use-atom-command"].map((path) => NodePath.resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-assistant-identity",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || importer === mocks) return;
        const target = source.startsWith("~/")
          ? NodePath.resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? NodePath.resolve(NodePath.dirname(importer), source)
            : source;
        if (stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/assistant-identity/site",
    emptyOutDir: true,
  },
});
