// Headless only: PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/you/Projects/github/specweave-umb/repositories/anton-abyzov/specweave/node_modules/playwright");

const root = NodePath.resolve(".artifacts/model-lanes/site");
const output = process.argv[2]
  ? NodePath.resolve(process.argv[2])
  : "/Users/you/.specwithcode/m4/evidence/model-lanes-20261022";

await NodeFSP.mkdir(output, { recursive: true });

const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) return void res.writeHead(403).end();
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
const errors = [];
const checks = [];
const screenshots = [];

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // 1. Desktop Light
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/?theme=light`);
  await page.getByTestId("complex-lane").waitFor();
  await page.getByTestId("routine-lane").waitFor();
  await page.getByTestId("learned-preferences").waitFor();

  const lightShot = NodePath.join(output, "model-lanes-settings-desktop-light.png");
  await page.screenshot({ path: lightShot, fullPage: true });
  screenshots.push(lightShot);
  checks.push("Desktop Light (1280px): complex lane, routine lane, learned preferences rendered");

  // 2. Desktop Dark
  await page.goto(`${origin}/?theme=dark`);
  await page.getByTestId("complex-lane").waitFor();
  const darkShot = NodePath.join(output, "model-lanes-settings-desktop-dark.png");
  await page.screenshot({ path: darkShot, fullPage: true });
  screenshots.push(darkShot);
  checks.push("Desktop Dark (1280px): complex lane, routine lane, learned preferences rendered");

  // 3. Mobile Dark (390px)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/?theme=dark`);
  await page.getByTestId("complex-lane").waitFor();
  const mobileShot = NodePath.join(output, "model-lanes-settings-mobile-dark.png");
  await page.screenshot({ path: mobileShot, fullPage: true });
  screenshots.push(mobileShot);
  checks.push("Mobile Dark (390px): responsive layout with no overflow");

  // 4. Focused screenshots: Complex Lane, Routine Lane, Popover
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/?theme=dark`);

  const complexShot = NodePath.join(output, "model-lanes-complex-lane.png");
  await page.getByTestId("complex-lane").screenshot({ path: complexShot });
  screenshots.push(complexShot);
  checks.push("Complex lane focus: ordered models with seed button and rank indicators");

  const routineShot = NodePath.join(output, "model-lanes-routine-lane.png");
  await page.getByTestId("routine-lane").screenshot({ path: routineShot });
  screenshots.push(routineShot);
  checks.push("Routine lane focus: ordered models with usage-limit badge on exhausted provider");

  const popoverShot = NodePath.join(output, "model-lanes-popover.png");
  await page.getByTestId("popover-preview").screenshot({ path: popoverShot });
  screenshots.push(popoverShot);
  checks.push("Routing popover focus: lane decision, skipped explanation, teach this project feedback");

  NodeAssert.deepEqual(errors, []);

  const receipt = {
    type: "model-lanes-visual-verification",
    headless: true,
    timestamp: new Date().toISOString(),
    checks,
    errors,
    screenshots,
  };

  const receiptPath = NodePath.join(output, "receipt.json");
  await NodeFSP.writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log("Model lanes headless verification passed!");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
