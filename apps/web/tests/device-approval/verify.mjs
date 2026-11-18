// Build with vp build --config apps/web/tests/device-approval/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
// Usage: node apps/web/tests/device-approval/verify.mjs [screenshot dir]
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/device-approval/site");
const output = path.resolve(process.argv[2] ?? ".artifacts/device-approval/evidence");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const receipt = { headless: true, checks: [], screenshots: [] };
const open = async (query, theme, [width, height]) => {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?theme=${theme}&${query}`);
  return { page, errors };
};
const shot = async (page, name) => {
  const file = path.join(output, name);
  await page.screenshot({ path: file });
  receipt.screenshots.push(file);
};
const log = (page) => page.locator("[data-fixture-log]").getAttribute("data-fixture-log");
try {
  for (const theme of ["light", "dark"]) {
    // 1. The pop-up on the machine: who asks, what Allow does, one code box, Allow and Deny.
    {
      const { page, errors } = await open("scene=prompt", theme, [1280, 800]);
      const prompt = page.locator("[data-device-approval-prompt]");
      await prompt.waitFor();
      assert.equal(
        await prompt.getByRole("heading").first().textContent(),
        "A new device wants to use m4",
      );
      assert.equal(
        await prompt.locator("[data-device-approval-line]").textContent(),
        "Anton's iPhone (phone) is asking. Allow lets it use m4 like this app does.",
      );
      assert.equal(await prompt.getByRole("textbox").count(), 1);
      const allow = prompt.getByRole("button", { name: "Allow" });
      assert.equal(await allow.isDisabled(), true);
      assert.equal(await prompt.getByRole("button", { name: "Deny" }).count(), 1);
      // The code box has focus as soon as the pop-up opens.
      await page.keyboard.type("k7q-x2m");
      assert.equal(await allow.isDisabled(), false);
      await shot(page, `popup-${theme}.png`);
      await allow.click();
      await page.waitForFunction(() =>
        document
          .querySelector("[data-fixture-log]")
          ?.getAttribute("data-fixture-log")
          ?.includes("approve"),
      );
      assert.equal(await log(page), "approve k7q-x2m");
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "popup", ok: true });
      await page.close();
    }
    // A wrong code says why, in place.
    {
      const { page, errors } = await open("scene=prompt", theme, [1280, 800]);
      await page.locator("[data-device-approval-prompt]").waitFor();
      await page.keyboard.type("ABCDEF");
      await page.getByRole("button", { name: "Allow" }).click();
      await page.getByRole("alert").waitFor();
      assert.match(
        await page.getByRole("alert").textContent(),
        /No device is waiting with that code/,
      );
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "popup-wrong-code", ok: true });
      await page.close();
    }
    // 2. The waiting device: where to go, the code large, Copy.
    for (const size of [
      [390, 844],
      [1280, 800],
    ]) {
      const { page, errors } = await open("scene=waiting", theme, size);
      const card = page.locator("[data-device-waiting]");
      await card.waitFor();
      assert.equal(
        await card.locator("[data-device-waiting-line]").textContent(),
        "Open SpecWithCode on m4 and type this code:",
      );
      assert.equal(await card.locator("[data-device-waiting-code]").textContent(), "K7QX2M");
      const fontSize = await card
        .locator("[data-device-waiting-code]")
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
      assert.ok(fontSize >= 28, `code is large (${fontSize}px)`);
      assert.equal(await card.getByRole("button", { name: "Copy" }).count(), 1);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert.ok(overflow <= 0, `no horizontal scroll (${overflow}px)`);
      await shot(page, `waiting-${theme}-${size[0]}.png`);
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "waiting", width: size[0], ok: true });
      await page.close();
    }
    // 3. Settings > Machines > Devices that can use this machine.
    {
      const { page, errors } = await open("scene=list", theme, [1280, 900]);
      const section = page.locator("#connect-devices");
      await section.waitFor();
      assert.match(await section.textContent(), /Devices that can use this machine/);
      assert.equal(
        await section.locator("[data-connect-devices-waiting-count]").textContent(),
        "1 device waiting",
      );
      const waiting = section.locator("[data-connect-device-waiting]");
      assert.equal(await waiting.getByRole("button", { name: "Allow" }).count(), 1);
      assert.equal(await waiting.getByRole("button", { name: "Deny" }).count(), 1);
      assert.match(await section.textContent(), /Kept by the update\. Check this list\./);
      assert.match(await section.textContent(), /Approved November 13, 2026 by this machine/);
      assert.equal(await section.getByRole("button", { name: "Remove" }).count(), 2);
      await shot(page, `device-list-${theme}.png`);
      await waiting.getByRole("button", { name: "Deny" }).click();
      await section
        .locator("[data-connect-device]")
        .first()
        .getByRole("button", { name: "Remove" })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("[data-fixture-log]")
          ?.getAttribute("data-fixture-log")
          ?.includes("remove"),
      );
      assert.equal(await log(page), "deny request-iphone|remove jkt:macbook");
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "device-list", ok: true });
      await page.close();
    }
  }
  // An older machine says it does not ask yet (AC-08).
  {
    const { page, errors } = await open("scene=list&supported=no", "light", [1280, 400]);
    await page.locator("#connect-devices").waitFor();
    assert.match(
      await page.locator("#connect-devices").textContent(),
      /This machine does not ask before new devices connect yet/,
    );
    await shot(page, "device-list-older-machine.png");
    assert.deepEqual(errors, []);
    receipt.checks.push({ scene: "older-machine", ok: true });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt.checks));
