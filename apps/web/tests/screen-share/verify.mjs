// Build with vp build --config apps/web/tests/screen-share/vite.config.ts first.
// Usage: node apps/web/tests/screen-share/verify.mjs /absolute/owned/report-dir
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Headless only.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/screen-share/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/screen-share/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
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
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const receipt = { headless: true, checks: [], screenshots: [] };
const check = (name) => receipt.checks.push(name);
const CONFIRM_CODE = 19;
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const tag = `${theme}-${width}`;
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      const at = (id) => page.locator(`[data-case="${id}"]`);
      await at("settings").locator("[data-screen-share-settings]").waitFor();

      // This machine: on, one device always allowed, four sessions, nothing to fix.
      const settings = at("settings");
      const toggle = settings.locator("[data-screen-share-switch]");
      NodeAssert.equal(await toggle.getAttribute("aria-checked"), "true");
      NodeAssert.equal(await settings.locator("[data-screen-share-grant]").count(), 1);
      NodeAssert.match(
        await settings.locator("[data-screen-share-grant]").innerText(),
        /Work laptop/,
      );
      NodeAssert.match(await settings.locator("[data-screen-share-grant]").innerText(), /7F3A/);
      NodeAssert.equal(await settings.locator("[data-screen-share-session]").count(), 4);
      NodeAssert.equal(await settings.locator('[data-screen-share-session="refused"]').count(), 1);
      NodeAssert.match(
        await settings.locator('[data-screen-share-session="refused"]').innerText(),
        /Not shown[\s\S]*nobody answered/,
      );
      NodeAssert.equal(await settings.locator("[data-screen-share-notice]").count(), 0);
      NodeAssert.match(
        await settings.innerText(),
        /Turning it on asks for Touch ID or your password/,
      );
      check(`${tag}: settings show the switch, the allowed device and the sessions`);

      // With things to fix: three notices and who is viewing.
      const notices = at("notices");
      NodeAssert.equal(await notices.locator("[data-screen-share-notice]").count(), 3);
      NodeAssert.match(
        await notices.innerText(),
        /Another program holds this machine's screen sharing link/,
      );
      NodeAssert.match(await notices.innerText(), /could not be read/);
      NodeAssert.match(await notices.innerText(), /not allowed to record this screen/);
      NodeAssert.match(
        await notices.locator("[data-screen-share-active]").innerText(),
        /Work laptop is viewing this screen/,
      );
      check(`${tag}: a taken link, a missing permission and an unreadable store are each said`);

      // Anywhere but at the machine: one sentence, no control.
      const elsewhere = at("elsewhere");
      NodeAssert.match(await elsewhere.innerText(), /Turn this on at that machine\./);
      NodeAssert.equal(await elsewhere.locator("button, [role=switch]").count(), 0);
      check(`${tag}: away from the machine there is no switch`);

      // Waiting: words, no picture, a way out.
      const waiting = at("waiting");
      NodeAssert.match(
        await waiting.locator("[data-screen-message]").innerText(),
        /Waiting for someone at Mac Studio to allow it/,
      );
      NodeAssert.equal(await waiting.locator("[data-screen-picture]").isVisible(), false);
      NodeAssert.equal(await waiting.getByRole("button", { name: "Cancel" }).count(), 1);

      // The code: a wrong one is not sent, the right one is.
      const code = at("code");
      const field = code.getByRole("textbox");
      await field.fill("000000");
      await code.getByRole("button", { name: "Continue" }).click();
      await code.getByText("That is not the code. 2 tries left.").waitFor();
      NodeAssert.deepEqual(await page.evaluate(() => window.__sent), []);
      NodeAssert.equal(await code.locator("[data-screen-picture]").isVisible(), false);
      await field.fill("482 913");
      NodeAssert.equal(await field.inputValue(), "482913");
      await code.getByRole("button", { name: "Continue" }).click();
      await code.getByText("Checking the code with Mac Studio…").waitFor();
      NodeAssert.deepEqual(await page.evaluate(() => window.__sent), [
        { type: CONFIRM_CODE, code: "482913" },
      ]);
      check(`${tag}: a wrong code stays on the device; the right one is sent once`);

      // Live: the picture, that it is view only, the time left, the displays, End.
      const live = at("live");
      const picture = live.locator("[data-screen-picture]");
      await picture.waitFor({ state: "visible" });
      NodeAssert.equal(await picture.evaluate((canvas) => canvas.width), 1280);
      const painted = await picture.evaluate((canvas) => {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        const seen = new Set();
        for (let index = 0; index < data.length; index += 4 * 997)
          seen.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
        return seen.size;
      });
      NodeAssert.ok(painted > 20, "the picture is not blank");
      NodeAssert.equal(await live.locator("[data-screen-status]").innerText(), "Live, view only");
      NodeAssert.match(
        await live.locator("[data-screen-time-left]").innerText(),
        /Ends in 1 h 59 min/,
      );
      NodeAssert.equal(await live.locator("[data-screen-displays] [role=radio]").count(), 2);
      NodeAssert.equal(
        await live.locator('[data-screen-displays] [aria-checked="true"]').innerText(),
        "Built-in display",
      );
      NodeAssert.equal(await live.locator("[data-screen-message]").count(), 0);
      const box = await picture.boundingBox();
      const frame = await live.locator("[data-screen-viewer]").boundingBox();
      NodeAssert.ok(box.width <= frame.width + 1 && box.height <= frame.height, "the picture fits");
      check(`${tag}: live shows the picture inside its frame with status, time and displays`);

      // Locked, another key, sharing off: each says what it is.
      NodeAssert.match(await at("locked").innerText(), /Mac Studio is locked/);
      NodeAssert.equal(await at("locked").locator("[data-screen-status]").innerText(), "Locked");
      const changed = at("key-changed");
      NodeAssert.match(await changed.innerText(), /This is not the key Mac Studio used before/);
      NodeAssert.match(await changed.innerText(), /Nothing was shown/);
      NodeAssert.equal(
        await changed.getByRole("button", { name: "View again", exact: true }).count(),
        0,
      );
      await changed.getByRole("button", { name: "Forget saved key and view again" }).click();
      NodeAssert.ok((await page.evaluate(() => window.__calls)).includes("forget-key"));
      NodeAssert.match(await at("off").innerText(), /Screen sharing is off on Mac Studio/);
      NodeAssert.match(await at("off").innerText(), /only be turned on at that machine/);
      NodeAssert.equal(await at("off").getByRole("button", { name: "View again" }).count(), 1);
      check(`${tag}: locked, a changed key and sharing off are told apart`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      NodeAssert.equal(overflow, false, "no horizontal scroll");
      const shoot = async (name, locator) => {
        const file = NodePath.join(output, `${name}-${tag}.png`);
        await (locator ?? page).screenshot(
          locator ? { path: file } : { path: file, fullPage: true },
        );
        receipt.screenshots.push(file);
      };
      await shoot("screen-share-all");
      if (width === 1280) {
        await shoot("screen-share-settings", settings);
        await shoot("screen-share-viewer-live", live);
        await shoot("screen-share-viewer-code", code);
      }

      // The controls do what they say: Remove drops the device, the switch turns off.
      await settings.getByRole("button", { name: "Remove" }).click();
      await settings.getByText("None. Each device asks at this machine").waitFor();
      await toggle.click();
      NodeAssert.equal(await toggle.getAttribute("aria-checked"), "false");
      NodeAssert.deepEqual(
        (await page.evaluate(() => window.__calls)).filter((call) => !call.startsWith("forget")),
        ["remove:thumb-laptop", "enabled:false"],
      );
      check(`${tag}: Remove and the switch call this machine's app`);

      NodeAssert.deepEqual(errors, []);
      await page.close();
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  server.close();
}
