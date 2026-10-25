import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
// AGENT_MESSAGES_SITE builds a second copy, for example of the code before a change.
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    outDir: process.env.AGENT_MESSAGES_SITE ?? "../../../../.artifacts/agent-messages/site",
    emptyOutDir: true,
  },
});
