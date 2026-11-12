// Headless screenshots and checks of the first step of setup: node shoot-setup.mjs <site dir> <out dir>
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
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
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
const signIn = (page) => page.getByRole("button", { name: "Sign in", exact: true }).click();
const linked = (page) => page.getByText("This Mac is linked").waitFor();
const choose = async (page) => {
  await signIn(page);
  await linked(page);
  // The first machine listed stands for the main one.
  await page.getByRole("radio").first().check();
};
/** The frame every step shares: clear of the window's top strip, with the step's footer in view. */
const frameProblems = (page, height) =>
  page.evaluate((height) => {
    const found = [];
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const strip = rect('[data-slot="first-run-drag-strip"]');
    const popup = rect('[data-slot="dialog-popup"]');
    const footer = rect('[data-slot="wizard-step-footer"]');
    if (!strip || strip.top !== 0 || strip.height < 40) found.push("no drag strip at the top");
    else if (popup.top < strip.bottom) found.push(`dialog under the top strip (${popup.top})`);
    if (popup.bottom > height) found.push(`dialog below the window (${popup.bottom})`);
    if (!footer) found.push("no footer");
    else if (footer.bottom > height + 0.5) found.push(`footer out of view (${footer.bottom})`);
    if (
      footer &&
      document.querySelector('[data-slot="dialog-panel"] [data-slot="wizard-step-footer"]')
    )
      found.push("footer inside the scrolling panel");
    return found;
  }, height);
/** name, query, what the owner does first, and the one filled button the step then shows. */
const cases = [
  ["sign-in", "", null, "Sign in"],
  [
    "linking",
    "linkMs=600000",
    async (page) => {
      await signIn(page);
      await page.getByText("Linking this Mac…").waitFor();
    },
    null,
  ],
  [
    "choose",
    "",
    async (page) => {
      await signIn(page);
      await linked(page);
      await page.getByRole("radio").first().waitFor();
    },
    "Choose a machine",
  ],
  ["chosen", "", choose, /^Allow ./],
  [
    "joined",
    "",
    async (page) => {
      await choose(page);
      await page.getByRole("button", { name: /^Allow ./ }).click();
      await page.getByText("can run work here ·").waitFor();
      await page.getByText("can start work on this Mac").waitFor();
    },
    "Continue",
  ],
  [
    "link-failed",
    "setup=failed&linkMs=50",
    // Already signed in, as after a sign-in that reloaded the window.
    (page) => page.getByText("This Mac could not be linked").waitFor(),
    "Try again",
  ],
  [
    "link-retried",
    "setup=failed&linkMs=50",
    async (page) => {
      await page.getByRole("button", { name: "Try again" }).click();
      await linked(page);
    },
    "Choose a machine",
  ],
  ["connect-off", "setup=off", null, "Turn on SpecWithCode Connect"],
  ["first-machine", "setup=linked&machines=none", null, "Continue"],
];
const report = [];
const problems = [];
for (const theme of ["light", "dark"]) {
  for (const [width, height, label] of [
    [1120, 900, "1120"],
    // The smallest the desktop window gets.
    [840, 620, "840"],
    [390, 900, "390"],
  ]) {
    for (const [name, query, act, main] of cases) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/?view=setup&${query}${query ? "&" : ""}theme=${theme}`);
      await page.locator('[data-testid="sign-in-first-rows"]').waitFor();
      if (act) await act(page);
      await page.waitForTimeout(250);
      const entry = {
        name,
        theme,
        width,
        errors,
        horizontalOverflow: await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
        rows: await page
          .locator('[data-testid="sign-in-first-rows"] > li')
          .evaluateAll((rows) => rows.map((row) => [row.dataset.part, row.dataset.state])),
        // Filled buttons that can be pressed, and the one the card keeps until a machine is chosen.
        mainButtons: await page
          .locator("button")
          .evaluateAll((buttons) =>
            buttons
              .filter((button) => /(^|\s)bg-primary(\s|$)/.test(button.className))
              .map((button) => button.innerText.trim()),
          ),
        text: await page.locator("[role=dialog]").innerText(),
        calls: await page.evaluate(() => window.fixtureCalls.map((call) => call[0])),
      };
      report.push(entry);
      const asExpected =
        main === null
          ? entry.mainButtons.length === 0
          : entry.mainButtons.length === 1 &&
            (main instanceof RegExp
              ? main.test(entry.mainButtons[0])
              : main === entry.mainButtons[0]);
      if (!asExpected) {
        problems.push(
          `${name} ${theme} ${label}: main buttons ${JSON.stringify(entry.mainButtons)}`,
        );
      }
      if (entry.horizontalOverflow) problems.push(`${name} ${theme} ${label}: horizontal overflow`);
      for (const problem of await frameProblems(page, height)) {
        problems.push(`${name} ${theme} ${label}: ${problem}`);
      }
      if (errors.length) problems.push(`${name} ${theme} ${label}: ${errors.join("; ")}`);
      if (/Settings >/.test(entry.text) && name !== "joined") {
        problems.push(`${name} ${theme} ${label}: sends the owner to Settings`);
      }
      // Linking is asked for once per sign-in, and again only by the owner.
      const links = entry.calls.filter((call) => call === "link").length;
      const allowedLinks = {
        "sign-in": 0,
        "connect-off": 0,
        "first-machine": 0,
        "link-retried": 2,
      };
      if (links !== (allowedLinks[name] ?? 1)) {
        problems.push(`${name} ${theme} ${label}: ${links} link requests`);
      }
      await page.screenshot({
        path: NodePath.join(output, `setup-${name}-${label}-${theme}.png`),
        fullPage: true,
      });
      await context.close();
    }
  }
}
// The frame by itself, on a step longer than the window: footer parts, keys and button order.
const frame = [];
for (const [platform, enterKey] of [
  ["macos", "↵"],
  ["windows", "Enter"],
  ["linux", "Enter"],
]) {
  for (const theme of ["light", "dark"]) {
    const at = `frame ${platform} ${theme}`;
    const context = await browser.newContext({
      viewport: { width: 840, height: 620 },
      deviceScaleFactor: 2,
    });
    const open = async (query = "") => {
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(`${at}: ${error}`));
      await page.goto(`${origin}/?view=frame&platform=${platform}&theme=${theme}${query}`);
      await page.locator('[data-slot="wizard-step-footer"]').waitFor();
      await page.waitForTimeout(250);
      return page;
    };
    const fixtureCalls = (page) => page.evaluate(() => window.fixtureCalls.map((call) => call[0]));
    const check = (ok, text) => {
      if (!ok) problems.push(`${at}: ${text}`);
    };

    let page = await open();
    for (const problem of await frameProblems(page, 620)) problems.push(`${at}: ${problem}`);
    const state = await page.evaluate(() => {
      const left = (label) =>
        [...document.querySelectorAll('[data-slot="wizard-step-footer"] button')]
          .find((button) => button.textContent.trim() === label)
          ?.getBoundingClientRect().left;
      const panel = document.querySelector('[data-slot="dialog-panel"]');
      const primary = document.querySelector("[data-wizard-primary]");
      return {
        stages: [...document.querySelectorAll('[aria-label="Setup progress"] li')].map((item) =>
          item.innerText.replace(/^\d+\s*/, "").trim(),
        ),
        back: left("Back"),
        skip: left("Keep Supervised"),
        primary: left("Use Full access"),
        enterKey: primary.querySelector("kbd").dataset.key,
        keyShown: getComputedStyle(primary.querySelector("kbd"), "::before").content,
        focused: document.activeElement === primary,
        panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
        panelTop: panel.scrollTop,
        dragStrip: getComputedStyle(
          document.querySelector('[data-slot="first-run-drag-strip"]'),
        ).getPropertyValue("-webkit-app-region"),
        dialogDrags: getComputedStyle(
          document.querySelector('[data-slot="dialog-popup"]'),
        ).getPropertyValue("-webkit-app-region"),
      };
    });
    frame.push({ platform, theme, ...state });
    check(state.stages.join() === "Sign in,Agents,Projects", `stages ${state.stages}`);
    check(state.back < state.skip && state.back < state.primary, "Back is not on the left");
    // The default button is last on macOS and Linux and first on Windows.
    check(
      platform === "windows" ? state.primary < state.skip : state.skip < state.primary,
      `button order (skip ${state.skip}, primary ${state.primary})`,
    );
    check(state.enterKey === enterKey, `Enter key label ${state.enterKey}`);
    check(state.keyShown.includes(enterKey), `Enter key drawn as ${state.keyShown}`);
    check(state.focused, "the step did not open on its primary");
    check(state.panelScrolls, "the panel does not scroll");
    check(state.panelTop === 0, `the step opened scrolled to ${state.panelTop}`);
    await page.screenshot({ path: NodePath.join(output, `frame-${platform}-840-${theme}.png`) });

    // Enter from a field in the step presses the primary; a button keeps its own Enter.
    await page.getByLabel("Folder").focus();
    await page.keyboard.press("Enter");
    check((await fixtureCalls(page)).join() === "primary", "Enter in the step");
    await page.getByRole("button", { name: "Back" }).focus();
    await page.keyboard.press("Enter");
    check((await fixtureCalls(page)).join() === "primary,back", "Enter on Back");
    // Escape and the close button both leave setup.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Close setup" }).click();
    check((await fixtureCalls(page)).join() === "primary,back,leave,leave", "Escape and close");
    await page.close();

    // A fourth stage is one entry in the list.
    page = await open("&access=on");
    const stages = await page
      .locator('[aria-label="Setup progress"] li')
      .evaluateAll((items) => items.map((item) => item.innerText.replace(/^\d+\s*/, "").trim()));
    check(stages.join() === "Sign in,Agents,Access,Projects", `stages with Access ${stages}`);
    await page.close();

    // Where closing is off, Escape does nothing and there is no close button.
    page = await open("&close=off");
    await page.keyboard.press("Escape");
    check((await fixtureCalls(page)).length === 0, "Escape while closing is off");
    check(
      (await page.getByRole("button", { name: "Close setup" }).count()) === 0,
      "close button while closing is off",
    );
    await page.close();

    // A primary that fails: the step stays open, says so, and can be tried again.
    page = await open("&save=fails");
    await page.getByRole("button", { name: "Use Full access" }).click();
    await page.getByRole("status").filter({ hasText: "Saving." }).waitFor();
    check(
      await page.getByRole("button", { name: "Saving…" }).isDisabled(),
      "primary not off while saving",
    );
    await page.screenshot({ path: NodePath.join(output, `frame-${platform}-saving-${theme}.png`) });
    await page.getByRole("alert").filter({ hasText: "That was not saved" }).waitFor();
    check(
      await page.getByRole("button", { name: "Use Full access" }).isEnabled(),
      "primary not back after a failed save",
    );
    for (const problem of await frameProblems(page, 620)) problems.push(`${at} failed: ${problem}`);
    await page.screenshot({ path: NodePath.join(output, `frame-${platform}-failed-${theme}.png`) });
    await page.close();
    await context.close();
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "setup-report.json"),
  JSON.stringify({ problems, report, frame }, null, 2),
);
console.log(`${report.length} screenshots in ${output}`);
console.log(problems.length ? problems.join("\n") : "no problems");
process.exit(problems.length ? 1 : 0);
