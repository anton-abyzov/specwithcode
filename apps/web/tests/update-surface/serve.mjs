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
  "env",
  "state/desktopUpdate",
  "state/serviceUpdate",
  "state/environments",
  "state/server",
  "state/session",
  "state/use-atom-command",
  "state/entities",
  "hooks/useSettings",
];
// The runner negotiates an ephemeral port; an explicit override aids interactive debugging.
const port = Number(process.env.UPDATE_SURFACE_PORT ?? 0);
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
      name: "isolated-update-surface-fixture",
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
  // The client sees itself as 1.0.25, so a 1.0.20 server is behind it; in the nightly
  // scene it is a nightly build, so a 1.0.66 server is. In dev, Vite evaluates this
  // expression in the page when a module reads import.meta.env.
  define: {
    "import.meta.env.APP_VERSION": `(new URLSearchParams(location.search).get("scene") === "server-nightly" ? ${JSON.stringify("1.0.67-nightly.20261021.882")} : ${JSON.stringify("1.0.25")})`,
  },
  resolve: { alias: { "~": NodePath.join(app, "src") } },
  server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [repo] } },
});
await server.listen();
const address = server.httpServer.address();
console.log(
  JSON.stringify({
    fixture: "update-surface",
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
