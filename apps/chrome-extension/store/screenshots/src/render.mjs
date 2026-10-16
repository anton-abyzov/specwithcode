#!/usr/bin/env node
/**
 * Renders the Chrome Web Store screenshots (1280x800) and the small promo tile
 * (440x280) from the HTML scenes next to this file. The scenes embed the real
 * popup (src/popup.html, popup.css, popup.js) with a stubbed `chrome` object.
 *
 * Headless only:
 *   PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node store/screenshots/src/render.mjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, "../../..");
const outDir = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const playwrightPath =
  process.env.PLAYWRIGHT_CORE ??
  path.resolve(extRoot, "../../node_modules/.pnpm/node_modules/playwright-core");
const { chromium } = require(playwrightPath);

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".png": "image/png",
};

/** Stub states the popup polls through chrome.runtime.sendMessage({type:"status"}). */
const STATES = {
  not_paired: { phase: "not_paired" },
  connected: { phase: "connected", label: "Personal", machine: "MacBook Pro", attachedTabs: 2 },
};

function popupDocument(stateName) {
  const state = STATES[stateName] ?? STATES.not_paired;
  const prefill = stateName === "not_paired";
  const stub = `<script>
    window.chrome = { runtime: { sendMessage: async () => ({ ok: true, state: ${JSON.stringify(state)} }) } };
    ${
      prefill
        ? `addEventListener("DOMContentLoaded", () => {
      document.getElementById("code").value = "swc-chrome:1:eyJ1Ijoid3M6Ly8xMjcuMC4wLjE6NDc1MTEvYXBpL2Jyb3dzZXItcmVsYXkiLCJ0IjoiNmY0YzlhLi4uIiwibSI6Ik1hY0Jvb2sgUHJvIn0";
      document.getElementById("label").value = "Personal";
    });`
        : ""
    }
  </script>
  <style>html{color-scheme:light}body{background:#fff;color:#1f2328}</style>`;
  return fs
    .readFileSync(path.join(extRoot, "src/popup.html"), "utf8")
    .replace('href="popup.css"', 'href="/src/popup.css"')
    .replace('src="../icons/icon-32.png"', 'src="/icons/icon-32.png"')
    .replace('src="popup.js"', 'src="/src/popup.js"')
    .replace("</head>", `${stub}</head>`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/popup") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(popupDocument(url.searchParams.get("state")));
  }
  const file = path.normalize(path.join(extRoot, decodeURIComponent(url.pathname)));
  if (!file.startsWith(extRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const SHOTS = [
  { scene: "scene-1-overview.html", out: "screenshot-1-overview.png", width: 1280, height: 800 },
  { scene: "scene-2-pair.html", out: "screenshot-2-pair.png", width: 1280, height: 800 },
  { scene: "scene-3-tab-group.html", out: "screenshot-3-tab-group.png", width: 1280, height: 800 },
  { scene: "scene-4-agents.html", out: "screenshot-4-agents.png", width: 1280, height: 800 },
  { scene: "scene-5-control.html", out: "screenshot-5-control.png", width: 1280, height: 800 },
  { scene: "promo-small.html", out: "promo-small-440x280.png", width: 440, height: 280 },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 1,
    });
    await page.goto(`${base}/store/screenshots/src/${shot.scene}`, { waitUntil: "networkidle" });
    for (const frame of page.frames()) await frame.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, shot.out), omitBackground: false });
    await page.close();
    console.log(`wrote ${shot.out}`);
  }
} finally {
  await browser.close();
  server.close();
}
