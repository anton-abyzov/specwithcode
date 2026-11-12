import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL(".", import.meta.url));
const src = resolve(fixture, "../../src");
const stubs = new Set(
  [
    "studio/machineIdentity",
    "studio/machineNickname",
    "hooks/useNowMinute",
    "lib/machineLastSeen",
    "state/use-atom-command",
    "studio/projectLink",
    "studio/shellModel",
    "studio/awayRequest",
    "components/handoff/HandOffMachineDialog",
    "components/ui/toast",
    "components/studio/VoiceCall",
    "components/studio/VoiceSettings",
  ].map((p) => resolve(src, p)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "fixture-only",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return;
        const target = source.startsWith("~/")
          ? resolve(src, source.slice(2))
          : source.startsWith(".")
            ? resolve(dirname(importer), source)
            : source;
        if (stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return resolve(fixture, "mocks.tsx");
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": src } },
  build: { outDir: "../../../../.artifacts/composer-controls/site", emptyOutDir: true },
});
