import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { resolve, dirname } = NodePath;

// The real pooled Limits view over fictional accounts: no server, no sign-ins.
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
const mocks = resolve(fixture, "mocks.tsx");
const stubs = new Set(
  [
    "hooks/useSettings",
    "state/server",
    "state/presentation",
    "state/session",
    "state/use-atom-command",
    "localApi",
    "components/usage/usageLimitHistoryState",
    "components/studio/shell/HostLimits",
  ].map((path) => resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-usage-limits",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return;
        if (source === "@tanstack/react-router" && !importer.includes("node_modules")) return mocks;
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
  build: { outDir: "../../../../.artifacts/usage-limits/site", emptyOutDir: true },
});
