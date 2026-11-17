import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const app = (path: string) => NodeURL.fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
const stub = NodeURL.fileURLToPath(new URL("./stubs.ts", import.meta.url));
// The real dialog and its list: only what it reads from the app (projects, machines,
// commands, the scratch folder and replaced machine records) is a fixture stand-in.
const stubbed = new Set([
  app("state/use-atom-command.ts"),
  app("state/entities.ts"),
  app("hooks/useScratchProject.ts"),
  app("components/studio/useLinkMachines.ts"),
  app("components/settings/useReplacedMachineRecords.ts"),
]);
// Only the dialog's own two files get the stand-ins; the rest of the app keeps its modules.
const owners = new Set([
  app("components/studio/ProjectLinkDialog.tsx"),
  app("components/studio/ProjectLinkCandidates.tsx"),
]);
const fixtureHost: Plugin = {
  name: "link-dialog-host",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!importer || !owners.has(importer)) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved && stubbed.has(resolved.id) ? stub : null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [fixtureHost, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/link-dialog/site",
    emptyOutDir: true,
  },
});
