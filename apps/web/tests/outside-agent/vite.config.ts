import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const app = path.resolve(root, "../../src");
const virtual = path.join(root, "machine-row.virtual.tsx");
const isolated = new Set([
  "@effect/atom-react",
  "../../state/server",
  "../../state/session",
  "../../state/use-atom-command",
  "../../studio/machineHandoff",
  "../../studio/useCoordinatorProvider",
  "./GitHubCredentialCard",
  "./ProviderAuthenticationSection",
  "@specweave-studio/client-runtime/state/runtime",
]);
export default defineConfig({
  root,
  plugins: [
    {
      name: "outside-agent-isolated-state",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "virtual:outside-agent-machine-row") return virtual;
        if (importer?.endsWith("/MachineReadinessChecklist.tsx") && isolated.has(source))
          return path.join(root, "mocks.tsx");
      },
      load(id) {
        if (id !== virtual) return;
        const source = fs.readFileSync(
          path.join(app, "components/settings/ConnectionsSettings.tsx"),
          "utf8",
        );
        const start = source.indexOf("type SavedBackendListRowProps =");
        const end = source.indexOf("function CloudLinkSwitch(", start);
        if (start < 0 || end < 0)
          throw new Error("Saved machine row moved; update fixture boundaries");
        return (
          fs.readFileSync(path.join(root, "row-prelude.tsx"), "utf8") +
          "\n" +
          source.slice(start, end) +
          "\nexport { SavedBackendListRow };"
        );
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": app } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/outside-agent/site",
    emptyOutDir: true,
  },
});
