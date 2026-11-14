// Headless shots of `?scene=card` (1326): the card's direction rows in each state, the
// Allow… time limits open, and Connection details open. Light and dark, desktop and 390 px.
// Usage: node apps/web/tests/machines-page/shoot-card.mjs <outDir>
import * as NodeFs from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createServer } from "vite";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const out = NodePath.resolve(process.argv[2] ?? NodePath.join(here, "../../../../.artifacts/card"));
NodeFs.mkdirSync(out, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const server = await createServer({
  configFile: NodePath.join(here, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  channel: process.env.STUDIO_PLAYWRIGHT_CHANNEL || "chrome",
});
const failures = [];
const shots = [];
for (const [width, theme] of [
  [1100, "light"],
  [1100, "dark"],
  [390, "light"],
]) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`${width}-${theme}: ${error.message}`));
  await page.goto(`${url}?theme=${theme}&scene=card`, { timeout: 240_000 });
  await page.locator('[data-scene="card"]').waitFor({ timeout: 60_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) failures.push(`${width}-${theme} overflows by ${overflow}px`);
  const name = (what) => NodePath.join(out, `machine-card-${what}-${width}-${theme}.png`);
  await page.screenshot({ path: name("states"), fullPage: true });
  shots.push(name("states"));
  if (width === 1100 && theme === "light") {
    // The ended card's Allow…: the four time limits, one week marked default.
    const ended = page.locator('li[aria-label="linux-mini"]');
    await ended.locator('[data-direction-action="allow"]').click();
    await page.locator("[data-allow-duration]").first().waitFor();
    await page.waitForTimeout(200);
    await page.screenshot({ path: name("allow-menu"), fullPage: true });
    shots.push(name("allow-menu"));
    await page.keyboard.press("Escape");
    // m5's Change…: Connection details under the card.
    await page.locator('li[aria-label="m5"] [data-direction-action="change"]').click();
    await page.locator('[data-slot="connection-details"]').first().waitFor();
    await page.locator('li[aria-label="m5"] [data-projects-more]').click();
    await page.waitForTimeout(200);
    await page.locator('li[aria-label="m5"]').screenshot({ path: name("details-open") });
    shots.push(name("details-open"));
  }
  await context.close();
}
await browser.close();
await server.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(shots.join("\n"));
