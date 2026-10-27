import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));

// The viewer's host reads (the deck preview RPC, server capabilities, the
// file menu, text reads) answer from fixture data. Only these components'
// own imports are swapped, so the overlay and the slides renderer are the app's.
const SRC = here("../../src/");
const STUBBED_IMPORTERS = [
  "/components/files/DeckPreview.tsx",
  "/components/chat/ViewerFileActions.tsx",
  "/components/studio/shell/LibraryFileViewer.tsx",
];
const STUBS: Record<string, string> = {
  "~/fileContextMenu": here("./stubs/fileContextMenu.ts"),
  "~/editorPreferences": here("./stubs/editorPreferences.ts"),
  "~/state/entities": here("./stubs/entities.ts"),
  "~/state/query": here("./stubs/query.ts"),
  "~/studio/design": here("./stubs/design.ts"),
  "../../files/projectFilesQueryState": here("../viewer-links/stubs/projectFilesQueryState.ts"),
  "../../ChatMarkdown": here("./stubs/ChatMarkdown.tsx"),
};

export default defineConfig({
  root: here("."),
  plugins: [
    {
      name: "deck-preview-stubs",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !STUBBED_IMPORTERS.some((end) => importer.endsWith(end))) return null;
        // The `~` alias is applied before plugins see the import.
        const key = source.startsWith(SRC) ? `~/${source.slice(SRC.length)}` : source;
        return STUBS[key] ?? null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": here("../../src") } },
  build: { outDir: "../../../../.artifacts/deck-preview/site", emptyOutDir: true },
});
