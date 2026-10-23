import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";
const here = (p: string) => NodeURL.fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here("."),
  plugins: [
    {
      name: "live-preview-isolation",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          importer?.endsWith("/serverPictureInPicture.ts") &&
          source === "@specweave-studio/client-runtime/preview/server-browser-stream"
        )
          return here("./stream.ts");
        if (importer?.endsWith("/serverPictureInPicture.ts") && source === "~/state/previewStream")
          return here("./access.ts");
      },
    },
  ],
  resolve: {
    alias: [
      { find: "~/components/ui/toast", replacement: here("./toast.ts") },
      { find: "~/state/previewStream", replacement: here("./access.ts") },
      { find: "~", replacement: here("../../src") },
    ],
  },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/browser-live/site",
    emptyOutDir: true,
  },
});
