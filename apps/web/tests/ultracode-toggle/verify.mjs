// Build first: vp build --config apps/web/tests/ultracode-toggle/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/ultracode-toggle/verify.mjs [/absolute/evidence-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/ultracode-toggle/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/ultracode-toggle/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
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
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const receipt = { headless: true, checks: [], screenshots: [] };
const check = async (name, fn) => {
  await fn();
  receipt.checks.push(name);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const shot = async (page, name) => {
  const file = NodePath.join(output, name);
  await page.screenshot({ path: file, fullPage: true });
  receipt.screenshots.push(file);
};
// What each chat's chip says, its accessible name, and how the open menu reads.
const NOT_SET_THREADS = "Not set here: on by default for threads. Uses more of your Claude limit.";
const CASES = {
  on: { chip: "Medium · Ultracode", name: "Medium effort · Ultracode", checked: "On", badge: null },
  off: {
    chip: "Medium",
    name: "Medium effort",
    checked: null,
    badge: null,
    note: /Not set: follows the Claude workflow mode/,
  },
  legacy: { chip: "Extra High · Ultracode", name: "Extra High effort · Ultracode" },
  "default-on": {
    chip: "Medium · Ultracode",
    name: "Medium effort · Ultracode",
    checked: "On",
    badge: "On",
    note: NOT_SET_THREADS,
  },
  paused: {
    chip: "Medium · Ultracode paused",
    name: "Medium effort · Ultracode paused",
    checked: null,
    badge: null,
    note: "Not set here: the default is paused until your Claude limit resets.",
  },
  coordinator: { chip: "Medium", name: "Medium effort", checked: "Off", badge: "Off", note: null },
  "set-off": { chip: "Medium", name: "Medium effort", checked: "Off", badge: null, note: null },
  "no-toggle": { chip: "Medium", name: "Medium effort", group: false },
  all: {
    chip: "Medium · Ultracode",
    name: "Medium effort · Ultracode",
    checked: "On",
    badge: "On",
    note: "Not set here: on by default for all chats. Uses more of your Claude limit.",
  },
};
const WIDTHS = [
  { width: 1440, height: 760 },
  { width: 390, height: 760 },
];
const ultracodeGroup = (menu) => menu.locator("[role=group]").filter({ hasText: "Ultracode" });
try {
  for (const theme of ["light", "dark"]) {
    for (const viewport of WIDTHS) {
      const wide = viewport.width >= 900;
      for (const [scenario, want] of Object.entries(CASES)) {
        const label = `${theme} ${viewport.width} ${scenario}`;
        const page = await browser.newPage({ viewport });
        await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
        await page.waitForSelector("body[data-fixture-ready]");
        const trigger = page.locator('[data-composer-shortcut="composer.effort"]').first();
        await trigger.waitFor();
        const chip = async () => (await trigger.innerText()).replace(/\s+/g, " ").trim();
        const name = async () => (await trigger.getAttribute("aria-label")) ?? "";
        await check(`${label}: chip is named "${want.name}"`, async () => {
          NodeAssert.equal(await name(), want.name);
        });
        // A narrow composer folds the chip's words away; the name above still carries them.
        if (wide)
          await check(`${label}: chip reads "${want.chip}"`, async () => {
            NodeAssert.equal(await chip(), want.chip);
          });
        if (scenario === "paused")
          await check(`${label}: the paused word uses the warning text token`, async () => {
            const mark = trigger.locator('[data-composer-control-ultracode="paused"]');
            NodeAssert.equal(await mark.count(), 1);
            NodeAssert.match((await mark.getAttribute("class")) ?? "", /text-warning-foreground/);
          });
        await settle();
        await shot(page, `composer-${scenario}-${theme}-${viewport.width}.png`);
        if (want.checked === undefined && want.group === undefined) {
          await page.close();
          continue;
        }
        await trigger.click();
        const menu = page.getByRole("menu");
        await menu.waitFor();
        if (want.group === false) {
          await check(`${label}: a model without the toggle shows no Ultracode choice`, async () => {
            NodeAssert.equal(await ultracodeGroup(menu).count(), 0);
            NodeAssert.doesNotMatch(await menu.innerText(), /Ultracode/);
          });
        } else {
          const group = ultracodeGroup(menu);
          await check(`${label}: menu marks ${want.checked ?? "neither choice"}`, async () => {
            const checked = group.locator("[role=menuitemradio][data-checked]");
            NodeAssert.equal(await checked.count(), want.checked ? 1 : 0);
            if (want.checked)
              NodeAssert.match(await checked.innerText(), new RegExp(`^${want.checked}\\b`));
          });
          await check(`${label}: Default badge on ${want.badge ?? "neither choice"}`, async () => {
            const badged = group
              .locator("[role=menuitemradio]")
              .filter({ hasText: /Default$/ });
            NodeAssert.equal(await badged.count(), want.badge ? 1 : 0);
            if (want.badge)
              NodeAssert.match(await badged.innerText(), new RegExp(`^${want.badge}\\s+Default$`));
          });
          if (want.note !== undefined)
            await check(`${label}: the menu says why`, async () => {
              const note = group.locator("[data-ultracode-unset-note]");
              if (want.note === null) NodeAssert.equal(await note.count(), 0);
              else if (want.note instanceof RegExp) NodeAssert.match(await note.innerText(), want.note);
              else NodeAssert.equal((await note.innerText()).replace(/\s+/g, " ").trim(), want.note);
            });
        }
        await settle();
        await shot(page, `menu-${scenario}-${theme}-${viewport.width}.png`);
        if (scenario === "default-on" && wide) {
          // Picking the On the default already marks saves it on the chat; the chip keeps its word.
          await ultracodeGroup(menu).getByRole("menuitemradio", { name: /^On/ }).click();
          await trigger.click();
          await page.getByRole("menu").waitFor();
          await check(`${label}: picking On saves it, so the badge leaves`, async () => {
            const group = ultracodeGroup(page.getByRole("menu"));
            NodeAssert.equal(await group.locator("[data-ultracode-unset-note]").count(), 0);
            NodeAssert.equal(
              await group.locator("[role=menuitemradio]").filter({ hasText: /Default$/ }).count(),
              0,
            );
          });
          await ultracodeGroup(page.getByRole("menu"))
            .getByRole("menuitemradio", { name: /^Off/ })
            .click();
          await check(`${label}: picking Off writes the toggle and the chip drops the word`, async () => {
            await page.waitForFunction(
              () =>
                !document
                  .querySelector('[data-composer-shortcut="composer.effort"]')
                  ?.textContent?.includes("Ultracode"),
            );
            NodeAssert.equal(await chip(), "Medium");
          });
        }
        if (scenario === "on" && wide) {
          await ultracodeGroup(menu).getByRole("menuitemradio", { name: /^Off/ }).click();
          await check(`${label}: turning Ultracode off keeps Medium`, async () => {
            await page.waitForFunction(
              () =>
                !document
                  .querySelector('[data-composer-shortcut="composer.effort"]')
                  ?.textContent?.includes("Ultracode"),
            );
            NodeAssert.equal(await chip(), "Medium");
          });
          await trigger.click();
          await page.getByRole("menu").waitFor();
          await ultracodeGroup(page.getByRole("menu"))
            .getByRole("menuitemradio", { name: /^On/ })
            .click();
          await check(`${label}: turning it back on returns the word`, async () => {
            await page.waitForFunction(() =>
              document
                .querySelector('[data-composer-shortcut="composer.effort"]')
                ?.textContent?.includes("Ultracode"),
            );
            NodeAssert.equal(await chip(), "Medium · Ultracode");
          });
        }
        await page.close();
      }
    }
  }
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`ultracode toggle ok: ${receipt.checks.length} checks; evidence in ${output}`);
} finally {
  await browser.close();
  server.close();
}
