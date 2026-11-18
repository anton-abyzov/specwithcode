// Headless check of the first-run Access step in its real frame, every state of
// its rows, and the composer's chip callout, in light and dark at 1280 and 390
// px. Checks sideways scroll, where focus starts, that Enter leaves without an
// answer, both answers, a failed save, and each row's states. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/access-recommendation/vite.config.ts
//   node apps/web/tests/access-recommendation/verify.mjs /absolute/owned/report-dir
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(
  process.env.ACCESS_RECOMMENDATION_SITE ?? ".artifacts/access-recommendation/site",
);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/access-recommendation/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    res
      .writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" })
      .end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const problems = [];
const report = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const calls = (page) => page.evaluate(() => window.fixtureCalls.map((call) => call[0]));
const focused = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
/** Nothing off the side, and the named box inside the window. */
const layout = (page, selector) =>
  page.evaluate((selector) => {
    const found = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push(`sideways scroll (${root.scrollWidth})`);
    const box = document.querySelector(selector)?.getBoundingClientRect();
    if (!box) found.push(`no ${selector}`);
    else if (box.left < 0 || box.right > root.clientWidth + 0.5)
      found.push(`${selector} off the side (${Math.round(box.left)}..${Math.round(box.right)})`);
    return found;
  }, selector);

for (const theme of ["light", "dark"]) {
  for (const [width, height] of [
    [1280, 860],
    [390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();
    const open = async (query) => {
      await page.goto(`${origin}/?theme=${theme}&${query}`);
      await page.waitForLoadState("networkidle");
    };
    const at = `${theme} ${width}`;

    // The Access step: a list of rows, and Continue grants nothing.
    const shot = (name) =>
      page.screenshot({ path: NodePath.join(output, `${name}-${theme}-${width}.png`) });
    // Shots wait for an opening body to finish moving.
    const settled = () =>
      page.waitForFunction(() =>
        document.getAnimations().every((animation) => animation.playState !== "running"),
      );
    const rowShot = async (row, name) => {
      await settled();
      await page.waitForTimeout(100);
      await page
        .locator(`[data-access-row="${row}"]`)
        .screenshot({ path: NodePath.join(output, `${name}-${theme}-${width}.png`) });
    };
    const ready = async (query) => {
      await open(`view=wizard&${query}`);
      await page.getByRole("heading", { name: "What agents can use on this Mac" }).waitFor();
      await page.waitForTimeout(250);
    };
    await ready("");
    for (const problem of await layout(page, '[data-slot="dialog-popup"]'))
      fail(`wizard ${at}`, problem);
    if ((await focused(page)) !== "Continue")
      fail(`wizard ${at}`, `focus starts on "${await focused(page)}"`);
    for (const text of [
      "Full access: agents edit and run without asking each time.",
      "Agents use only the Chrome profiles you pair, and only while they are paired.",
      "Agents see the screen and click and type in any app.",
      "Full Disk Access for agents (optional)",
      ...(width >= 640 ? ["Continue changes nothing."] : []),
    ])
      if (!(await page.getByText(text, { exact: false }).first().isVisible()))
        fail(`wizard ${at}`, `missing "${text}"`);
    const rowOrder = await page.evaluate(() =>
      [...document.querySelectorAll("[data-access-row]")].map((row) =>
        row.getAttribute("data-access-row"),
      ),
    );
    if (rowOrder.join() !== "files,browser,mac-apps,full-disk-access")
      fail(`wizard ${at}`, `rows ${rowOrder.join()}`);
    if ((await page.locator("[data-wizard-neutral]").count()) !== 1)
      fail(`wizard ${at}`, "Continue is not the one neutral control");
    await shot("access");
    // Everything set up: the picture draws a thread to each row that is done.
    await ready("files=before-accepted&chrome=paired&mac=allowed");
    await settled();
    await shot("access-done");
    await ready("");
    // Enter goes on and answers nothing.
    await page.keyboard.press("Enter");
    await page.locator('[data-fixture-done="none"]').waitFor();
    if ((await calls(page)).join() !== "continue")
      fail(`wizard ${at}`, `Enter called ${await calls(page)}`);

    // Files and commands: an answer stays on the step, and focus goes to Change.
    await ready("");
    await page.getByRole("button", { name: "Use Full access" }).click();
    await page.locator('[data-access-row="files"] [data-slot="access-row-chip"]').waitFor();
    if (await page.locator("[data-fixture-done]").count())
      fail(`wizard ${at}`, "an answer left the step");
    if ((await focused(page)) !== "Change")
      fail(`wizard ${at}`, `focus after an answer is on "${await focused(page)}"`);
    await rowShot("files", "files-accepted");
    await ready("");
    await page.getByRole("button", { name: /^Keep/ }).click();
    await page.locator('[data-access-row="files"] [data-slot="access-row-chip"]').waitFor();
    if ((await calls(page)).includes("accept")) fail(`wizard ${at}`, "Keep accepted");
    await rowShot("files", "files-kept");
    await ready("save=fails");
    await page.getByRole("button", { name: "Use Full access" }).click();
    await page.getByRole("alert").waitFor();
    if (await page.locator("[data-fixture-done]").count())
      fail(`wizard ${at}`, "left the step after a failed save");
    await rowShot("files", "files-failed");
    await ready("files=before-accepted");
    if (!(await page.locator('[data-access-row="files"]').innerText()).includes("Settings"))
      fail(`wizard ${at}`, "an earlier answer does not say where it lives");
    await rowShot("files", "files-before");

    // Your browser: every state the row can be in.
    for (const kind of [
      "not-set-up",
      "loading",
      "offline",
      "team-rules",
      "not-allowed",
      "chrome-missing",
      "waiting",
      "paired",
      "paired-many",
      "not-answering",
      "approval",
    ]) {
      await ready(`chrome=${kind}`);
      const shown = await page
        .locator('[data-access-row="browser"] [data-chrome-state]')
        .getAttribute("data-chrome-state");
      if (shown !== (kind === "paired-many" ? "paired" : kind))
        fail(`chrome ${kind} ${at}`, `drew ${shown}`);
      await rowShot("browser", `chrome-${kind}`);
    }
    // Set up: the copy path, where the code is copied without being shown.
    await ready("chrome=not-set-up");
    await page.getByRole("button", { name: "Set up", exact: true }).click();
    await page.getByRole("button", { name: "Copy code" }).click();
    await page.getByText("Waiting for Chrome…").waitFor();
    if (await page.getByText("K7QX-2MZD-94HF").count())
      fail(`chrome copy ${at}`, "Copy showed the code");
    if (
      !(await page
        .getByText("It opens in the Chrome profile you used last.", { exact: false })
        .isVisible())
    )
      fail(`chrome copy ${at}`, "no sentence on which profile the store link opens in");
    for (const problem of await layout(page, '[data-access-row="browser"]'))
      fail(`chrome copy ${at}`, problem);
    await rowShot("browser", "chrome-setup-copied");
    await page.getByRole("button", { name: "Show", exact: true }).click();
    if (!(await page.getByLabel("Pairing code").isVisible()))
      fail(`chrome show ${at}`, "Show did not reveal the code");
    await rowShot("browser", "chrome-setup-shown");
    // Where the desktop app lists Chrome's profiles, the store opens in the one picked.
    await ready("chrome=not-set-up&profiles=3");
    await page.getByRole("button", { name: "Set up", exact: true }).click();
    await page.getByRole("radio", { name: "Work" }).click();
    await page.getByRole("button", { name: "Add to Chrome" }).click();
    const added = await page.evaluate(() =>
      window.fixtureCalls.find((call) => call[0] === "add-to-chrome"),
    );
    if (added?.[1] !== "Profile 1") fail(`chrome profiles ${at}`, `opened in ${added?.[1]}`);
    await rowShot("browser", "chrome-setup-profiles");

    // Mac apps: every state, and Allow opens the existing checklist.
    for (const kind of ["not-allowed", "partly", "needs-reopening", "could-not-check", "allowed"]) {
      await ready(`mac=${kind}`);
      const shown = await page.locator("[data-mac-apps-state]").getAttribute("data-mac-apps-state");
      if (shown !== kind) fail(`mac ${kind} ${at}`, `drew ${shown}`);
      await rowShot("mac-apps", `mac-${kind}`);
    }
    await ready("mac=not-allowed");
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await page.getByRole("list", { name: "macOS permissions" }).waitFor();
    await rowShot("mac-apps", "mac-open");
    await ready("mac=needs-reopening");
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await page.getByRole("button", { name: "Quit & Reopen" }).waitFor();
    await rowShot("mac-apps", "mac-reopen");
    // One row open at a time.
    await page.getByRole("button", { name: "Set up", exact: true }).click();
    if (await page.getByRole("button", { name: "Quit & Reopen" }).isVisible())
      fail(`rows ${at}`, "two rows open at once");
    await shot("access-chrome-open");

    // The composer's chip and callout.
    await open("view=composer");
    await page.getByText("Recommended: Full access").waitFor();
    await page.waitForTimeout(300);
    for (const problem of await layout(page, '[data-slot="popover-popup"]'))
      fail(`composer ${at}`, problem);
    if ((await focused(page)) !== "Switch to Full access")
      fail(`composer ${at}`, `focus starts on "${await focused(page)}"`);
    if (!(await page.locator("[data-access-recommended]").isVisible()))
      fail(`composer ${at}`, "chip not highlighted");
    await page.screenshot({ path: NodePath.join(output, `composer-${theme}-${width}.png`) });
    await page.keyboard.press("Enter");
    await page.locator('[data-runtime-mode="full-access"]').waitFor();
    if (await page.locator("[data-access-recommended]").count())
      fail(`composer ${at}`, "still highlighted after Switch");
    await page.screenshot({
      path: NodePath.join(output, `composer-accepted-${theme}-${width}.png`),
    });
    // Escape declines, as Keep Supervised and the close button do.
    await open("view=composer");
    await page.getByText("Recommended: Full access").waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("Recommended: Full access").waitFor({ state: "hidden" });
    if ((await calls(page)).join() !== "decline") fail(`composer ${at}`, "Escape did not decline");
    await open("view=composer");
    await page.getByRole("button", { name: "Close" }).click();
    if ((await calls(page)).join() !== "decline") fail(`composer ${at}`, "Close did not decline");
    await open("view=composer&save=fails");
    await page.getByRole("button", { name: "Switch to Full access" }).click();
    await page.getByRole("alert").waitFor();
    if (!(await page.getByText("Recommended: Full access").isVisible()))
      fail(`composer ${at}`, "callout closed after a failed save");
    await page.screenshot({ path: NodePath.join(output, `composer-failed-${theme}-${width}.png`) });
    report.push({ theme, width, height });
    await context.close();
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  `${JSON.stringify({ checked: report, problems }, null, 2)}\n`,
);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `Access step and recommendation: ${report.length} layouts checked, no problems. ${output}`,
);
