// Headless walk of first-run setup on clean state, at desktop and phone widths.
// Start a server first: an empty HOME and a new --base-dir, never a live store.
// usage: node walk.mjs <origin> <token> <out dir> <playwright-core path>
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const [origin, token, output, playwrightPath] = process.argv.slice(2);
const { chromium } = NodeModule.createRequire(import.meta.url)(playwrightPath);
NodeFS.mkdirSync(output, { recursive: true });

const session = await fetch(`${origin}/api/auth/browser-session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential: token }),
});
if (!session.ok) throw new Error(`Session request failed: HTTP ${session.status}`);
const [cookieName, ...cookieValue] = (session.headers.get("set-cookie") ?? "")
  .split(";")[0]
  .split("=");

const browser = await chromium.launch({ headless: true });
const report = [];
for (const [label, width, height, mobile] of [
  ["desktop", 1280, 800, false],
  ["phone", 390, 844, true],
]) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    hasTouch: mobile,
    isMobile: mobile,
    colorScheme: "dark",
  });
  await context.addCookies([{ name: cookieName, value: cookieValue.join("="), url: origin }]);
  const page = await context.newPage();
  const capture = async (name) => {
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: `${output}/${label}-${name}.png` });
    report.push({
      label,
      name,
      text: await page.evaluate(() =>
        (document.querySelector("[data-slot=dialog-popup]") ?? document.body).innerText.slice(
          0,
          1_400,
        ),
      ),
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    });
  };
  const click = (name) => page.getByRole("button", { name }).first().click({ timeout: 10_000 });
  await page.goto(`${origin}/welcome`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4_000);
  await capture("2-computers");
  await click(/^Continue$/);
  await page.waitForTimeout(6_000);
  await capture("3-agents");
  await click(/^Continue( without an agent)?$/);
  await page.waitForTimeout(3_000);
  await capture("4-projects");
  await click(/Do not import/);
  await page.waitForTimeout(4_000);
  await capture("5-overview");
  await context.close();
}
await browser.close();
NodeFS.writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 1));
const overflowing = report.filter((entry) => entry.overflow);
if (overflowing.length > 0) {
  throw new Error(
    `Horizontal overflow: ${overflowing.map((e) => `${e.label} ${e.name}`).join(", ")}`,
  );
}
console.log(`${report.length} captures, no horizontal overflow: ${output}`);
