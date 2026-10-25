import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwindcss()],
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/output-highlighting/site",
    emptyOutDir: true,
  },
});
