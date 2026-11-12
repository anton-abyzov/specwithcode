// Headless check of first-run setup's sign-in, connection and Projects steps in their
// real frame, per system, theme, width and language. The Agents step is not
// here: its rows need a live provider probe and have their own fixture. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/first-run/vite.config.ts
//   node apps/web/tests/first-run/verify.mjs /absolute/owned/report-dir
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
const site = NodePath.resolve(process.env.FIRST_RUN_SITE ?? ".artifacts/first-run/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/first-run/evidence");
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
let shots = 0;
/** What every step must hold to: nothing off the side, footer in view, one sentence under the title. */
const stepState = (page, height) =>
  page.evaluate((height) => {
    const found = [];
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push("sideways scroll");
    const popup = rect('[data-slot="dialog-popup"]');
    const footer = rect('[data-slot="wizard-step-footer"]');
    if (!popup) found.push("no dialog");
    else if (popup.bottom > height + 0.5) found.push(`dialog below the window (${popup.bottom})`);
    if (!footer) found.push("no footer");
    else if (footer.bottom > height + 0.5) found.push(`footer out of view (${footer.bottom})`);
    const title = document.querySelector('[data-slot="dialog-panel"] h1');
    const why = title?.nextElementSibling;
    if (!title?.textContent?.trim()) found.push("no title");
    if (why?.tagName !== "P" || !why.textContent?.trim()) found.push("no sentence under the title");
    // Text cut off, sideways or downwards, in anything that holds words itself.
    for (const element of document.querySelectorAll('[data-slot="dialog-popup"] *')) {
      const words = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0,
      );
      // Text kept for screen readers only is one pixel wide on purpose.
      if (!words || element.clientWidth <= 1) continue;
      const style = getComputedStyle(element);
      // Text shortened with an ellipsis is cut on purpose and is not reported.
      const cutsAcross = /hidden|clip/.test(style.overflowX) && style.textOverflow !== "ellipsis";
      const cutsDown = /hidden|clip/.test(style.overflowY);
      if (
        (cutsAcross && element.scrollWidth > element.clientWidth + 1) ||
        (cutsDown && element.scrollHeight > element.clientHeight + 1)
      ) {
        found.push(`clipped text: ${element.textContent.trim().slice(0, 40)}`);
      }
    }
    return { found, title: title?.textContent?.trim() ?? "", why: why?.textContent?.trim() ?? "" };
  }, height);
/**
 * Every control in the dialog must look different focused than not. One Tab
 * press puts the page in keyboard mode, so a focus given by script draws the
 * same mark a key would; transitions are off so each look is read settled. A
 * control's shadow and outline are read with focus and again without it, so a
 * shadow it always wears does not count as a mark.
 */
const focusProblems = async (page) => {
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
  await page.keyboard.press("Tab");
  return page.evaluate(() => {
    const look = (element) => {
      const style = getComputedStyle(element);
      return [style.boxShadow, style.outlineStyle, style.outlineWidth, style.outlineColor].join(
        "|",
      );
    };
    const controls = [
      ...document.querySelectorAll(
        '[data-slot="dialog-popup"] :is(button, input, select, textarea, a[href], [tabindex="0"])',
      ),
    ].filter(
      (element) =>
        !element.disabled &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.getClientRects().length > 0,
    );
    const found = [];
    for (const element of controls) {
      const label = (element.getAttribute("aria-label") ?? element.textContent ?? "")
        .trim()
        .slice(0, 40);
      element.blur();
      const plain = look(element);
      element.focus({ focusVisible: true });
      if (document.activeElement !== element) found.push(`cannot focus "${label}"`);
      else if (look(element) === plain) found.push(`no visible focus on "${label}"`);
    }
    if (controls.length < 3) found.push(`only ${controls.length} controls found to focus`);
    return found;
  });
};
const open = async (query, width, height) => {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const at = new URLSearchParams(query).toString();
  page.on("pageerror", (error) => problems.push(`${at}: ${error}`));
  await page.goto(`${origin}/?${at}`);
  await page.locator('[data-slot="wizard-step-footer"]').waitFor();
  await page.waitForTimeout(300);
  return { context, page };
};

// Every system, theme and width, in English.
for (const view of ["connection", "projects"]) {
  for (const platform of ["macos", "windows", "linux"]) {
    for (const theme of ["light", "dark"]) {
      for (const [width, height] of [
        [1120, 900],
        // The smallest the desktop window gets.
        [840, 620],
        [390, 844],
      ]) {
        const at = `${view} ${platform} ${theme} ${width}`;
        const { context, page } = await open({ view, platform, theme }, width, height);
        const state = await stepState(page, height);
        for (const problem of state.found) problems.push(`${at}: ${problem}`);
        await page.screenshot({
          path: NodePath.join(output, `${view}-${platform}-${width}-${theme}.png`),
        });
        shots += 1;
        for (const problem of await focusProblems(page)) problems.push(`${at}: ${problem}`);
        await context.close();
      }
    }
  }
}

// The sentence under each title, in all nine languages, at the narrow width where long words hurt.
const sentences = {};
for (const lang of ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"]) {
  for (const view of ["connection", "projects"]) {
    const { context, page } = await open({ view, lang, platform: "windows" }, 390, 844);
    const state = await stepState(page, 844);
    for (const problem of state.found) problems.push(`${view} ${lang} 390: ${problem}`);
    (sentences[view] ??= {})[lang] = state.why;
    await page.screenshot({ path: NodePath.join(output, `${view}-lang-${lang}-390.png`) });
    shots += 1;
    await context.close();
  }
}
for (const [view, byLang] of Object.entries(sentences)) {
  for (const [lang, sentence] of Object.entries(byLang)) {
    if (lang !== "en" && sentence === byLang.en) {
      problems.push(`${view} ${lang}: the sentence under the title is still English`);
    }
  }
}

// The sign-in step: signed out, while the Connect helper a new machine lacks is installed, and
// linked. The install shows in the link row, and no second dialog opens over setup to ask.
const helperRow = {};
for (const [name, query] of [
  ["signed-out", {}],
  ["helper", { link: "helper", stage: "downloading" }],
  ["linked", { link: "linked" }],
]) {
  for (const platform of ["macos", "windows", "linux"]) {
    for (const theme of ["light", "dark"]) {
      for (const [width, height] of [
        [840, 620],
        [390, 844],
      ]) {
        const at = `signin ${name} ${platform} ${theme} ${width}`;
        const { context, page } = await open(
          { view: "signin", platform, theme, ...query },
          width,
          height,
        );
        const state = await stepState(page, height);
        for (const problem of state.found) problems.push(`${at}: ${problem}`);
        if (name === "helper") {
          const row = (await page.locator('[data-part="link"]').innerText()).replace(/\s+/g, " ");
          if (!row.includes("Getting the Connect helper: downloading (step 3 of 7)")) {
            problems.push(`${at}: the link row does not show the helper's install ("${row}")`);
          }
          const dialogs = await page.locator('[data-slot="dialog-popup"]').count();
          if (dialogs !== 1)
            problems.push(`${at}: ${dialogs} dialogs on screen, expected setup only`);
          if ((await page.getByRole("button", { name: "Continue" }).count()) !== 1) {
            problems.push(`${at}: no way on while the helper installs`);
          }
          const asked = await page.evaluate(() =>
            window.fixtureCalls.map((call) => call.join(" ")),
          );
          if (!asked.some((call) => call.includes('"relayClientInstall":"agreed"'))) {
            problems.push(`${at}: the link was not asked for without the question (${asked})`);
          }
        }
        await page.screenshot({
          path: NodePath.join(output, `signin-${name}-${platform}-${width}-${theme}.png`),
        });
        shots += 1;
        for (const problem of await focusProblems(page)) problems.push(`${at}: ${problem}`);
        await context.close();
      }
    }
  }
}
for (const lang of ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"]) {
  const { context, page } = await open(
    { view: "signin", link: "helper", stage: "downloading", lang, platform: "windows" },
    390,
    844,
  );
  const state = await stepState(page, 844);
  for (const problem of state.found) problems.push(`signin helper ${lang} 390: ${problem}`);
  helperRow[lang] = (await page.locator('[data-part="link"]').innerText()).replace(/\s+/g, " ");
  await page.screenshot({ path: NodePath.join(output, `signin-helper-lang-${lang}-390.png`) });
  shots += 1;
  await context.close();
}
for (const [lang, row] of Object.entries(helperRow)) {
  if (lang !== "en" && row === helperRow.en) {
    problems.push(`signin helper ${lang}: the link row is still English`);
  }
}

// With nothing found, a typed folder gives the step a main button that works.
{
  const { context, page } = await open({ view: "projects", found: "0" }, 840, 620);
  const primary = page.locator("[data-wizard-primary]");
  if (!(await primary.isDisabled()))
    problems.push("nothing found: the main button is on with no folder");
  await page.getByRole("button", { name: "Type a path", exact: true }).click();
  const bar = page.getByLabel("Folder path");
  await bar.fill("~/Projects/playground");
  await bar.press("Enter");
  await page.waitForTimeout(400);
  const label = (await primary.innerText()).trim();
  if (!/^Add playground/.test(label)) problems.push(`nothing found: main button reads "${label}"`);
  await page.screenshot({ path: NodePath.join(output, "projects-nothing-found-folder.png") });
  shots += 1;
  await primary.click();
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.fixtureCalls.map((call) => call.join(" ")));
  if (!calls.includes("create /Users/you/Projects/playground")) {
    problems.push(`nothing found: the folder was not added (${calls.join(", ")})`);
  }
  if (!calls.some((call) => call.startsWith("done ")))
    problems.push("nothing found: setup did not finish");
  await context.close();
}

await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "first-run-report.json"),
  JSON.stringify({ problems, sentences, helperRow }, null, 2),
);
console.log(`${shots} screenshots in ${output}`);
console.log(problems.length ? problems.join("\n") : "no problems");
process.exit(problems.length ? 1 : 0);
