import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: here("."),
  plugins: [
    {
      // No host: the thread's media server is replaced by the fixture's media route.
      name: "viewer-video-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        const fromViewer =
          importer?.endsWith("/chat/ThreadArtifacts.tsx") ||
          importer?.endsWith("/chat/ExpandedImageDialog.tsx");
        if (fromViewer && source.endsWith("/assets/assetUrls")) return here("./stubs.ts");
        if (
          (importer?.endsWith("/ViewerLinkedPane.tsx") ||
            importer?.endsWith("/ViewerOverlayHost.tsx")) &&
          source.endsWith("/files/projectFilesQueryState")
        ) {
          return here("./stubs.ts");
        }
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": here("../../src") } },
  build: {
    target: "esnext",
    outDir: process.env.VIEWER_VIDEO_SITE ?? "../../../../.artifacts/viewer-video/site",
    emptyOutDir: true,
  },
});
