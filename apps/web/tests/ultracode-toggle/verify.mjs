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
try {
  for (const theme of ["light", "dark"]) {
    for (const scenario of ["on", "off", "legacy"]) {
      const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
      await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
      await page.waitForSelector("body[data-fixture-ready]");
      const trigger = page.locator('[data-composer-shortcut="composer.effort"]').first();
      await trigger.waitFor();
      const chip = async () => (await trigger.innerText()).replace(/\s+/g, " ").trim();
      const name = async () => (await trigger.getAttribute("aria-label")) ?? "";
      if (scenario === "on")
        await check(`${theme} on: chip reads Medium · Ultracode`, async () => {
          NodeAssert.equal(await chip(), "Medium · Ultracode");
          NodeAssert.equal(await name(), "Medium effort · Ultracode");
        });
      if (scenario === "off")
        await check(`${theme} off: chip reads Medium alone`, async () => {
          NodeAssert.equal(await chip(), "Medium");
        });
      if (scenario === "legacy")
        await check(
          `${theme} legacy: saved Ultracode effort reads Extra High · Ultracode`,
          async () => {
            NodeAssert.equal(await chip(), "Extra High · Ultracode");
          },
        );
      await settle();
      await shot(page, `composer-${scenario}-${theme}.png`);
      if (scenario === "off") {
        await trigger.click();
        const menu = page.getByRole("menu");
        await menu.waitFor();
        await check(`${theme} off: an unset toggle marks neither choice and says why`, async () => {
          NodeAssert.match(await menu.innerText(), /Not set: follows the Claude workflow mode/);
          const group = menu.locator("[role=group]").filter({ hasText: "Ultracode" });
          NodeAssert.equal(await group.locator("[data-checked]").count(), 0);
        });
        await settle();
        await shot(page, `menu-unset-${theme}.png`);
      }
      if (scenario === "on") {
        await trigger.click();
        const menu = page.getByRole("menu");
        await menu.waitFor();
        await check(`${theme}: menu offers Ultracode beside effort, not inside it`, async () => {
          const text = (await menu.innerText()).replace(/\s+/g, " ");
          NodeAssert.match(text, /Ultracode Multi-agent workflows on every task, at any effort/);
          NodeAssert.equal(await menu.getByRole("menuitemradio", { name: "Ultracode" }).count(), 0);
        });
        await settle();
        await shot(page, `menu-${theme}.png`);
        const group = menu.locator("[role=group]").filter({ hasText: "Ultracode" });
        await group.getByRole("menuitemradio", { name: "Off" }).click();
        await check(`${theme}: turning Ultracode off keeps Medium`, async () => {
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
        await page
          .getByRole("menu")
          .locator("[role=group]")
          .filter({ hasText: "Ultracode" })
          .getByRole("menuitemradio", { name: "On" })
          .click();
        await check(`${theme}: turning it back on returns the word`, async () => {
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
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`ultracode toggle ok: ${receipt.checks.length} checks; evidence in ${output}`);
} finally {
  await browser.close();
  server.close();
}
