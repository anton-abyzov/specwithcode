// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/popup-standard/vite.config.ts
// Usage: node apps/web/tests/popup-standard/verify.mjs [/absolute/evidence-dir] [--before]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Opens each popup of the fixture at 390, 840 and 2000 px, light and dark, measures it, runs
// axe on it and shoots the window. Without --before it also asserts the popup standard
// (docs/studio/design-guidelines.md, Popups): the width cap per kind, an 8 px margin inside
// the window, keyboard movement and focus return, and no axe contrast or name violations.
// --before only records (for shots of the old look). Writes measurements.json beside the shots.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const args = process.argv.slice(2);
const before = args.includes("--before");
const output = path.resolve(
  args.find((a) => !a.startsWith("--")) ?? ".artifacts/popup-standard/evidence",
);
await fs.mkdir(output, { recursive: true });
const axeSource = await fs.readFile(
  path.resolve("apps/web/node_modules/axe-core/axe.min.js"),
  "utf8",
);
const root = path.resolve(".artifacts/popup-standard/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});

const REM = 16;
// The popup each case opens, its kind's width cap in px, and whether arrow keys move in it.
const CASES = [
  {
    name: "machine",
    trigger: "[data-coordinator-machine]",
    popup: '[data-slot="menu-popup"]',
    cap: 20 * REM,
    keys: true,
    info: true,
  },
  {
    name: "machine-linked",
    trigger: "[data-coordinator-machine]",
    popup: '[data-slot="menu-popup"]',
    cap: 20 * REM,
    keys: true,
  },
  {
    name: "menu",
    trigger: "[data-popup-trigger]",
    popup: '[data-slot="menu-popup"]',
    cap: 20 * REM,
    keys: true,
  },
  {
    name: "submenu",
    trigger: "[data-popup-trigger]",
    popup: '[data-slot="menu-popup"]',
    cap: 20 * REM,
    keys: true,
    submenu: true,
  },
  {
    name: "popover",
    trigger: "[data-popup-trigger]",
    popup: '[data-slot="popover-popup"]',
    cap: 32 * REM,
  },
  {
    name: "dialog",
    trigger: "[data-popup-trigger]",
    popup: '[role="dialog"]',
    cap: 32 * REM,
    trap: true,
  },
  {
    name: "alert",
    trigger: "[data-popup-trigger]",
    popup: '[role="alertdialog"]',
    cap: 32 * REM,
    trap: true,
  },
  // The destructive button again on the unthemed tokens, whose error colors differ.
  {
    name: "alert-unthemed",
    page: "alert",
    query: "&palette=none",
    trigger: "[data-popup-trigger]",
    popup: '[role="alertdialog"]',
    cap: 32 * REM,
    trap: true,
  },
  {
    name: "select",
    trigger: "[data-popup-trigger]",
    popup: '[data-slot="select-popup"]',
    cap: 24 * REM,
  },
  {
    name: "toast",
    trigger: "[data-popup-trigger]",
    popup: '[data-slot="toast-viewport"] > :first-child',
    cap: 24 * REM,
  },
];
const SIZES = [
  { name: "390", width: 390, height: 844 },
  { name: "840", width: 840, height: 720 },
  { name: "2000", width: 2000, height: 1200 },
];
const MARGIN = 8;

const results = [];
const failures = [];
const errors = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

try {
  for (const theme of ["light", "dark"]) {
    for (const size of SIZES) {
      for (const item of CASES) {
        const id = `${item.name}-${size.name}-${theme}`;
        const page = await browser.newPage({
          viewport: { width: size.width, height: size.height },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        page.on("pageerror", (error) => errors.push(`${id}: ${error.message}`));
        await page.goto(
          `${origin}/?case=${item.page ?? item.name}&theme=${theme}${item.query ?? ""}`,
        );
        const trigger = page.locator(item.trigger).first();
        await trigger.click();
        const popup = page.locator(item.popup).first();
        try {
          await popup.waitFor({ timeout: 4000 });
        } catch {
          failures.push(`${id}: popup ${item.popup} did not open`);
          await page.screenshot({ path: path.join(output, `${id}.png`) });
          await page.close();
          continue;
        }
        await page.waitForTimeout(300);
        const box = await popup.boundingBox();
        const shot = path.join(output, `${id}.png`);
        await page.screenshot({ path: shot });
        await page.addScriptTag({ content: axeSource });
        const axe = await page.evaluate(async (selector) => {
          const node = document.querySelector(selector);
          const result = await window.axe.run(node ?? document, {
            runOnly: {
              type: "rule",
              values: [
                "color-contrast",
                "aria-command-name",
                "aria-input-field-name",
                "button-name",
                "link-name",
                "aria-dialog-name",
              ],
            },
          });
          return result.violations.map((v) => `${v.id}: ${v.nodes.length}`);
        }, item.popup);
        const row = {
          id,
          case: item.name,
          size: size.name,
          theme,
          box: box && {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
          cap: Math.min(item.cap, size.width - 2 * REM),
          axe,
          shot,
        };
        // Below 640 px a dialog is a bottom sheet: full width, resting on the window's foot.
        const sheet = item.trap && size.width < 640;
        if (!before && box && sheet) {
          check(
            Math.round(box.width) === size.width && Math.round(box.y + box.height) === size.height,
            `${id}: not a bottom sheet ${JSON.stringify(row.box)}`,
          );
        }
        if (!before && box && !sheet) {
          check(
            box.width <= row.cap + 1,
            `${id}: ${Math.round(box.width)} px wide, cap ${row.cap}`,
          );
          check(
            box.x >= MARGIN - 1 &&
              box.y >= MARGIN - 1 &&
              box.x + box.width <= size.width - MARGIN + 1 &&
              box.y + box.height <= size.height - MARGIN + 1,
            `${id}: outside the window margin ${JSON.stringify(row.box)}`,
          );
          check(axe.length === 0, `${id}: axe ${axe.join(", ")}`);
        }
        // The explanation behind the first label's info button, opened in place.
        const infoButton = page.locator('[data-slot="menu-info-button"]').first();
        if (item.info && (await infoButton.count())) {
          const target = await infoButton.boundingBox();
          row.infoTarget = target && {
            width: Math.round(target.width),
            height: Math.round(target.height),
          };
          if (!before && target && size.width < 640) {
            check(
              target.width >= 40 && target.height >= 32,
              `${id}: info button ${row.infoTarget.width}x${row.infoTarget.height} is under a finger-sized target`,
            );
          }
          await infoButton.click();
          await page.waitForTimeout(250);
          const infoBox = await popup.boundingBox();
          row.info = infoBox && {
            width: Math.round(infoBox.width),
            height: Math.round(infoBox.height),
          };
          row.infoShot = path.join(output, `${id}-info.png`);
          await page.screenshot({ path: row.infoShot });
          if (!before && infoBox) {
            check(infoBox.width <= row.cap + 1, `${id} info: ${Math.round(infoBox.width)} px wide`);
            check(infoBox.y >= MARGIN - 1, `${id} info: above the window margin`);
            check((await page.locator(item.popup).count()) === 1, `${id}: info closed the menu`);
          }
          await infoButton.click();
          await page.waitForTimeout(150);
        }
        if (!before && item.keys) {
          // The pointer rests on a row first (the info click above leaves it there): Escape must
          // still hand focus back to the trigger.
          await page.locator(`${item.popup} [role^="menuitem"]`).first().hover();
          await page.keyboard.press("ArrowDown");
          const first = await page.evaluate(() => document.activeElement?.getAttribute("role"));
          const firstSlot = await page.evaluate(() =>
            document.activeElement?.getAttribute("data-slot"),
          );
          await page.keyboard.press("End");
          const last = await page.evaluate(() => document.activeElement?.textContent?.trim());
          await page.keyboard.press("Home");
          const home = await page.evaluate(() => document.activeElement?.getAttribute("data-slot"));
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
          const back = await page.evaluate(
            (selector) => document.activeElement === document.querySelector(selector),
            item.trigger,
          );
          // Opened from the keyboard, the menu starts on its first real row, never on an
          // icon-only info button.
          await page.keyboard.press("Enter");
          await popup.waitFor({ timeout: 4000 });
          await page.waitForTimeout(250);
          const keyboardFirst = await page.evaluate(() =>
            document.activeElement?.getAttribute("data-slot"),
          );
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
          row.keys = { first, firstSlot, last, home, keyboardFirst, back };
          check(/^menuitem/.test(first ?? ""), `${id}: ArrowDown focused ${first}`);
          // Each step lands on a real row: never the info button, never the page body.
          const ROW = /^menu-(?:radio-|checkbox-)?item$|^menu-sub-trigger$/;
          for (const [step, slot] of [
            ["ArrowDown", firstSlot],
            ["Home", home],
            ["keyboard open", keyboardFirst],
          ]) {
            check(ROW.test(slot ?? ""), `${id}: ${step} focused ${slot ?? "nothing"}, not a row`);
          }
          check(back, `${id}: Escape did not return focus to the trigger`);
        }
        if (!before && item.submenu) {
          // Escape from a submenu with the pointer on one of its rows goes back to the row that
          // opened it, and the parent menu stays open.
          await trigger.click();
          await popup.waitFor({ timeout: 4000 });
          await page.locator("[data-submenu-trigger]").hover();
          const sub = page.locator('[data-slot="menu-sub-content"]').first();
          await sub.waitFor({ timeout: 4000 });
          await page.waitForTimeout(250);
          await sub.locator('[role^="menuitem"]').first().hover();
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
          const subBack = await page.evaluate(() => ({
            slot: document.activeElement?.getAttribute("data-slot") ?? null,
            subOpen: !!document.querySelector('[data-slot="menu-sub-content"]'),
            parentOpen: !!document.querySelector('[data-slot="menu-popup"]'),
          }));
          row.submenu = subBack;
          check(
            subBack.slot === "menu-sub-trigger" && !subBack.subOpen && subBack.parentOpen,
            `${id}: submenu Escape left focus on ${subBack.slot ?? "the body"}`,
          );
          await page.keyboard.press("Escape");
        }
        if (!before && item.trap) {
          // Focus may rest on the body or a focus guard for one step while it wraps; it must
          // never reach a control outside the dialog.
          let inside = true;
          for (let i = 0; i < 8; i++) {
            await page.keyboard.press("Tab");
            // At machine speed a press can land before the focus guard moves focus back in.
            await page.waitForTimeout(150);
            const ok = await page.evaluate((selector) => {
              const active = document.activeElement;
              return (
                !active ||
                active === document.body ||
                active.hasAttribute("data-base-ui-focus-guard") ||
                !!document.querySelector(selector)?.contains(active)
              );
            }, item.popup);
            inside &&= ok;
          }
          await page.keyboard.press("Escape");
          await page.waitForTimeout(500);
          const back = await page.evaluate(
            (selector) => document.activeElement === document.querySelector(selector),
            item.trigger,
          );
          row.focus = { inside, back };
          check(inside, `${id}: Tab left the dialog`);
          check(back, `${id}: focus did not return to the trigger`);
        }
        results.push(row);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(
  path.join(output, "measurements.json"),
  JSON.stringify({ before, results, failures, errors }, null, 2),
);
for (const row of results)
  console.log(
    `${row.id.padEnd(28)} ${String(row.box?.width ?? "-").padStart(5)} px  cap ${row.cap}  axe ${row.axe.length}`,
  );
if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
if (failures.length) {
  console.log(`failures (${failures.length}):\n  ${failures.join("\n  ")}`);
  if (!before) process.exit(1);
}
console.log(`${results.length} popups measured -> ${output}`);
