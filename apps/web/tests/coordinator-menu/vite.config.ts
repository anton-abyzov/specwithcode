import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const app = (path: string) => NodeURL.fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
const here = (path: string) => NodeURL.fileURLToPath(new URL(`./${path}`, import.meta.url));
// The switcher alone: commands and machine colors are fixture stand-ins.
const stubs = new Map([
  [app("state/use-atom-command.ts"), here("commands.ts")],
  [app("studio/machineIdentity.ts"), here("machineIdentity.ts")],
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
