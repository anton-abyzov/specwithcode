import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const app = (path: string) => NodeURL.fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
const menu = (path: string) =>
  NodeURL.fileURLToPath(new URL(`../coordinator-menu/${path}`, import.meta.url));
const composer = (path: string) =>
  NodeURL.fileURLToPath(new URL(`../composer-host-status/${path}`, import.meta.url));

// The stand-ins of the coordinator-menu fixture: no server, no fleet. The Sync dialog needs
// none of its own, because the page passes it a scripted API.
const stubs = new Map([
  [app("state/use-atom-command.ts"), menu("commands.ts")],
  [app("studio/machineIdentity.ts"), menu("machineIdentity.ts")],
  [app("state/use-orchestration-command.ts"), composer("commands.ts")],
  [app("state/environments.ts"), composer("environments.ts")],
  [app("lib/machineLastSeen.ts"), composer("machineLastSeen.ts")],
]);

const fixtureHost: Plugin = {
  name: "project-sync-host",
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
    outDir: "../../../../.artifacts/project-sync/site",
    emptyOutDir: true,
  },
});
