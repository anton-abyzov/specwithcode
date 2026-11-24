// @effect-diagnostics nodeBuiltinImport:off -- A build plugin copies font files with node:fs.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { Plugin } from "vite-plus";

/** Where the whiteboard frame looks for Excalidraw's fonts (window.EXCALIDRAW_ASSET_PATH). */
export const EXCALIDRAW_ASSETS_DIR = "excalidraw-assets";

const MIME: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

/**
 * The whiteboard frame's own policy: scripts, fonts and data from the app only,
 * images only from the app or data URLs, no frames, no network elsewhere. It
 * holds on top of whatever the page is served with.
 */
export const WHITEBOARD_FRAME_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Excalidraw's prebuilt `dist/prod` folder, which holds its fonts. */
export function excalidrawDistDirectory(fromDirectory: string): string {
  const require = NodeModule.createRequire(NodePath.join(fromDirectory, "package.json"));
  // The package exports only its entry, which is dist/prod/index.js.
  return NodePath.dirname(require.resolve("@excalidraw/excalidraw"));
}

/**
 * Ships Excalidraw's fonts with the app instead of letting the editor fetch
 * them from a CDN: copied into the build under `excalidraw-assets/fonts/`, and
 * served from node_modules in dev. The whiteboard then draws with no network.
 */
export function excalidrawAssetsPlugin(fromDirectory: string): Plugin {
  const fonts = NodePath.join(excalidrawDistDirectory(fromDirectory), "fonts");
  let outDir = "";
  let building = false;
  return {
    name: "studio:excalidraw-assets",
    configResolved(config) {
      outDir = NodePath.resolve(config.root, config.build.outDir);
      building = config.command === "build";
    },
    configureServer(server) {
      const prefix = `/${EXCALIDRAW_ASSETS_DIR}/fonts/`;
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0] ?? "";
        if (!pathname.startsWith(prefix)) return next();
        const relative = decodeURIComponent(pathname.slice(prefix.length));
        const file = NodePath.resolve(fonts, relative);
        if (!file.startsWith(fonts + NodePath.sep) || !NodeFS.existsSync(file)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader(
          "Content-Type",
          MIME[NodePath.extname(file)] ?? "application/octet-stream",
        );
        NodeFS.createReadStream(file).pipe(response);
      });
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        // Built pages only: the dev server injects inline scripts of its own.
        if (!building || !context.filename.endsWith("whiteboard.html")) return html;
        return html.replace(
          "<head>",
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WHITEBOARD_FRAME_CSP}" />`,
        );
      },
    },
    async closeBundle() {
      if (!building || outDir.length === 0) return;
      await NodeFSP.cp(fonts, NodePath.join(outDir, EXCALIDRAW_ASSETS_DIR, "fonts"), {
        recursive: true,
      });
    },
  };
}
