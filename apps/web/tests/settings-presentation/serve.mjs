import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fixture = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const app = NodePath.resolve(fixture, "../..");
const repo = NodePath.resolve(app, "../..");
const mocks = NodePath.join(fixture, "mocks.tsx");
const recoverySettings = NodePath.resolve(fixture, "../project-workspace/recovery-settings.ts");
const stubs = [
  "lib/archivedThreadsState",
  "assets/assetUrls",
  "components/files/AttachmentFilePreview",
  "state/entities",
  "state/environments",
  "state/session",
  "state/query",
  "state/use-atom-command",
  "state/use-atom-query-runner",
  "state/assets",
  "lib/attachmentUploadQueue",
  "state/threads",
  "state/projects",
  "state/server",
  "state/presentation",
  "hooks/useThreadActions",
  "studio/projectWorkspace",
  "env",
  "components/settings/useSettingsProjectGroups",
  "components/WorkspacePageHeader",
  "components/ui/sidebar",
  "components/studio/ProjectModels",
];
// Another run of the fixture may hold the default port; PROJECT_UI_PORT picks a different one.
const port = Number(process.env.PROJECT_UI_PORT ?? 5796);
const files = new Set(stubs.map((s) => NodePath.join(app, "src", s)));
const server = await createServer({
  configFile: false,
  cacheDir:
    process.env.UI_CACHE_DIR ?? NodePath.join(repo, ".artifacts/settings-presentation/vite-cache"),
  root: fixture,
  plugins: [
    {
      name: "isolated-project-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "@tanstack/react-router") return mocks;
        if (!importer) return;
        // Stubs are matched by file, whether imported relatively or through the "~" alias.
        const target = source.startsWith("~/")
          ? NodePath.join(app, "src", source.slice(2))
          : source.startsWith(".")
            ? NodePath.resolve(NodePath.dirname(importer), source)
            : null;
        if (target === null) return;
        const resolved = target.replace(/\.(tsx?|jsx?)$/, "");
        if (
          resolved === NodePath.join(app, "src/hooks/useSettings") &&
          importer !== recoverySettings
        )
          return recoverySettings;
        if (files.has(resolved)) return mocks;
        if (resolved === NodePath.join(app, "src/components/ChatView")) return "\0fixture-thread";
        if (resolved === NodePath.join(app, "src/components/ChatMarkdown"))
          return "\0fixture-markdown";
      },
      load(id) {
        if (id === "\0fixture-thread")
          return `export {NativeThreadFixture as default} from ${JSON.stringify(mocks)}`;
        if (id === "\0fixture-markdown")
          return `export {MarkdownFixture as default} from ${JSON.stringify(mocks)}`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?", 1)[0] !== "/") return next();
          const css = (await NodeFSP.readdir(NodePath.join(app, "dist/assets"))).find(
            (n) => n.startsWith("main-") && n.endsWith(".css"),
          );
          if (!css) throw new Error("Build apps/web before running the settings fixture");
          const html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="/@fs/${app}/dist/assets/${css}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>`;
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/", html));
        });
      },
    },
    react(),
  ],
  resolve: { alias: { "~": NodePath.join(app, "src") } },
  server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [repo] } },
});
await server.listen();
console.log(`Isolated UI fixture http://127.0.0.1:${port}`);
