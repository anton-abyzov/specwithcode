import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const app = (path: string) => NodeURL.fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
const here = (path: string) => NodeURL.fileURLToPath(new URL(`./${path}`, import.meta.url));
const composer = (path: string) =>
  NodeURL.fileURLToPath(new URL(`../composer-host-status/${path}`, import.meta.url));
// The switcher and the message box alone: commands, machine colors, the fleet and uploads
// are fixture stand-ins (the message box's are the composer fixture's own).
const stubs = new Map([
  [app("state/use-atom-command.ts"), here("commands.ts")],
  [app("studio/machineIdentity.ts"), here("machineIdentity.ts")],
  [app("state/use-orchestration-command.ts"), composer("commands.ts")],
  [app("lib/attachmentUploadQueue.ts"), composer("uploads.ts")],
  [app("state/environments.ts"), composer("environments.ts")],
  [app("lib/machineLastSeen.ts"), composer("machineLastSeen.ts")],
]);
const fixtureHost: Plugin = {
  name: "coordinator-menu-host",
  enforce: "pre",
  async resolveId(source, importer, options) {
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
