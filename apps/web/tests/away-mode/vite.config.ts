import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
// The real Away dialog, session summary and wake card, with their data modules
// replaced: no server, no session, no router.
const stubs = new Set(
  [
    "studio/handoffMode",
    "studio/machineNickname",
    "studio/fleet",
    "state/entities",
    "state/environments",
    "state/session",
    "connection/runtime",
    "rpc/atomRegistry",
    "components/away/awayRpc",
    "components/handoff/useHandoffDestinations",
  ].map((path) => NodePath.resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-away-state",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || importer === mocks) return;
        const target = source.startsWith("~/")
          ? NodePath.resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? NodePath.resolve(NodePath.dirname(importer), source)
            : null;
        if (target && stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: { outDir: "../../../../.artifacts/away-mode/site", emptyOutDir: true },
});
