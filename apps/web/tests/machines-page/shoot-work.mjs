// Headless shots of `?scene=work` in light and dark, desktop and 390 px.
// Usage: node apps/web/tests/machines-page/shoot-work.mjs <outDir> <prefix>
import * as NodeFs from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createServer } from "vite";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const out = NodePath.resolve(process.argv[2] ?? NodePath.join(here, "../../../../.artifacts/work"));
const prefix = process.argv[3] ?? "work";
const open = process.argv.includes("--open-limits");
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
for (const [width, theme] of [
  [1100, "light"],
  [1100, "dark"],
  [390, "light"],
  [390, "dark"],
]) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`${width}-${theme}: ${error.message}`));
  await page.goto(`${url}?theme=${theme}&scene=work`, { timeout: 240_000 });
  await page.locator('[data-scene="work"]').waitFor({ timeout: 60_000 });
  if (open)
    await page.evaluate(() => {
      for (const details of document.querySelectorAll('[data-slot="limits"]')) details.open = true;
    });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) failures.push(`${width}-${theme} overflows by ${overflow}px`);
  await page.screenshot({
    path: NodePath.join(out, `${prefix}-${width}-${theme}${open ? "-limits" : ""}.png`),
    fullPage: true,
  });
  await context.close();
}
await browser.close();
await server.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: ${out}`);
