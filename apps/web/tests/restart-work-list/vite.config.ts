import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// The list's thread shells and machine names come from the fixture, not the app's atoms.
const fixtureState = {
  name: "restart-work-list-mocks",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (!importer?.includes("RestartRunningWorkList")) return null;
    return source.endsWith("/state/entities") || source.endsWith("/studio/machineNickname")
      ? mocks
      : null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [fixtureState, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/restart-work-list/site",
    emptyOutDir: true,
  },
});
