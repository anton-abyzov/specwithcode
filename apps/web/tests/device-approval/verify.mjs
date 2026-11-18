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
// True when the top element at the centre of the first match is that element or inside it.
const uncovered = (page, selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return top !== null && (top === node || node.contains(top));
    });
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
        "Anton's iPhone is asking. It was paired through another of your machines.",
      );
      assert.match(await prompt.locator("[data-device-approval-row]").textContent(), /ID H4WN/);
      assert.equal(await prompt.getByRole("textbox").count(), 1);
      const allow = prompt.getByRole("button", { name: "Allow", exact: true });
      assert.equal(await allow.isDisabled(), true);
      assert.equal(await prompt.locator("[data-device-deny]").count(), 1);
      // The code box has focus as soon as the pop-up opens.
      await page.keyboard.type("k7q-x2m");
      assert.equal(await allow.isDisabled(), false);
      // Typed in lowercase, shown in capitals like the code on the device (1416).
      assert.equal(await prompt.getByRole("textbox").inputValue(), "K7Q-X2M");
      await shot(page, `popup-${theme}.png`);
      await allow.click();
      await page.waitForFunction(() =>
        document
          .querySelector("[data-fixture-log]")
          ?.getAttribute("data-fixture-log")
          ?.includes("approve"),
      );
      assert.equal(await log(page), "approve K7Q-X2M");
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "popup", ok: true });
      await page.close();
    }
    // A wrong code says why, in place.
    {
      const { page, errors } = await open("scene=prompt", theme, [1280, 800]);
      await page.locator("[data-device-approval-prompt]").waitFor();
      await page.keyboard.type("ABCDEF");
      await page.getByRole("button", { name: "Allow", exact: true }).click();
      await page.getByRole("alert").waitFor();
      assert.match(
        await page.getByRole("alert").textContent(),
        /No device is waiting with that code/,
      );
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "popup-wrong-code", ok: true });
      await page.close();
    }
    // Two phones of one name (1406): the typed code allows the phone that shows it,
    // the pop-up names it and keeps the other one listed.
    {
      const { page, errors } = await open("scene=two-phones", theme, [1280, 860]);
      const prompt = page.locator("[data-device-approval-prompt]");
      await prompt.waitFor();
      assert.equal(
        await prompt.getByRole("heading").first().textContent(),
        "2 devices want to use m4",
      );
      const rows = prompt.locator("[data-device-approval-row]");
      assert.equal(await rows.count(), 2);
      assert.match(await rows.nth(0).textContent(), /iPhone.*ID TSKR/);
      assert.match(await rows.nth(1).textContent(), /iPhone.*ID 9229/);
      assert.equal(await prompt.getByRole("textbox").count(), 1);
      assert.equal(await prompt.getByRole("button", { name: "Deny iPhone · ID 9229" }).count(), 1);
      await shot(page, `two-phones-${theme}.png`);
      // The owner reads the code off the second phone.
      await page.keyboard.type("p4r-t9w");
      await prompt.getByRole("button", { name: "Allow", exact: true }).click();
      const allowed = prompt.locator("[data-device-approval-allowed]");
      await allowed.waitFor();
      assert.equal(await allowed.textContent(), "Allowed iPhone · ID 9229. It can now use m4.");
      assert.equal(await rows.count(), 1);
      assert.match(await rows.first().textContent(), /ID TSKR/);
      assert.equal(await prompt.getByRole("textbox").inputValue(), "");
      assert.match(
        await prompt.locator("[data-device-approval-count]").textContent(),
        /^1 device waiting/,
      );
      assert.equal(await log(page), "approve request-phone-b");
      await shot(page, `two-phones-one-allowed-${theme}.png`);
      // The last one allowed: the pop-up closes by itself.
      await prompt.getByRole("textbox").fill("K7QX2M");
      await prompt.getByRole("button", { name: "Allow", exact: true }).click();
      await prompt.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "two-phones", ok: true });
      await page.close();
    }
    // A device waiting on three machines: one card, each machine's own code, and its ID.
    {
      const { page, errors } = await open("scene=waiting&machines=3", theme, [390, 844]);
      const card = page.locator("[data-device-waiting-list]");
      await card.waitFor();
      assert.equal(await card.locator("[data-device-waiting]").count(), 3);
      assert.deepEqual(await card.locator("[data-device-waiting-code]").allTextContents(), [
        "K7QX2M",
        "P4RT9W",
        "D8HJ3N",
      ]);
      assert.match(await card.locator("[data-own-device-id]").textContent(), /ID is 9229/);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert.ok(overflow <= 0, `no horizontal scroll (${overflow}px)`);
      await shot(page, `waiting-three-machines-${theme}.png`);
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "waiting-three-machines", ok: true });
      await page.close();
    }
    // 2. The waiting device: where to go, the code large, Copy.
    for (const size of [
      [390, 844],
      [1280, 800],
    ]) {
      const { page, errors } = await open("scene=waiting", theme, size);
      const card = page.locator("section[data-device-waiting]");
      await card.waitFor();
      assert.match(await card.locator("[data-own-device-id]").textContent(), /ID is 9229/);
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
      const waiting = section.locator("[data-connect-devices-waiting]");
      assert.match(await waiting.textContent(), /Waiting for approval/);
      assert.match(await waiting.textContent(), /ID H4WN/);
      assert.equal(await waiting.getByRole("button", { name: "Allow", exact: true }).count(), 1);
      assert.equal(await waiting.locator("[data-device-deny]").count(), 1);
      assert.equal(
        await section.locator("[data-connect-devices-allowed]").textContent(),
        "Allowed",
      );
      assert.match(await section.textContent(), /Kept by the update\. Check this list\./);
      assert.match(await section.textContent(), /Approved November 13, 2026 by this machine/);
      assert.equal(await section.getByRole("button", { name: "Remove" }).count(), 2);
      await shot(page, `device-list-${theme}.png`);
      await waiting.locator("[data-device-deny]").click();
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
    // 4. The joining Mac's setup dialog (1416): the waiting row shows its code, the machine and this device's ID.
    for (const size of [
      [1280, 800],
      [390, 844],
    ]) {
      const { page, errors } = await open("scene=join-dialog", theme, size);
      const row = page.locator('[data-fixture-row="m4"]');
      await row.waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      assert.match(await row.textContent(), /Waiting for approval/);
      assert.doesNotMatch(await row.textContent(), /Reconnecting/);
      const inline = row.locator("[data-inline-device-approval]");
      assert.equal(
        await inline.locator("[data-device-waiting-line]").textContent(),
        "Open SpecWithCode on Work Mac and type this code:",
      );
      assert.equal(await inline.locator("[data-device-waiting-code]").textContent(), "K7QX2M");
      assert.match(await inline.locator("[data-own-device-id]").textContent(), /ID is R2DK/);
      assert.equal(await inline.getByRole("button", { name: "Copy" }).count(), 1);
      assert.ok(
        await uncovered(page, '[data-fixture-row="m4"] [data-device-waiting-code]'),
        "the row's code is not covered",
      );
      await shot(page, `join-dialog-${theme}-${size[0]}.png`);
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "join-dialog", width: size[0], ok: true });
      await page.close();
    }
    // 5. Another machine's floating card stays above the open dialog and its backdrop (1416).
    {
      const { page, errors } = await open("scene=join-dialog&floating=1", theme, [1280, 800]);
      const card = page.locator("[data-fixture-floating] section[data-device-waiting]");
      await card.waitFor();
      await page.getByRole("dialog").waitFor();
      assert.equal(await card.locator("[data-device-waiting-code]").textContent(), "D8HJ3N");
      assert.ok(
        await uncovered(page, "[data-fixture-floating] [data-device-waiting-code]"),
        "the floating code is above the dialog",
      );
      assert.ok(
        await uncovered(page, "[data-fixture-floating] button"),
        "the floating Copy button can be pressed",
      );
      assert.ok(
        await uncovered(page, '[data-fixture-row="m4"] [data-device-waiting-code]'),
        "the row's code is still readable",
      );
      await shot(page, `join-dialog-floating-${theme}.png`);
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, scene: "join-dialog-floating", ok: true });
      await page.close();
    }
    // The same card in the dialog's own layer, as before 1416, is covered: the check sees the bug.
    {
      const { page } = await open("scene=join-dialog&floating=1&layer=old", theme, [1280, 800]);
      await page.locator("[data-fixture-floating] [data-device-waiting-code]").waitFor();
      await page.getByRole("dialog").waitFor();
      assert.equal(
        await uncovered(page, "[data-fixture-floating] [data-device-waiting-code]"),
        false,
        "the old layer is covered by the dialog's backdrop",
      );
      await shot(page, `join-dialog-floating-old-layer-${theme}.png`);
      receipt.checks.push({
        theme,
        scene: "join-dialog-floating-old-layer",
        covered: true,
        ok: true,
      });
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
