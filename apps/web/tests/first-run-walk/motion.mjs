// Headless checks of first-run setup's motion, pictures and stage bar (1387
// AC-32 to AC-34). Two pages of the same fixture build:
//   ?fixture=motion  the real FirstRunFrame, StepPicture and AccessStep, with a
//                    busy step (motionFixture.tsx). Motion, pictures, layout.
//   ?entry=start     the real WelcomeWizard (main.tsx). Focus after Continue,
//                    sideways scroll and screenshots of the shipped steps.
// What it checks:
//   - new motion changes only transform, opacity, an SVG stroke's dash offset
//     and an Access row body's own height; no `d`, no skew;
//   - a step's entrance the first time, the quick fade on a second visit, rows
//     40 ms apart and all started within 300 ms;
//   - nothing marked data-motion="setup" runs 5 s after the last input;
//   - with reduced motion nothing moves and every state is immediate;
//   - opening a row moves only what is below it, and focus stays on the press;
//   - after Continue focus is on the neutral action, or on the heading while
//     the step is busy;
//   - the picture beside (>= 880 px of dialog), above (620 to 880, <= 112 px
//     tall) or left out (< 620); at 390 by 700 the footer's action is in view;
//   - no sideways scroll at 390 and 1280, light and dark, with screenshots;
//   - tab order follows reading order and focus is visible.
//   node apps/web/tests/first-run-walk/motion.mjs [/absolute/report-dir]
// It builds the fixture first unless FIRST_RUN_WALK_SITE names a built one.
// Never run it alongside verify.mjs: both build into the same folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repo = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "../../../..");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.join(repo, "apps/server/package.json"))("playwright-core");

let site = process.env.FIRST_RUN_WALK_SITE;
if (!site) {
  const build = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(repo, "node_modules/vite-plus/bin/vp"),
      "build",
      "--config",
      "apps/web/tests/first-run-walk/vite.config.ts",
    ],
    { cwd: repo, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.status !== 0) throw new Error(`the first-run fixture did not build (${build.status})`);
  site = NodePath.join(repo, ".artifacts/first-run-walk/site");
}
site = NodePath.resolve(site);
const output = NodePath.resolve(
  process.argv[2] ?? NodePath.join(repo, ".artifacts/first-run-walk/motion"),
);
await NodeFSP.mkdir(output, { recursive: true });

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
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
const notes = [];
const shots = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const check = (where, ok, what) => {
  if (!ok) fail(where, what);
};

/**
 * Records every animation and transition that is new setup motion: a target
 * marked data-motion="setup", or keyframes named setup-*. Existing motion
 * (the dialog's own, an installing spinner) is not judged.
 */
function recordMotion() {
  window.__motion = [];
  const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const describe = (element) =>
    element.getAttribute?.("data-slot") ??
    element.getAttribute?.("data-setup-thread") ??
    element.getAttribute?.("data-access-row") ??
    element.tagName?.toLowerCase();
  const marked = (element) => element.getAttribute?.("data-motion") === "setup";
  document.addEventListener(
    "animationstart",
    (event) => {
      if (!marked(event.target) && !event.animationName.startsWith("setup-")) return;
      const animation = event.target
        .getAnimations()
        .find((entry) => entry.animationName === event.animationName);
      const frames = animation?.effect?.getKeyframes() ?? [];
      const props = [
        ...new Set(
          frames.flatMap((frame) =>
            Object.keys(frame).filter(
              (key) => !["offset", "computedOffset", "easing", "composite"].includes(key),
            ),
          ),
        ),
      ].map(kebab);
      const values = frames.map((frame) => JSON.stringify(frame)).join(" ");
      window.__motion.push({
        kind: "animation",
        name: event.animationName,
        props,
        skew: /skew/i.test(values),
        target: describe(event.target),
        at: performance.now(),
      });
    },
    true,
  );
  document.addEventListener(
    "transitionrun",
    (event) => {
      if (!marked(event.target)) return;
      window.__motion.push({
        kind: "transition",
        props: [event.propertyName],
        target: describe(event.target),
        pseudo: event.pseudoElement || undefined,
        at: performance.now(),
      });
    },
    true,
  );
}

const ALLOWED = new Set(["transform", "translate", "scale", "opacity", "stroke-dashoffset"]);
function judgeMotion(where, records) {
  for (const record of records) {
    for (const prop of record.props) {
      const ok =
        ALLOWED.has(prop) || (prop === "grid-template-rows" && record.target === "access-row-body");
      check(where, ok, `${record.kind} on ${record.target} changes ${prop}`);
    }
    check(where, !record.skew, `${record.name} skews`);
  }
}

/** Setup motion still running: what the loop check and reduced motion judge. */
const runningSetupMotion = (page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const target = animation.effect?.target;
        const name = animation.animationName ?? "";
        return (
          animation.playState === "running" &&
          (name.startsWith("setup-") || target?.getAttribute?.("data-motion") === "setup")
        );
      })
      .map(
        (animation) =>
          `${animation.animationName ?? animation.transitionProperty} on ${
            animation.effect?.target?.getAttribute?.("data-slot") ??
            animation.effect?.target?.tagName
          }`,
      ),
  );

const settle = async (page) => {
  for (let tries = 0; tries < 40; tries += 1) {
    if ((await runningSetupMotion(page)).length === 0) return;
    await page.waitForTimeout(50);
  }
};

const POPUP = '[data-slot="dialog-popup"][data-wizard-step]';
const stepIs = (page, id) =>
  page.waitForSelector(`${POPUP}[data-wizard-step="${id}"]`, { timeout: 10_000 });
const pressContinue = (page) =>
  page.locator(`${POPUP} [data-wizard-primary]:not(:disabled)`).click();
const focusInfo = (page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName.toLowerCase() ?? "",
      neutral: active?.hasAttribute("data-wizard-neutral") ?? false,
      heading: active?.matches('[data-slot="dialog-panel"] h1') ?? false,
      fixtureOpen: active?.getAttribute("data-fixture-open") ?? null,
      text: active?.textContent?.trim().slice(0, 40) ?? "",
    };
  });

/** Nothing off the side; the dialog inside the window. */
const sideways = (page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const found = [];
    if (root.scrollWidth > root.clientWidth) found.push(`sideways scroll (${root.scrollWidth})`);
    const popup = document.querySelector('[data-slot="dialog-popup"]')?.getBoundingClientRect();
    if (popup && (popup.left < 0 || popup.right > root.clientWidth + 0.5))
      found.push(`dialog off the side (${Math.round(popup.left)}..${Math.round(popup.right)})`);
    if (popup && popup.bottom > window.innerHeight + 0.5)
      found.push(`dialog below the window (${Math.round(popup.bottom)})`);
    return found;
  });

/** Where the picture sits for the dialog's own width. */
const pictureLayout = (page) =>
  page.evaluate(() => {
    const popup = document.querySelector('[data-slot="dialog-popup"]');
    const body = document.querySelector('[data-slot="setup-body"]');
    const picture = document.querySelector('[data-slot="setup-picture"]');
    const panel = document.querySelector('[data-slot="dialog-panel"]');
    const box = (element) => element?.getBoundingClientRect();
    const p = box(picture);
    const s = box(panel);
    const shown = picture !== null && getComputedStyle(picture).display !== "none" && p.height > 0;
    return {
      dialog: Math.round(box(popup).width),
      body: Math.round(box(body).width),
      shown,
      height: shown ? Math.round(p.height) : 0,
      beside: shown && p.left >= s.right - 1,
      above: shown && p.bottom <= s.top + 1,
      svgText: picture?.querySelector("text") !== null,
      hidden: picture?.getAttribute("aria-hidden") ?? null,
    };
  });

function judgePicture(where, layout) {
  check(where, layout.hidden === null || layout.hidden === "true", "picture not aria-hidden");
  check(where, !layout.svgText, "picture has text");
  if (layout.body >= 880)
    check(where, layout.shown && layout.beside, `picture not beside (${JSON.stringify(layout)})`);
  else if (layout.body >= 620)
    check(
      where,
      layout.shown && layout.above && layout.height <= 112,
      `picture not above at <= 112 px (${JSON.stringify(layout)})`,
    );
  else check(where, !layout.shown, `picture shown below 620 px (${JSON.stringify(layout)})`);
}

/**
 * The footer's actions in view without scrolling. A step whose neutral action
 * sits in its body (the sign-in) is judged by its footer, as AC-33 says.
 */
const footerInView = (page) =>
  page.evaluate(() => {
    const actions = [...document.querySelectorAll('[data-slot="wizard-footer-slot"] button')];
    return (
      actions.length > 0 &&
      actions.every((action) => {
        const box = action.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      })
    );
  });

/** Tab once round the dialog: reading order and a visible focus mark on each stop. */
async function tabRound(page, where) {
  const stops = [];
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press("Tab");
    // The dialog's focus guards hand focus on to its other end.
    await page
      .waitForFunction(() => !document.activeElement?.hasAttribute("data-base-ui-focus-guard"), {
        timeout: 1_000,
      })
      .catch(() => {});
    const stop = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      const style = getComputedStyle(active);
      const box = active.getBoundingClientRect();
      const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      const ring = style.boxShadow !== "none";
      if (!active.dataset.tabProbe) active.dataset.tabProbe = String(Math.random()).slice(2);
      return {
        id: active.dataset.tabProbe,
        label: (active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 30),
        visible: active.matches(":focus-visible") && (outline || ring),
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        inDialog: active.closest('[data-slot="dialog-popup"]') !== null,
      };
    });
    if (stop === null) break;
    if (stops.length > 0 && stop.id === stops[0].id) break;
    stops.push(stop);
  }
  check(where, stops.length > 2, `tab found ${stops.length} stops`);
  for (const stop of stops) {
    check(where, stop.inDialog, `tab left the dialog at ${stop.label}`);
    check(where, stop.visible, `no visible focus on ${stop.label}`);
  }
  // Rotate the round to start at the top of the dialog, then read it.
  const first = stops.reduce(
    (best, stop, index) => (stop.top < stops[best].top - 1 ? index : best),
    0,
  );
  const round = [...stops.slice(first), ...stops.slice(0, first)];
  for (let index = 1; index < round.length; index += 1) {
    const before = round[index - 1];
    const after = round[index];
    const sameLine = after.top < before.bottom && after.bottom > before.top;
    const ok = sameLine ? after.left >= before.left - 1 : after.top >= before.bottom - 1;
    check(where, ok, `tab goes from ${before.label} back to ${after.label}`);
  }
  return round.map((stop) => stop.label);
}

async function newPage({ width, height, theme = "light", reduced = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: reduced ? "reduce" : "no-preference",
    locale: "en-US",
  });
  await context.addInitScript(recordMotion);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

const shot = async (page, name) => {
  const file = `${name}.png`;
  await page.screenshot({ path: NodePath.join(output, file) });
  shots.push(file);
};

// 1. The motion harness at 1280: entrance, pictures, busy focus, row opening,
//    a second visit, the loop check and what moved.
{
  const where = "motion 1280";
  const { context, page, errors } = await newPage({ width: 1280, height: 800 });
  await page.goto(`${origin}/?fixture=motion&theme=light`);
  await stepIs(page, "connect");
  const entrance = await page.evaluate(() => {
    const step = document.querySelector('[data-slot="setup-step"]');
    const heading = step?.querySelector("h1");
    const animation = heading?.getAnimations()[0];
    return {
      entry: step?.getAttribute("data-setup-entry"),
      name: animation?.animationName,
      delay: animation?.effect?.getTiming().delay,
      duration: animation?.effect?.getTiming().duration,
    };
  });
  check(where, entrance.entry === "first", `first step entry ${entrance.entry}`);
  check(
    where,
    entrance.name === "setup-fall" && entrance.delay === 0 && entrance.duration === 560,
    `heading entrance ${JSON.stringify(entrance)}`,
  );
  judgePicture(where, await pictureLayout(page));
  await settle(page);
  await page.locator('[data-fixture-light="machine"]').click();
  await page.waitForTimeout(700);
  const drawn = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('[data-setup-thread="machine"]')).strokeDashoffset,
  );
  check(where, parseFloat(drawn) < 0.2, `machine thread not drawn (${drawn})`);

  // Continue onto a busy step: focus waits on the heading, then the neutral action.
  await pressContinue(page);
  await stepIs(page, "agents");
  await page.waitForTimeout(100);
  const busy = await focusInfo(page);
  check(where, busy.heading, `busy step focus on ${busy.tag} "${busy.text}", not the heading`);
  await shot(page, "motion-busy-heading-focus-1280-light");
  await page.evaluate(() => window.fixtureRelease());
  await page.waitForTimeout(100);
  const released = await focusInfo(page);
  check(where, released.neutral, `released step focus on ${released.tag} "${released.text}"`);

  // The Access rows follow their heading 40 ms apart, all started within 300 ms.
  await pressContinue(page);
  await stepIs(page, "access");
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="access-rows"] > [data-access-row]')].map(
      (row) => row.getAnimations()[0]?.effect?.getTiming().delay ?? null,
    ),
  );
  check(where, rows.length >= 3, `rows found ${rows.length}`);
  check(
    where,
    rows.every((delay) => delay !== null && delay <= 300),
    `row delays ${rows}`,
  );
  check(
    where,
    rows.every((delay, index) => index === 0 || delay - rows[index - 1] === 40),
    `rows not 40 ms apart: ${rows}`,
  );
  await settle(page);
  await page.waitForTimeout(200);

  // Opening a row moves only what is below it; focus stays on the pressed control.
  const marks = () =>
    page.evaluate(() => {
      const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top;
      return {
        bar: top('[data-slot="setup-stage-bar"]'),
        heading: top('[data-slot="dialog-panel"] h1'),
        files: top('[data-access-row="files"]'),
        browser: top('[data-access-row="browser"]'),
        mac: top('[data-access-row="mac-apps"]'),
        footer: top('[data-slot="wizard-step-footer"]'),
      };
    });
  const before = await marks();
  await page.locator('[data-fixture-open="browser"]').focus();
  await page.keyboard.press("Enter");
  const samples = [];
  for (let index = 0; index < 14; index += 1) {
    samples.push(await marks());
    await page.waitForTimeout(50);
  }
  for (const sample of samples) {
    for (const key of ["bar", "heading", "files", "browser", "footer"]) {
      check(
        where,
        Math.abs(sample[key] - before[key]) < 0.5,
        `opening a row moved ${key} by ${(sample[key] - before[key]).toFixed(1)} px`,
      );
    }
  }
  check(where, samples.at(-1).mac > before.mac + 20, "the row below did not move down");
  const opened = await focusInfo(page);
  check(where, opened.fixtureOpen === "browser", `focus left the pressed control (${opened.tag})`);
  await shot(page, "motion-row-open-1280-light");
  await page.locator('[data-access-row="browser"] [data-fixture-light="browser"]').click();
  await page.locator('[data-fixture-light="mac-apps"]').click();
  await page.locator('[data-access-answer="accept"]').click();
  await page.waitForTimeout(700);
  const litAccess = await page.evaluate(() =>
    [...document.querySelectorAll("[data-setup-thread][data-lit]")].map((path) =>
      path.getAttribute("data-setup-thread"),
    ),
  );
  check(
    where,
    ["browser", "mac-apps", "files"].every((id) => litAccess.includes(id)),
    `access threads lit ${litAccess}`,
  );
  await shot(page, "motion-access-lit-1280-light");
  notes.push(`tab round on Access: ${(await tabRound(page, `${where} tab`)).join(" > ")}`);

  // Back is a second visit: the quick fade, and the threads drawn without replay.
  await page.locator(`${POPUP} [data-slot="wizard-step-footer"] button`).first().click();
  await stepIs(page, "agents");
  const again = await page.evaluate(() => {
    const step = document.querySelector('[data-slot="setup-step"]');
    const animation = step?.getAnimations()[0];
    return {
      entry: step?.getAttribute("data-setup-entry"),
      name: animation?.animationName,
      duration: animation?.effect?.getTiming().duration,
    };
  });
  check(
    where,
    again.entry === "again" && again.name === "setup-fade" && again.duration === 150,
    `second visit ${JSON.stringify(again)}`,
  );
  await pressContinue(page);
  await stepIs(page, "access");
  const replay = await page.evaluate(
    () => document.querySelector('[data-setup-thread="files"]').getAnimations().length,
  );
  check(where, replay === 0, "a lit thread replayed on a second visit");

  // Nothing loops: 5 s after the last input nothing marked runs.
  await page.waitForTimeout(5_000);
  const running = await runningSetupMotion(page);
  check(where, running.length === 0, `still running after 5 s: ${running.join(", ")}`);
  const records = await page.evaluate(() => window.__motion);
  check(where, records.length > 10, `only ${records.length} motion records`);
  judgeMotion(where, records);
  notes.push(
    `properties that moved: ${[...new Set(records.flatMap((record) => record.props))].join(", ")}`,
  );
  // The keyframes themselves: no `d`, no skew.
  const keyframes = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      })
      .filter((rule) => rule instanceof CSSKeyframesRule && rule.name.startsWith("setup-"))
      .map((rule) => rule.cssText),
  );
  check(where, keyframes.length >= 2, "setup keyframes not found");
  for (const text of keyframes) {
    check(where, !/(^|[\s{;])d\s*:/.test(text) && !/skew/i.test(text), `keyframes ${text}`);
  }
  for (const error of errors) fail(where, `page error: ${error}`);
  await context.close();
}

// 2. Reduced motion: nothing moves and every state is immediate.
{
  const where = "reduced motion";
  const { context, page, errors } = await newPage({ width: 1280, height: 800, reduced: true });
  await page.goto(`${origin}/?fixture=motion&theme=dark`);
  await stepIs(page, "connect");
  await page.locator('[data-fixture-light="machine"]').click();
  const immediate = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('[data-setup-thread="machine"]')).strokeDashoffset,
  );
  check(where, parseFloat(immediate) < 0.2, `thread not drawn at once (${immediate})`);
  await pressContinue(page);
  await stepIs(page, "agents");
  check(where, (await focusInfo(page)).heading, "busy step focus not on the heading");
  await page.evaluate(() => window.fixtureRelease());
  await pressContinue(page);
  await stepIs(page, "access");
  await page.locator('[data-fixture-open="browser"]').click();
  const body = await page.evaluate(() => {
    const element = document.querySelector('[data-slot="access-row-body"]:not([hidden])');
    return element ? element.getBoundingClientRect().height : 0;
  });
  check(where, body > 20, `row body not open at once (${body})`);
  await page.locator(`${POPUP} [data-slot="wizard-step-footer"] button`).first().click();
  await stepIs(page, "agents");
  const records = await page.evaluate(() => window.__motion);
  check(
    where,
    records.length === 0,
    `moved: ${records.map((record) => `${record.target} ${record.props}`).join(", ")}`,
  );
  check(where, (await runningSetupMotion(page)).length === 0, "setup motion running");
  await shot(page, "motion-reduced-1280-dark");
  for (const error of errors) fail(where, `page error: ${error}`);
  await context.close();
}

// 3. Each harness step at 390 and 1280, light and dark: no sideways scroll,
//    the picture where it belongs; and the picture at the in-between widths.
const STEPS = ["connect", "agents", "access", "projects"];
for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    const where = `motion ${width} ${theme}`;
    const { context, page, errors } = await newPage({ width, height: 800, theme });
    await page.goto(`${origin}/?fixture=motion&theme=${theme}`);
    for (const [index, step] of STEPS.entries()) {
      await stepIs(page, step);
      if (step === "agents") await page.evaluate(() => window.fixtureRelease());
      await settle(page);
      for (const problem of await sideways(page)) fail(`${where} ${step}`, problem);
      judgePicture(`${where} ${step}`, await pictureLayout(page));
      await shot(page, `motion-${index + 1}-${step}-${width}-${theme}`);
      if (index < STEPS.length - 1) await pressContinue(page);
    }
    for (const error of errors) fail(where, `page error: ${error}`);
    await context.close();
  }
}
for (const width of [600, 800, 1000]) {
  const where = `motion picture ${width}`;
  const { context, page } = await newPage({ width, height: 800 });
  await page.goto(`${origin}/?fixture=motion&theme=light`);
  await stepIs(page, "connect");
  await page.evaluate(() => window.fixtureRelease());
  await pressContinue(page);
  await stepIs(page, "agents");
  await pressContinue(page);
  await stepIs(page, "access");
  await settle(page);
  const layout = await pictureLayout(page);
  judgePicture(where, layout);
  notes.push(
    `at ${width} px: dialog ${layout.dialog} px, picture ${layout.beside ? "beside" : layout.above ? `above, ${layout.height} px` : "left out"}`,
  );
  await shot(page, `motion-picture-access-${width}-light`);
  await context.close();
}

// 4. At 390 by 700 the footer's action is in view on every step, no row open.
{
  const where = "motion 390x700";
  const { context, page } = await newPage({ width: 390, height: 700 });
  await page.goto(`${origin}/?fixture=motion&theme=light`);
  await page.evaluate(() => window.fixtureRelease?.());
  for (const step of STEPS) {
    await stepIs(page, step);
    if (step === "agents") await page.evaluate(() => window.fixtureRelease());
    await settle(page);
    const inView = await footerInView(page);
    check(`${where} ${step}`, inView, "footer action not in view without scrolling");
    if (step !== "projects") await pressContinue(page);
  }
  await context.close();
}

// 5. The real setup (WelcomeWizard): focus after each Continue, sideways
//    scroll and screenshots at 390 and 1280, light and dark; and at 390 by
//    700 the footer's action in view on every step.
const WIZARD_WALKS = [
  ...[390, 1280].flatMap((width) =>
    ["light", "dark"].map((theme) => ({ width, height: 844, theme })),
  ),
  { width: 390, height: 700, theme: "light", footer: true },
];
for (const { width, height, theme, footer } of WIZARD_WALKS) {
  {
    const where = `wizard ${width}x${height} ${theme}`;
    const { context, page, errors } = await newPage({ width, height, theme });
    await page.goto(`${origin}/?entry=start&theme=${theme}`);
    const seen = [];
    for (let index = 0; index < 8; index += 1) {
      const done = await page.locator("[data-fixture-done]").isVisible();
      if (done) break;
      const step = await page.locator(POPUP).getAttribute("data-wizard-step", { timeout: 10_000 });
      if (seen.at(-1) !== step) {
        if (seen.length > 0) {
          const focus = await focusInfo(page);
          check(
            `${where} ${step}`,
            focus.neutral || focus.heading,
            `focus after Continue on ${focus.tag} "${focus.text}"`,
          );
        }
        seen.push(step);
        await settle(page);
        for (const problem of await sideways(page)) fail(`${where} ${step}`, problem);
        if (footer) {
          const inView = await footerInView(page);
          check(`${where} ${step}`, inView, "footer action not in view without scrolling");
        }
        await shot(page, `wizard-${seen.length}-${step}-${width}x${height}-${theme}`);
      }
      const neutral = page.locator(`${POPUP} [data-wizard-neutral]:not(:disabled)`).first();
      await neutral.waitFor({ timeout: 15_000 });
      await neutral.click();
      await page.waitForTimeout(150);
    }
    notes.push(`${where}: ${seen.join(" > ")}`);
    check(where, seen.length >= 4, `walked ${seen.join(" > ")}`);
    for (const error of errors) fail(where, `page error: ${error}`);
    await context.close();
  }
}

await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "motion-report.json"),
  `${JSON.stringify({ problems, notes, screenshots: shots }, null, 2)}\n`,
);
for (const note of notes) console.log(note);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`First-run motion: passed, ${shots.length} screenshots. ${output}`);
