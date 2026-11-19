// Headless check of the advisor's surfaces: the Advisor section in Settings >
// Models and in the project dialog, the composer's Advisor row (with its note
// for a Fable thread, an Opus thread and pass-through) and the timeline
// consult rows, in light and dark at 1280 and 390 px. Always headless; serves
// the fixture only and aborts every other request. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/advisor/vite.config.ts
//   node apps/web/tests/advisor/verify.mjs /absolute/owned/report-dir
// Optional: STUDIO_PLAYWRIGHT_MODULE (a playwright-core entry), STUDIO_TEST_CHROMIUM.
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
const site = NodePath.resolve(process.env.ADVISOR_FIXTURE_SITE ?? ".artifacts/advisor/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/advisor/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    // Read first: a missing file must answer 404, not fail after a 200 header.
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" }).end(body);
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
const screenshots = [];
const report = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const calls = (page) => page.evaluate(() => window.fixtureCalls);

/** Nothing scrolls sideways, and every match of the selector stays inside the window. */
const layout = (page, selector) =>
  page.evaluate((selector) => {
    const found = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push(`sideways scroll (${root.scrollWidth})`);
    const boxes = [...document.querySelectorAll(selector)];
    if (boxes.length === 0) found.push(`no ${selector}`);
    for (const element of boxes) {
      const box = element.getBoundingClientRect();
      if (box.left < -0.5 || box.right > root.clientWidth + 0.5)
        found.push(`${selector} off the side (${Math.round(box.left)}..${Math.round(box.right)})`);
    }
    return found;
  }, selector);

/** Content its box cuts off: hidden or clipped overflow, or an ellipsis, narrower than what it holds. */
const clipped = (page, selector) =>
  page.evaluate((selector) => {
    const found = [];
    for (const element of document.querySelectorAll(`${selector} *`)) {
      if (!element.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      const cuts =
        style.overflowX === "hidden" ||
        style.overflowX === "clip" ||
        style.textOverflow === "ellipsis";
      if (cuts && element.scrollWidth > element.clientWidth + 1)
        found.push(`clipped "${element.textContent.trim().slice(0, 40)}"`);
    }
    return found;
  }, selector);

/** Hides any toast: the toast roots hold the app's toast-description and toast-icon slots. */
const hideToasts = (page) =>
  page.evaluate(() => {
    for (const part of document.querySelectorAll('[data-slot^="toast-"]')) {
      const root = part.closest(".dropdown-glass") ?? part.parentElement;
      if (root) root.style.setProperty("display", "none", "important");
    }
  });

async function expectText(page, where, texts) {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: true }).first();
    if (!(await locator.isVisible().catch(() => false))) fail(where, `missing "${text}"`);
  }
}

async function shot(page, name) {
  await hideToasts(page);
  await page.waitForTimeout(150);
  const path = NodePath.join(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
}

const SECTION_ROWS = [
  "Advisor",
  "Let threads ask a stronger model",
  "Advisor model",
  "Claude's own advisor",
  "Context limit for Claude's advisor",
  "Consults per run",
  "Brief size",
];

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
    await context.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const at = `${theme} ${width}`;
    page.on("pageerror", (error) => fail(at, `page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // The app's connection layer looks for a server on load; the fixture has none.
      if (message.location().url.endsWith("/.well-known/studio/environment")) return;
      fail(at, `console error: ${message.text()}`);
    });
    const open = async (view, extra = "") => {
      await page.goto(`${origin}/?theme=${theme}&view=${view}${extra}`);
      await page.waitForLoadState("networkidle");
    };

    // Settings > Models: on, with the defaults.
    await open("app");
    await page.getByText("Let threads ask a stronger model", { exact: true }).waitFor();
    await expectText(page, `app ${at}`, [
      ...SECTION_ROWS,
      "The Complex track",
      "This machine: Build Mac",
    ]);
    for (const [label, value] of [
      ["Context limit for Claude's advisor", "200,000"],
      ["Consults per run", "3"],
      ["Brief size", "24,000"],
    ]) {
      const shown = await page.getByRole("textbox", { name: label, exact: true }).inputValue();
      if (shown !== value) fail(`app ${at}`, `${label} reads "${shown}", not ${value}`);
    }
    const toggle = page.getByRole("switch", { name: "Let threads ask a stronger model" });
    if ((await toggle.getAttribute("aria-checked")) !== "true")
      fail(`app ${at}`, "the advisor switch is not on");
    for (const problem of [
      ...(await layout(page, '[data-slot="settings-row"]')),
      ...(await clipped(page, "#advisor")),
    ])
      fail(`app ${at}`, problem);
    await shot(page, `settings-app-${theme}-${width}`);
    // A row writes only its own field.
    await page.getByRole("button", { name: "Increase Consults per run" }).click();
    const update = (await calls(page)).find((call) => call[0] === "update");
    if (
      JSON.stringify(update) !==
      JSON.stringify(["update", "app", { advisor: { maxConsultsPerRun: 4 } }])
    )
      fail(`app ${at}`, `increase wrote ${JSON.stringify(update)}`);

    // The project dialog: two fields overridden, consults per run (5) and brief size (32,000).
    await open("project");
    await page.getByText("Let threads ask a stronger model", { exact: true }).waitFor();
    await expectText(page, `project ${at}`, SECTION_ROWS);
    const rowOf = (title) =>
      page.locator('[data-slot="settings-row"]').filter({
        has: page.getByText(title, { exact: true }),
      });
    const overriddenIn = (title) =>
      rowOf(title)
        .getByRole("button", { name: /^Overridden for this project\./ })
        .count();
    const inheritedIn = (title) =>
      rowOf(title)
        .getByRole("button", { name: /^Inherited from Build Mac\./ })
        .count();
    const fieldValue = (label) =>
      page.getByRole("textbox", { name: label, exact: true }).inputValue();
    if ((await fieldValue("Consults per run")) !== "5")
      fail(
        `project ${at}`,
        `consults per run reads "${await fieldValue("Consults per run")}", not 5`,
      );
    if ((await fieldValue("Brief size")) !== "32,000")
      fail(`project ${at}`, `brief size reads "${await fieldValue("Brief size")}", not 32,000`);
    // Per field: only the overridden rows say so; every other row inherits.
    for (const title of SECTION_ROWS.slice(1)) {
      const own = title === "Consults per run" || title === "Brief size";
      if ((await overriddenIn(title)) !== (own ? 1 : 0))
        fail(`project ${at}`, `"${title}" ${own ? "is not" : "is"} marked overridden`);
      if ((await inheritedIn(title)) !== (own ? 0 : 1))
        fail(`project ${at}`, `"${title}" ${own ? "is" : "is not"} marked inherited`);
    }
    for (const problem of [
      ...(await layout(page, '[data-slot="settings-row"]')),
      ...(await clipped(page, "#project-advisor")),
    ])
      fail(`project ${at}`, problem);
    await shot(page, `settings-project-${theme}-${width}`);
    // The consults row's reset removes that field alone; brief size stays overridden.
    await rowOf("Consults per run")
      .getByRole("button", { name: /^Reset .* to default$/ })
      .click();
    await page.waitForTimeout(100);
    const plan = (await calls(page)).find((call) => call[0] === "run-plan");
    if (
      JSON.stringify(plan?.[2]?.[0]?.projectSettingsOverrides) !==
      JSON.stringify({ atlas: { advisor: { briefTokenBudget: 32_000 } } })
    )
      fail(`project ${at}`, `the consults reset wrote ${JSON.stringify(plan)}`);
    if (
      (await overriddenIn("Consults per run")) !== 0 ||
      (await inheritedIn("Consults per run")) !== 1
    )
      fail(`project ${at}`, "consults per run is not inherited after its reset");
    if ((await fieldValue("Consults per run")) !== "3")
      fail(`project ${at}`, "the inherited consults value did not return after reset");
    if ((await overriddenIn("Brief size")) !== 1 || (await fieldValue("Brief size")) !== "32,000")
      fail(`project ${at}`, "the consults reset also cleared brief size");

    // The composer's options menu.
    await open("composer");
    await page.getByRole("button", { name: "Thread options" }).click();
    await page.locator("[data-thread-advisor-menu]").waitFor();
    if (!(await page.locator("[data-thread-advisor-menu]").innerText()).startsWith("Advisor"))
      fail(`composer ${at}`, "the row has no Advisor heading");
    await expectText(page, `composer ${at}`, [
      "Lets this thread ask a stronger model to check its work.",
      "Follow project (on)",
      "On",
      "Off",
    ]);
    if (
      (await page
        .locator("[data-thread-advisor-menu]")
        .getAttribute("data-thread-advisor-menu")) !== "on"
    )
      fail(`composer ${at}`, "the row does not show the advisor on");
    const follow = page.locator('[data-thread-advisor-choice="follow"]');
    if ((await follow.getAttribute("aria-checked")) !== "true")
      fail(`composer ${at}`, "Follow project is not the checked choice");
    for (const problem of await layout(
      page,
      '[data-slot="menu-popup"], [data-thread-advisor-menu]',
    ))
      fail(`composer ${at}`, problem);
    await shot(page, `composer-${theme}-${width}`);

    // The Adversarial review row comes right after Advisor, the same way.
    const reviewRow = page.locator("[data-thread-review-menu]");
    await reviewRow.waitFor();
    const rowOrder = await page.evaluate(() =>
      [...document.querySelectorAll("[data-thread-advisor-menu], [data-thread-review-menu]")].map(
        (row) => (row.hasAttribute("data-thread-review-menu") ? "review" : "advisor"),
      ),
    );
    if (JSON.stringify(rowOrder) !== JSON.stringify(["advisor", "review"]))
      fail(`composer ${at}`, `rows in the order ${rowOrder.join(", ")}`);
    if (!(await reviewRow.innerText()).startsWith("Adversarial review"))
      fail(`composer ${at}`, "the review row has no Adversarial review heading");
    const reviewText = await reviewRow.innerText();
    for (const expected of [
      "Has a model from another family review this thread's work when its feature is finished.",
      "Follow project (off)",
    ])
      if (!reviewText.includes(expected)) fail(`composer ${at}`, `review row lacks "${expected}"`);
    if ((await reviewRow.getAttribute("data-thread-review-menu")) !== "off")
      fail(`composer ${at}`, "the review row does not show review off");
    if ((await reviewRow.locator("[data-thread-review-choice]").count()) !== 3)
      fail(`composer ${at}`, "the review row lacks its three choices");

    // Each row's info button shows its time note without closing the menu or choosing.
    for (const [row, expected, name] of [
      ["[data-thread-advisor-menu]", "about 1.1 times as long", "advisor"],
      ["[data-thread-review-menu]", "a median 2.6 times as long", "review"],
    ]) {
      const before = (await calls(page)).length;
      const info = page.locator(`${row} [data-thread-choice-time-note]`);
      const label = await info.getAttribute("aria-label");
      if (!label?.startsWith("How much longer work takes with "))
        fail(`composer ${at}`, `${name} info button is named "${label}"`);
      await info.hover();
      const note = page.locator("[data-slot='tooltip-popup']").filter({ hasText: expected });
      await note.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {
        fail(`composer ${at}`, `${name} time note did not open`);
      });
      await page.waitForTimeout(250);
      const box = await note.boundingBox();
      if (box && (box.x < 0 || box.x + box.width > width + 0.5))
        fail(`composer ${at}`, `${name} time note off screen ${JSON.stringify(box)}`);
      await shot(page, `composer-${name}-note-${theme}-${width}`);
      await info.click();
      await page.waitForTimeout(100);
      if ((await page.locator("[data-thread-advisor-menu]").count()) !== 1)
        fail(`composer ${at}`, `opening the ${name} note closed the menu`);
      if ((await calls(page)).length !== before)
        fail(`composer ${at}`, `opening the ${name} note picked a choice`);
      await page.mouse.move(0, 0);
    }
    await page.locator('[data-thread-review-choice="on"]').click();
    const review = (await calls(page)).find((call) => call[0] === "setReviewMode");
    if (
      review?.[1]?.input?.reviewMode !== "on" ||
      review?.[1]?.input?.threadId !== "thread-atlas-1"
    )
      fail(`composer ${at}`, `review On wrote ${JSON.stringify(review)}`);
    await page.locator("[data-thread-advisor-menu]").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Thread options" }).click();
    await page.locator("[data-thread-advisor-menu]").waitFor();
    if ((await reviewRow.getAttribute("data-thread-review-menu")) !== "on")
      fail(`composer ${at}`, "the review row does not show the thread's On");
    await page.locator('[data-thread-advisor-choice="off"]').click();
    const set = (await calls(page)).find((call) => call[0] === "setAdvisorMode");
    if (set?.[1]?.input?.advisorMode !== "off" || set?.[1]?.input?.threadId !== "thread-atlas-1")
      fail(`composer ${at}`, `Off wrote ${JSON.stringify(set)}`);

    // The real picker on a model with no options still opens, to the Advisor group alone.
    await page.keyboard.press("Escape");
    await page.locator("[data-thread-advisor-menu]").waitFor({ state: "detached" });
    const plainTrigger = page.locator(
      "[data-fixture-plain-composer] [data-composer-advisor-only-trigger]",
    );
    if ((await plainTrigger.count()) !== 1)
      fail(`composer ${at}`, "no options trigger on a model with no options");
    else {
      await plainTrigger.click();
      const plainMenu = page.locator("[data-thread-advisor-menu]");
      await plainMenu.waitFor();
      const popup = page.locator('[data-slot="menu-popup"]').filter({ has: plainMenu });
      if ((await popup.getByText("Effort", { exact: true }).count()) !== 0)
        fail(`composer ${at}`, "the plain model's menu shows options it does not have");
      if ((await popup.locator("[data-thread-advisor-choice]").count()) !== 3)
        fail(`composer ${at}`, "the plain model's menu lacks the three Advisor choices");
      // The Off choice above is now the thread's mode.
      if ((await plainMenu.getAttribute("data-thread-advisor-menu")) !== "off")
        fail(`composer ${at}`, "the plain model's row does not show the thread's Off");
      for (const problem of await layout(page, '[data-slot="menu-popup"]'))
        fail(`composer ${at}`, problem);
      await shot(page, `composer-plain-${theme}-${width}`);
    }

    // The Advisor row's note names who answers the thread's next consult.
    for (const [thread, kind, lines, absent] of [
      [
        "fable",
        "advisor",
        [
          "Advisor: Claude Fable 5.2, same model as this thread",
          "Past 200,000 tokens: GPT-6 Astra",
        ],
        [],
      ],
      ["opus", "advisor", ["Advisor: Claude Fable 5.2"], ["Past 200,000 tokens"]],
      [
        "passthrough",
        "pass-through",
        ["Claude's own advisor setting answered here: Claude Fable 5.2", "Follow project (off)"],
        ["Advisor: "],
      ],
    ]) {
      const where = `composer ${thread} ${at}`;
      await open("composer", `&thread=${thread}`);
      await page.getByRole("button", { name: "Thread options" }).click();
      const note = page.locator("[data-thread-advisor-menu] [data-thread-advisor-note]");
      await note.waitFor();
      if ((await note.getAttribute("data-thread-advisor-note")) !== kind)
        fail(where, `the note is ${await note.getAttribute("data-thread-advisor-note")}`);
      await expectText(page, where, lines);
      const noteText = await note.innerText();
      for (const text of absent)
        if (noteText.includes(text)) fail(where, `the note says "${text}"`);
      for (const problem of [
        ...(await layout(page, '[data-slot="menu-popup"], [data-thread-advisor-note]')),
        ...(await clipped(page, "[data-thread-advisor-note]")),
      ])
        fail(where, problem);
      await shot(page, `composer-note-${thread}-${theme}-${width}`);
      await page.keyboard.press("Escape");
    }

    // The timeline: advice opens as Markdown; the unavailable consult is marked failed.
    await open("timeline");
    const adviceRow = page.locator('[data-advisor-consult="advice"]');
    await adviceRow.waitFor();
    await expectText(page, `timeline ${at}`, [
      "Asked the advisor",
      "Claude Fable 5.2 on Claude",
      "2 left this run",
      "Advisor unavailable",
      "overloaded",
    ]);
    if ((await adviceRow.getAttribute("aria-expanded")) !== "false")
      fail(`timeline ${at}`, "the advice row starts open");
    await adviceRow.click();
    await page.locator("[data-advisor-advice]").waitFor();
    if ((await page.locator("[data-advisor-advice] ol li").count()) !== 2)
      fail(`timeline ${at}`, "the advice did not render as a Markdown list");
    if ((await page.locator("[data-advisor-advice] code").count()) === 0)
      fail(`timeline ${at}`, "the advice lost its inline code");
    const unavailable = page.locator('[data-advisor-consult="unavailable"]');
    if ((await unavailable.getAttribute("role")) === "button")
      fail(`timeline ${at}`, "the unavailable row opens to nothing");
    const body = await page.locator("body").innerText();
    if (/[{"]status"?\s*:/.test(body) || body.includes("structuredContent"))
      fail(`timeline ${at}`, "raw JSON shows in the timeline");
    if ((await calls(page)).some((call) => call[0] === "detail-fetch"))
      fail(`timeline ${at}`, "a consult with its output fetched its detail");
    for (const problem of [
      ...(await layout(page, "[data-advisor-consult]")),
      ...(await clipped(page, "[data-fixture-timeline]")),
    ])
      fail(`timeline ${at}`, problem);
    await shot(page, `timeline-${theme}-${width}`);

    report.push({ theme, width, height });
    await context.close();
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  `${JSON.stringify({ checked: report, screenshots, problems }, null, 2)}\n`,
);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `Advisor fixture: ${report.length} layouts, ${screenshots.length} screenshots, no problems. ${output}`,
);
