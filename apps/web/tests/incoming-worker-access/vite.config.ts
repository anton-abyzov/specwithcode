import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
const stubs = new Set(
  [
    "state/environments",
    "state/session",
    "state/relay",
    "state/use-atom-command",
    "connection/catalog",
    "studio/machineNickname",
    "studio/fleet",
    "cloud/publicConfig",
    "cloud/primaryCloudLinkState",
    "components/clerk/useStudioConnectAuthPrompt",
    "components/settings/settingsLayout",
    "env",
    "confirmDialog",
  ].map((path) => NodePath.resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-incoming-worker-access",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "@clerk/react") return mocks;
        if (!importer) return;
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
    outDir: "../../../../.artifacts/incoming-worker-access/site",
    emptyOutDir: true,
  },
});
