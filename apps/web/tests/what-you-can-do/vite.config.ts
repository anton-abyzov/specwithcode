import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const MOCKED =
  /^@tanstack\/react-router$|^@effect\/atom-react$|\/hooks\/useSettings$|\/state\/(environments|query|server)$/;

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-checklist-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer?.endsWith("WhatYouCanDo.tsx") && MOCKED.test(id))
          return NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
});
