import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.ts");
const owner = NodePath.resolve(appSource, "components/usage/CursorUsageEnable.tsx");
const stubbed = new Set(
  ["state/server", "state/use-atom-command"].map((path) => NodePath.resolve(appSource, path)),
);

// The Usage page's Cursor enable card and its warning render as shipped; only
// the settings command they call is swapped, and only for that importer.
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-cursor-usage-warning-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer !== owner || !source.startsWith(".")) return;
        const target = NodePath.resolve(NodePath.dirname(importer), source);
        if (stubbed.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/cursor-usage-warning/site",
    emptyOutDir: true,
  },
});
