import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
// The guide and the offer's own views over synthetic state: no server, store or provider.
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "first-feature-router",
      enforce: "pre",
      resolveId(source) {
        if (source === "@tanstack/react-router") return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/first-feature/site",
    emptyOutDir: true,
  },
});
