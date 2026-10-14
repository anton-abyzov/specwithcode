import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(fixture, "../../../..");
const app = path.join(root, "apps/web");
const output = path.join(root, "reports/unified-permissions");
await fs.mkdir(output, { recursive: true });
const css = (await fs.readdir(path.join(app, "dist/assets"))).find(
  (n) => n.startsWith("main-") && n.endsWith(".css"),
);
assert(css);
const server = await createServer({
  configFile: false,
  root: fixture,
  cacheDir: path.join(root, ".cache/unified-permissions"),
  plugins: [
    react(),
    {
      name: "fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/",
              `<!doctype html><html><head><link rel="stylesheet" href="/@fs/${app}/dist/assets/${css}"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
  resolve: { alias: { "~": path.join(app, "src") } },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]);
  const trigger = page.getByRole("button", { name: /Agent.*Medium/ });
  await trigger.click();
  assert.equal(await page.getByText("Allow All", { exact: true }).count(), 0);
  await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Agent.*High/ }).click();
  assert.equal(await page.getByText("Allow All", { exact: true }).count(), 0);
  await page.screenshot({
    path: path.join(output, "composer-options.png"),
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "browser.json"),
    JSON.stringify(
      {
        headless: true,
        checks: [
          "cached Allow All absent from trigger and menu",
          "reasoning change remains interactive",
          "agent control preserved",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log("Headless composer checks passed");
} finally {
  await browser?.close();
  await server.close();
}
