import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createServer } from "vite";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const out = process.argv[2] ?? NodePath.join(here, "../../../../.artifacts/machines-page");

const server = await createServer({
  configFile: NodePath.join(here, "vite.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
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
  [700, "light"],
  [390, "dark"],
]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${url}?theme=${theme}`, { timeout: 240_000 });
  await page
    .getByRole("button", { name: /Show automated/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Show archived/ })
    .first()
    .click();
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    badgeLefts: [
      ...document.querySelector("ul.grid").querySelectorAll("li > span.inline-flex"),
    ].map((badge) => Math.round(badge.getBoundingClientRect().left)),
  }));
  if (layout.overflow > 0) failures.push(`${width}px overflows by ${layout.overflow}px`);
  if (new Set(layout.badgeLefts).size !== 1)
    failures.push(`${width}px labels do not line up: ${layout.badgeLefts.join(", ")}`);
  await page.screenshot({
    path: NodePath.join(out, `machines-${width}-${theme}.png`),
    fullPage: true,
  });
  await page.close();
}
// The pause setting on each machine's update card, off and on.
for (const position of ["off", "on"]) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(`${url}?theme=light&scene=update-pause-${position}`, { timeout: 240_000 });
  const switches = page.getByRole("switch", { name: "Pause running work for updates" });
  await switches.first().waitFor({ timeout: 60_000 });
  const states = await switches.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-checked")),
  );
  const want = position === "on" ? "true" : "false";
  if (states.length !== 2 || states.some((state) => state !== want))
    failures.push(`update-pause-${position}: switches read ${states.join(", ")}`);
  const text = await page.locator("main").innerText();
  const expected =
    position === "on"
      ? ["After the wait set in “Pause running work after”", "After 30 minutes of waiting"]
      : [
          "An update waits until M4 has no running work, however long that takes",
          "An update waits up to 30 minutes for Minisforum to have no running work",
        ];
  for (const line of expected)
    if (!text.includes(line)) failures.push(`update-pause-${position}: missing "${line}"`);
  await page.screenshot({
    path: NodePath.join(out, `pause-setting-${position}.png`),
    fullPage: true,
  });
  await page.close();
}
await browser.close();
await server.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: ${out}`);
