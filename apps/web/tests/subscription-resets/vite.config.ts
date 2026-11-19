import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// The real Subscriptions rows and reset report over fictional accounts: no server, no accounts.
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": NodePath.resolve(fixture, "../../src") } },
  build: { outDir: "../../../../.artifacts/subscription-resets/site", emptyOutDir: true },
});
