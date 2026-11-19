// Build with vp build --config apps/web/tests/join-code-popup/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
// Usage: node apps/web/tests/join-code-popup/verify.mjs [screenshot dir] [site dir] [before|after]
// "before" only shoots the card and checks that it covers the project header.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/join-code-popup/evidence");
const root = NodePath.resolve(process.argv[3] ?? ".artifacts/join-code-popup/site");
const mode = process.argv[4] ?? "after";
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = NodePath.resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const entry = mode === "before" ? "/before/" : "/";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const receipt = { headless: true, mode, checks: [], screenshots: [] };
const shoot = async (page, name) => {
  const file = NodePath.join(output, `${mode}-${name}.png`);
  await page.screenshot({ path: file });
  receipt.screenshots.push(file);
};
/** Whether the project settings button is the topmost thing at its centre. */
const settingsReachable = (page) =>
  page.evaluate(() => {
    const button = document.querySelector("[data-project-settings]");
    const box = button.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return top === button || button.contains(top);
  });
try {
  for (const theme of ["light"]) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const size = `${theme}-${width}`;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}${entry}?theme=${theme}`);
      const card = page.locator("[data-device-waiting]");
      await card.waitFor();
      NodeAssert.match(await card.textContent(), /UN5MBB/);
      await shoot(page, `open-${size}`);
      if (mode === "before") {
        receipt.checks.push(
          `${size}: card at top ${Math.round((await card.boundingBox()).y)}px, project settings reachable: ${await settingsReachable(page)}, close button: ${await page.locator("[data-device-waiting-close]").count()}`,
        );
        await page.close();
        continue;
      }
      // Below the top bar: the project header and its settings stay in reach.
      const header = await page.locator("[data-project-header]").boundingBox();
      const box = await card.boundingBox();
      NodeAssert.ok(box.y >= header.y + header.height, `${size}: card starts under the header`);
      NodeAssert.equal(await settingsReachable(page), true, `${size}: settings reachable`);
      receipt.checks.push(
        `${size}: card top ${Math.round(box.y)}px under header bottom ${Math.round(header.y + header.height)}px; project settings reachable`,
      );
      // × closes it.
      await page.locator("[data-device-waiting-close]").click();
      NodeAssert.equal(await card.count(), 0);
      receipt.checks.push(`${size}: × closes the card`);
      if (width > 700) {
        // The sidebar row stays while the join is pending and opens the card again.
        const row = page.locator("[data-sidebar-join-code]");
        NodeAssert.match(await row.textContent(), /Waiting for PRCTY-AABYZOV/);
        await shoot(page, `closed-${size}`);
        await page.locator("[data-sidebar-join-code-show]").click();
        await card.waitFor();
        receipt.checks.push(`${size}: sidebar "Show code" opens it again`);
        // A click outside closes it.
        await page.locator(".fx-chat").click({ position: { x: 40, y: 400 } });
        NodeAssert.equal(await card.count(), 0);
        receipt.checks.push(`${size}: a click outside closes it`);
        await page.locator("[data-sidebar-join-code-show]").click();
        await card.waitFor();
      } else {
        await page.reload();
        await card.waitFor();
      }
      // Escape closes it.
      await page.keyboard.press("Escape");
      NodeAssert.equal(await card.count(), 0);
      receipt.checks.push(`${size}: Escape closes it`);
      // Settings > Machines shows the code, this device's ID and Copy; the floating card stays away.
      await page.goto(`${origin}/?theme=${theme}&scene=settings`);
      const section = page.locator("[data-waiting-join-codes]");
      await section.waitFor();
      NodeAssert.match(await section.textContent(), /UN5MBB/);
      NodeAssert.match(await section.textContent(), /This device's ID is R2DK/);
      NodeAssert.equal(await section.getByRole("button", { name: "Copy" }).count(), 1);
      await page.waitForTimeout(300);
      NodeAssert.equal(await card.count(), 0, `${size}: no floating card over Settings`);
      receipt.checks.push(`${size}: Settings > Machines shows code, device ID and Copy`);
      await shoot(page, `settings-${size}`);
      NodeAssert.deepEqual(errors, []);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, `${mode}-receipt.json`),
  JSON.stringify(receipt, null, 2),
);
console.log(JSON.stringify(receipt, null, 2));
