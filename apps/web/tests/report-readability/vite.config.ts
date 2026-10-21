import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));

// Only the host reads are swapped (link settling and file reads); the chat,
// the report reader and the viewer overlay are the app's own.
const STUBS: Record<string, Record<string, string>> = {
  "/components/chat/useExistingFileLinks.ts": {
    "@specweave-studio/client-runtime/state/runtime": here("./stubs/runtime.ts"),
    "../../state/projects": here("./stubs/projects.ts"),
  },
  "/components/chat/ViewerLinkedPane.tsx": {
    "../files/projectFilesQueryState": here("./stubs/projectFilesQueryState.ts"),
  },
  "/components/chat/MarkdownDocumentReader.tsx": {
    "../files/projectFilesQueryState": here("./stubs/projectFilesQueryState.ts"),
  },
};

export default defineConfig({
  root: here("."),
  plugins: [
    {
      name: "report-readability-stubs",
      enforce: "pre",
      resolveId(source, importer) {
        for (const [suffix, stubs] of Object.entries(STUBS)) {
          if (importer?.endsWith(suffix) && stubs[source]) return stubs[source];
        }
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": here("../../src") } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/report-readability/site",
    emptyOutDir: true,
  },
});
