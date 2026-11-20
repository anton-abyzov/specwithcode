// A video of any shape fits the viewer's stage with its controls visible.
// Build first: vp build --config apps/web/tests/viewer-video/vite.config.ts
// UI_EVIDENCE_DIR must be a new directory (default: a timestamped one under .artifacts). Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output =
  process.env.UI_EVIDENCE_DIR ??
  NodePath.resolve(
    `.artifacts/viewer-video/evidence-${new Date().toISOString().replace(/\W/g, "")}`,
  );
await NodeFSP.mkdir(output, { recursive: !process.env.UI_EVIDENCE_DIR });
const root = NodePath.resolve(process.env.VIEWER_VIDEO_SITE ?? ".artifacts/viewer-video/site");
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/media/")) {
      const name = decodeURIComponent(url.pathname.slice("/media/".length));
      const portrait = name.startsWith("portrait");
      const real = portrait
        ? process.env.VIEWER_VIDEO_PORTRAIT
        : process.env.VIEWER_VIDEO_LANDSCAPE;
      const body = await NodeFSP.readFile(
        real ?? new URL(`./${portrait ? "portrait" : "landscape"}.webm`, import.meta.url),
      );
      const type = real ? "video/mp4" : "video/webm";
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
      if (range) {
        const start = Number(range[1] || 0);
        const end = range[2] ? Number(range[2]) : body.length - 1;
        res.writeHead(206, {
          "Content-Type": type,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Content-Length": end - start + 1,
        });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Content-Length": body.length,
      });
      res.end(body);
      return;
    }
    const file = NodePath.resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});

const VIEWS = [
  { name: "normal", viewport: { width: 1440, height: 900 } },
  { name: "small", viewport: { width: 900, height: 560 } },
  { name: "tiny", viewport: { width: 640, height: 420 } },
];
const HOSTS = [
  { name: "artifact", next: "Next artifact" },
  { name: "expanded", next: "Next media" },
];
const results = [];
const errors = [];

const measure = (page) =>
  page.evaluate(() => {
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        w: r.width,
        h: r.height,
      };
    };
    const stage = document.querySelector("[data-artifact-stage]");
    const video = stage.querySelector("video");
    return {
      stage: box(stage),
      video: box(video),
      intrinsic: [video.videoWidth, video.videoHeight],
      overlay: box(document.querySelector("[data-viewer-overlay]")),
    };
  });

try {
  for (const host of HOSTS) {
    for (const view of VIEWS) {
      const context = await browser.newContext({ viewport: view.viewport });
      const page = await context.newPage();
      page.on("pageerror", (error) => {
        console.log("PAGEERROR", error.message.slice(0, 400));
        errors.push(`${view.name}: ${error.message}`);
      });
      page.on(
        "console",
        (m) => m.type() === "error" && console.log("CONSOLE", m.text().slice(0, 300)),
      );
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?host=${host.name}`);
      await page
        .locator("[data-artifact-stage] video")
        .waitFor({ timeout: 8000 })
        .catch(async (e) => {
          await page.screenshot({ path: NodePath.join(output, "fail.png") });
          console.log((await page.locator("body").innerText()).slice(0, 500));
          throw e;
        });
      for (const shape of ["landscape", "portrait"]) {
        if (shape === "portrait") {
          await page.getByRole("button", { name: host.next }).click();
        }
        await page.waitForFunction((name) => {
          const video = document.querySelector("[data-artifact-stage] video");
          return video && video.videoWidth > 0 && video.src.includes(name);
        }, shape);
        const m = await measure(page);
        await page.screenshot({
          path: NodePath.join(output, `${host.name}-${shape}-${view.name}.png`),
        });
        results.push({ host: host.name, view: view.name, shape, ...m });
        const tolerance = 1;
        NodeAssert.ok(
          m.video.bottom <= m.stage.bottom + tolerance && m.video.top >= m.stage.top - tolerance,
          `${host.name} ${shape} ${view.name}: video ${m.video.top}-${m.video.bottom} inside stage ${m.stage.top}-${m.stage.bottom}`,
        );
        NodeAssert.ok(
          m.video.right <= m.stage.right + tolerance && m.video.left >= m.stage.left - tolerance,
          `${host.name} ${shape} ${view.name}: video inside stage across`,
        );
      }
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, []);
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "viewer-video-check.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
  await browser.close();
  server.close();
}
console.log(
  JSON.stringify(
    results.map((r) => ({ h: r.host, v: r.view, s: r.shape, video: r.video, stage: r.stage })),
    null,
    1,
  ),
);
