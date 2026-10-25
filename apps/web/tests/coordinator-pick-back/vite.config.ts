import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const stubs = new Set(
  [
    "hooks/useSettings",
    "state/environments",
    "state/server",
    "state/session",
    "state/use-atom-command",
    "components/chat/TraitsPicker",
    "components/studio/shell/ModelBadge",
    "components/chat/ChatGptSharingControl",
  ].map((path) => resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-coordinator-pick-back",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "@tanstack/react-router") return mocks;
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
  build: { outDir: "../../../../.artifacts/coordinator-pick-back/site", emptyOutDir: true },
});
