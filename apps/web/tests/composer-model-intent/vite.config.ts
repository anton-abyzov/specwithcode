import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5857, strictPort: true },
  build: { outDir: "../../../../.artifacts/composer-model-intent", emptyOutDir: true },
});
