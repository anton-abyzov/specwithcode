// Headless check and screenshots of the account modal's Machines page:
// node shoot.mjs <site dir> <out dir>
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const [site, output] = process.argv.slice(2).map((path) => NodePath.resolve(path));
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  try {
    const mime =
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html";
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": mime }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROME,
});
const cases = {
  list: {
    has: ["5 machines linked", "This machine", "Linked Oct 26, 2026"],
    hasNot: ["Deregister machine"],
  },
  confirm: { has: ["Deregister “minisforum”?", "Deregister machine", "Cancel"], hasNot: [] },
  "confirm-current": { has: ["This is the machine you are using now."], hasNot: [] },
  pending: { has: ["Deregistering…"], hasNot: ["Deregister machine"] },
  loading: { has: [], hasNot: ["No machines linked", "machines linked"] },
  empty: { has: ["No machines linked"], hasNot: ["5 machines linked"] },
  error: { has: ["Could not load your machines", "Try again"], hasNot: ["No machines linked"] },
  stale: { has: ["Could not load your machines", "5 machines linked"], hasNot: [] },
};
const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);
for (const [width, height] of [
  [900, 760],
  [390, 844],
]) {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    for (const [state, want] of Object.entries(cases)) {
      const where = `${state}/${theme}/${width}`;
      await page.goto(`${origin}/?state=${state}&theme=${theme}`);
      await page.getByRole("heading", { name: "Machines", level: 2 }).waitFor();
      await page.waitForTimeout(350);
      const text = await page.locator("main").innerText();
      for (const expected of want.has) {
        if (!text.includes(expected)) fail(where, `missing "${expected}"`);
      }
      for (const unexpected of want.hasNot) {
        if (text.includes(unexpected)) fail(where, `has "${unexpected}"`);
      }
      // Nothing may push the page sideways, long machine names included.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) fail(where, `page scrolls sideways by ${overflow}px`);
      if (state === "list") {
        // No machine name is cut short, at any width.
        const cut = await page
          .getByRole("heading", { level: 3 })
          .evaluateAll(
            (names) =>
              names.filter(
                (name) =>
                  name.scrollWidth > name.clientWidth || name.scrollHeight > name.clientHeight + 1,
              ).length,
          );
        if (cut > 0) fail(where, `${cut} machine names are cut short`);
        // This machine leads; every row's button says which machine it is for.
        const first = await page.getByRole("listitem").first().innerText();
        if (!first.includes("This machine")) fail(where, "this machine is not first");
        const names = await page
          .getByRole("button", { name: /^Deregister / })
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
        if (names.length !== 5 || new Set(names).size !== 5) {
          fail(where, `row buttons are not named one per machine: ${names.join(", ")}`);
        }
        // Every control is big enough to hit: 24 px is the WCAG 2.2 floor.
        const small = await page
          .getByRole("button")
          .evaluateAll(
            (buttons) =>
              buttons
                .map((button) => button.getBoundingClientRect())
                .filter((box) => box.width < 24 || box.height < 24).length,
          );
        if (small > 0) fail(where, `${small} buttons are smaller than 24 px`);
        // The keyboard reaches Refresh first, then each machine's button in order.
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
        if (focused !== "Refresh") fail(where, `first Tab stop is "${focused}"`);
        // Opening a row with the keyboard shows its confirmation; Cancel closes it.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await page.getByRole("group", { name: /^Confirm deregistration of / }).waitFor();
        const expanded = await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-expanded"),
        );
        if (expanded !== "true") fail(where, "the open row's button does not say it is expanded");
        await page.getByRole("button", { name: "Cancel" }).click();
        await page.waitForTimeout(300);
        if ((await page.getByRole("group").count()) > 0) fail(where, "Cancel left it open");
        await page.goto(`${origin}/?state=${state}&theme=${theme}`);
        await page.getByRole("heading", { name: "Machines", level: 2 }).waitFor();
        await page.waitForTimeout(350);
      }
      await page.screenshot({
        path: NodePath.join(output, `${state}-${theme}-${width}.png`),
        fullPage: true,
      });
    }
    await page.close();
  }
}
await browser.close();
server.close();
console.log(failures.length ? failures.join("\n") : "account machines page: all states pass");
process.exit(failures.length ? 1 : 0);
