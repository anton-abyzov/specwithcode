import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));

// The pane's two data sources read from a host; here they read fixture data.
// Only the pane's own imports are swapped, so the rest of the app is unchanged.
const STUBS: Record<string, string> = {
  "../files/projectFilesQueryState": here("./stubs/projectFilesQueryState.ts"),
  "../pullRequest/PullRequestDetailPanel": here("./stubs/PullRequestDetailPanel.tsx"),
};

export default defineConfig({
  root: here("."),
  plugins: [
    {
      name: "viewer-links-stubs",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.endsWith("/components/chat/ViewerLinkedPane.tsx") && STUBS[source]) {
          return STUBS[source];
        }
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": here("../../src") } },
  build: { outDir: "../../../../.artifacts/viewer-links/site", emptyOutDir: true },
});
