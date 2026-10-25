import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const source = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));
// Synthetic threads have no host session; grant the operate scope the composer checks.
// The coordinator picker's host answers from the fixture's providers.
const stand = new Map([
  [source("../../src/state/session.ts"), source("./sessionGrant.ts")],
  [source("../../src/state/environments.ts"), source("./environments.ts")],
]);
const standIns = new Set(stand.values());
const grantSession: Plugin = {
  name: "fallback-composer-session",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (
      !importer ||
      standIns.has(importer) ||
      !/state\/(session|environments)(\.ts)?$/.test(source)
    )
      return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return (resolved && stand.get(resolved.id)) ?? null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [grantSession, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/fallback-composer/site",
    emptyOutDir: true,
  },
});
