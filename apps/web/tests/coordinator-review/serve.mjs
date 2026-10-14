import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fixture = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const app = NodePath.resolve(fixture, "../..");
const repo = NodePath.resolve(app, "../..");
const mocks = NodePath.join(fixture, "mocks.tsx");
const stubs = [
  "lib/archivedThreadsState",
  "assets/assetUrls",
  "components/files/AttachmentFilePreview",
  "state/entities",
  "state/environments",
  "state/session",
  "state/query",
  "state/queries",
  "lib/attachmentUploadQueue",
  "lib/imageCompression",
  "state/use-atom-command",
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
// The runner negotiates an ephemeral port; an explicit override aids interactive debugging.
const port = Number(process.env.COORDINATOR_REVIEW_PORT ?? 0);
const files = new Set(stubs.map((s) => NodePath.join(app, "src", s)));
const css = (await NodeFSP.readdir(NodePath.join(app, "dist/assets"))).find(
  (n) => n.startsWith("main-") && n.endsWith(".css"),
);
if (css === undefined)
  throw new Error("Build this checkout's web application before running the fixture.");
const server = await createServer({
  configFile: false,
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
            : source.startsWith("/")
              ? source.replace(/^\/@fs/, "")
              : null;
        if (target === null) return;
        const resolved = target.replace(/\.(tsx?|jsx?)$/, "");
        if (files.has(resolved)) return mocks;
        if (resolved === NodePath.join(app, "src/components/ChatView")) return "\0fixture-thread";
        if (
          resolved === NodePath.join(app, "src/components/ChatMarkdown") &&
          !importer.includes("CoordinatorNativeControls")
        )
          return "\0fixture-markdown";
      },
      load(id) {
        if (id === "\0fixture-thread")
          return `export {NativeThreadFixture as default} from ${JSON.stringify(mocks)}`;
        if (id === "\0fixture-markdown")
          return `export {MarkdownFixture as default} from ${JSON.stringify(mocks)}`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?", 1)[0] !== "/") return next();
          const html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="/@fs/${app}/dist/assets/${css}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>`;
          res.setHeader("Content-Type", "text/html");
          server.transformIndexHtml("/", html).then((output) => res.end(output), next);
        });
      },
    },
    react(),
  ],
  resolve: { alias: { "~": NodePath.join(app, "src") } },
  server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [repo] } },
});
await server.listen();
const address = server.httpServer.address();
console.log(
  JSON.stringify({
    fixture: "coordinator-review",
    origin: `http://127.0.0.1:${address.port}`,
    pid: process.pid,
    synthetic: true,
  }),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
