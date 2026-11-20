import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const app = (path: string) => NodeURL.fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
const here = (path: string) => NodeURL.fileURLToPath(new URL(`./${path}`, import.meta.url));
const composer = (path: string) =>
  NodeURL.fileURLToPath(new URL(`../composer-host-status/${path}`, import.meta.url));
// The window, the coordinator and its messages alone (1427): commands, machine names and
// colours, the fleet and uploads are fixture stand-ins.
const stubs = new Map([
  [app("state/use-atom-command.ts"), here("commands.ts")],
  [app("studio/machineIdentity.ts"), here("machineIdentity.ts")],
  [app("studio/machineNickname.ts"), here("machineNickname.ts")],
  [app("state/environments.ts"), here("environments.ts")],
  [app("components/studio/useLinkMachines.ts"), here("linkMachines.ts")],
  [app("state/use-orchestration-command.ts"), composer("commands.ts")],
  [app("lib/attachmentUploadQueue.ts"), composer("uploads.ts")],
  [app("lib/machineLastSeen.ts"), composer("machineLastSeen.ts")],
]);
const fixtureHost: Plugin = {
  name: "coordinator-menu-host",
  enforce: "pre",
  async resolveId(source, importer, options) {
    // A stand-in imports the module it stands in for.
    if (!importer || [...stubs.values()].includes(importer)) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved ? (stubs.get(resolved.id) ?? null) : null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [fixtureHost, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/coordinator-menu/site",
    emptyOutDir: true,
  },
});
