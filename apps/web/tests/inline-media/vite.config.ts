import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: here("."),
  plugins: [
    {
      // No host: the message's own server is replaced by the fixture's media route.
      name: "inline-media-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        const fromMarkdown = importer?.endsWith("/components/ChatMarkdown.tsx");
        const fromViewer = importer?.endsWith("/chat/ExpandedImageDialog.tsx");
        if ((fromMarkdown || fromViewer) && source.endsWith("/assets/assetUrls")) {
          return here("./stubs.ts");
        }
        if (fromMarkdown && source.endsWith("/state/use-atom-query-runner")) {
          return here("./stubs.ts");
        }
        if (fromMarkdown && source.endsWith("/state/session")) return here("./session.ts");
        // The viewer's thread pane reads project files; the fixture has none.
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
    outDir: process.env.INLINE_MEDIA_SITE ?? "../../../../.artifacts/inline-media/site",
    emptyOutDir: true,
  },
});
