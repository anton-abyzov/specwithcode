import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const realSession = NodeURL.fileURLToPath(new URL("../../src/state/session.ts", import.meta.url));
const grant = NodeURL.fileURLToPath(new URL("./sessionGrant.ts", import.meta.url));

// Synthetic threads have no host session; grant the operate scope the composer checks.
const grantSession: Plugin = {
  name: "fallback-composer-session",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!importer || importer === grant || !/state\/session(\.ts)?$/.test(source)) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved?.id === realSession ? grant : null;
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
