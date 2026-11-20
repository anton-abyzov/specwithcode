// Headless check of `?scene=setup`: every direction button on the M5 and m1 cards does
// something a person can see, and the cards hold no "main machine" or role-chip words.
// Saves shots and a JSON report. Usage: node apps/web/tests/machines-page/shoot-setup.mjs <outDir> [label]
import * as NodeFs from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createServer } from "vite";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const out = NodePath.resolve(
  process.argv[2] ?? NodePath.join(here, "../../../../.artifacts/setup"),
);
const label = process.argv[3] ?? "after";
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
const report = { label, buttons: [], words: [], failures: [] };
try {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 900 },
    colorScheme: "light",
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.failures.push(`page error: ${error.message}`));
  await page.goto(`${url}?theme=light&scene=setup`, { timeout: 240_000 });
  const scene = page.locator('[data-scene="setup"]');
  await scene.waitFor({ timeout: 60_000 });
  await scene.screenshot({ path: NodePath.join(out, `machine-card-${label}-closed.png`) });

  // What a press changes: the card's text, which element has focus, and the scroll position.
  const state = (card) =>
    card.evaluate((element) => ({
      text: element.innerText,
      focus: document.activeElement
        ? `${document.activeElement.tagName} ${document.activeElement.getAttribute("aria-label") ?? document.activeElement.textContent?.trim().slice(0, 60)}`
        : null,
      scroll: window.scrollY,
    }));
  for (const machine of ["M5", "m1", "m4"]) {
    const card = page.locator(`li[aria-label="${machine}"]`);
    const buttons = card.locator(
      '[data-direction-action="set-up"], [data-direction-action="allow-setup"]',
    );
    for (let index = 0; index < (await buttons.count()); index++) {
      const button = buttons.nth(index);
      const action = await button.getAttribute("data-direction-action");
      // Press twice: the second press is the one Anton saw do nothing once the panel was open.
      for (const press of [1, 2]) {
        // Focus the button first, so a press that only focuses it counts as nothing.
        await button.focus();
        const before = await state(card);
        await button.click();
        await page.waitForTimeout(250);
        const after = await state(card);
        const changed =
          before.text !== after.text ||
          before.focus !== after.focus ||
          before.scroll !== after.scroll;
        report.buttons.push({ machine, action, press, changed, focus: after.focus });
        if (!changed) report.failures.push(`${machine} ${action}: press ${press} changed nothing`);
      }
    }
    const text = await card.innerText();
    for (const banned of ["main machine", "Extra coordinator", "This machine"])
      if (text.includes(banned)) report.words.push(`${machine}: "${banned}"`);
  }
  await scene.screenshot({ path: NodePath.join(out, `machine-card-${label}-open.png`) });
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
NodeFs.writeFileSync(
  NodePath.join(out, `machine-card-${label}.json`),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
