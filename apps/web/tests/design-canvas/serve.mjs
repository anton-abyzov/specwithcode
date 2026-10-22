// Shared helpers for the design canvas headless checks: a static server for the
// built fixture and a headless Chromium launcher. Never opens a visible browser.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const repoRoot = NodePath.resolve(here, "../../../..");
export const siteRoot = NodePath.join(repoRoot, ".artifacts/design-canvas/site");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export async function serveSite() {
  if (!NodeFS.existsSync(NodePath.join(siteRoot, "index.html")))
    throw new Error(
      `Build the fixture first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/design-canvas/vite.config.ts`,
    );
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let file = NodePath.join(siteRoot, decodeURIComponent(url.pathname));
    if (!file.startsWith(siteRoot)) {
      response.writeHead(403).end();
      return;
    }
    if (!NodeFS.existsSync(file) || NodeFS.statSync(file).isDirectory())
      file = NodePath.join(siteRoot, "index.html");
    response.writeHead(200, {
      "content-type": TYPES[NodePath.extname(file)] ?? "application/octet-stream",
    });
    NodeFS.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function loadPlaywright() {
  const candidates = [
    process.env.STUDIO_PLAYWRIGHT_MODULE,
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!NodeFS.existsSync(candidate)) continue;
    const require = NodeModule.createRequire(import.meta.url);
    try {
      return require(candidate);
    } catch {
      return import(NodeURL.pathToFileURL(NodePath.join(candidate, "index.mjs")).href);
    }
  }
  throw new Error("Set STUDIO_PLAYWRIGHT_MODULE to an installed playwright package.");
}

export async function launch() {
  const { chromium } = await loadPlaywright();
  return chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
}
