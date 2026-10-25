// Headless width, zoom, theme and keyboard matrix for the model chip in the thread
// composer, the design editor's thread column, the coordinator composer footer and the
// coordinator details pane (the thread composer's toolbar holding the coordinator's
// model and effort). Phone-width windows collapse the composer, which rests its
// controls inline or in a strip above it.
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/fallback-composer/vite.config.ts
// Run: STUDIO_PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node apps/web/tests/fallback-composer/model-controls.mjs <evidence-dir>
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/fallback-composer/model-controls");
await NodeFSP.mkdir(output, { recursive: true });
const root = NodePath.resolve(".artifacts/fallback-composer/site");
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const file = NodePath.resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"),
    );
    NodeAssert.ok(file.startsWith(root + NodePath.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html",
    );
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE,
});

// Pane widths in a desktop-sized window, as a narrow chat column or design pane is.
const WIDTHS = [320, 360, 400, 440, 520, 640, 768, 1024, 1280];
// Browser zoom at 200% in desktop windows of 1280, 1600 and 2048 device pixels: each holds
// half as many CSS pixels, so a pane of that many CSS pixels renders at twice the size.
const ZOOM_PANES = [
  [320, 640],
  [400, 800],
  [640, 1024],
];
const SURFACES = {
  thread: ["idle", "next", "fallback", "running", "long"],
  design: ["idle", "next", "fallback", "running"],
  coordinator: ["idle", "fallback", "running", "long"],
  details: ["idle", "fallback", "running", "long"],
};
// A phone-width window (under 640 px) collapses an unfocused composer: its controls rest
// inline at the composer's foot, or in the strip a thread with a branch mounts above it.
const COLLAPSED_WIDTHS = [320, 360, 400, 440, 520, 600];
const COLLAPSED = [
  ["thread", null, ["idle", "next", "fallback", "long"]],
  ["thread", "strip", ["idle", "next", "fallback", "long"]],
  ["details", null, ["idle", "fallback", "long"]],
];
const FITS = ["full", "model", "short", "name", "icon"];
const identity = "Codex · GPT-6.1-Sol";
// A custom model id longer than any toolbar has room for: it truncates, never vanishes.
const LONG_MODEL = "gpt-6.1-sol-codex-max-2026-10-01-preview";
const identityFor = (scenario) => (scenario === "long" ? `Codex · ${LONG_MODEL}` : identity);
const statePhrase = {
  thread: {
    next: "next message uses Claude Code · Opus 5.5",
    fallback: "fallback for Claude Code · Opus 5.5",
    running: "saved model Claude Code · Opus 5.5",
  },
  coordinator: {
    fallback: "fallback for Claude Code · Opus 5.5",
    running: "running on Codex · GPT-6.1-Sol",
  },
};
statePhrase.design = statePhrase.thread;
statePhrase.details = statePhrase.coordinator;

const receipt = {
  headless: true,
  generatedAt: new Date().toISOString(),
  cases: [],
  focus: [],
  late: [],
};
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

async function open({ surface, scenario, theme, cssWidth, zoom, viewport, host }) {
  const page = await browser.newPage({
    viewport: { width: viewport ?? Math.max(cssWidth + 160, 1100), height: 560 },
    deviceScaleFactor: zoom,
    colorScheme: theme,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(
    `http://127.0.0.1:${server.address().port}/?surface=${surface}&case=${scenario}&width=${cssWidth}&theme=${theme}${host ? `&host=${host}` : ""}`,
  );
  await page.locator('[data-fixture-ready="true"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { page, errors };
}

function measure() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (color) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const luminance = ([r, g, b]) => {
    const [R, G, B] = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  // The colour behind an element: its translucent ancestors composited over the page.
  const backdrop = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    let base = [255, 255, 255];
    for (const [r, g, b, a] of layers.toReversed())
      base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    return base;
  };
  const contrast = (element) => {
    const fg = rgba(getComputedStyle(element).color);
    const bg = backdrop(element);
    const blended = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const [a, b] = [luminance(blended), luminance(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  };
  const container = document.querySelector("[data-fixture-composer]");
  // A collapsed composer's controls rest outside its footer.
  const resting = document.querySelector('[data-chat-composer-resting-controls="true"]');
  const footer =
    resting ??
    document.querySelector('[data-chat-composer-footer="true"]') ??
    document.querySelector(".sws-composer-foot");
  const chip = document.querySelector("[data-chat-provider-model-picker]");
  // The thread toolbar scrolls rather than wraps: a control past its edge is cut off.
  const scroller = footer.querySelector('[data-chat-composer-controls="left"]');
  const controls = [...footer.querySelectorAll("button, [role='button'], [role='combobox']")]
    .filter((element) => {
      if (element.closest("[inert]") || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    })
    .map((element) => ({
      name: element.getAttribute("aria-label") ?? element.textContent.trim().slice(0, 40),
      ...box(element),
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      // Words cut short, such as the coordinator's effort read as "L": the control's own
      // overflow, or a label that clips its own.
      clippedLabels: [
        ...(getComputedStyle(element).overflowX !== "visible" &&
        element.scrollWidth > element.clientWidth + 1
          ? [element.textContent.trim()]
          : []),
        ...[...element.querySelectorAll("[data-composer-control-label]")]
          .filter((label) => getComputedStyle(label).position !== "absolute")
          .filter((label) => label.scrollWidth > label.clientWidth + 1)
          .map((label) => label.textContent),
      ],
      scrolled: scroller?.contains(element) ? box(scroller) : null,
    }));
  const parts = [...chip.querySelectorAll("[data-model-chip-part]")].map((part) => {
    const style = getComputedStyle(part);
    const shown = style.position !== "absolute" && style.visibility !== "hidden";
    return {
      part: part.dataset.modelChipPart,
      shown,
      text: part.textContent,
      natural: part.scrollWidth,
      fontSize: Number.parseFloat(style.fontSize),
      clipped: part instanceof HTMLElement && shown && part.scrollWidth > part.clientWidth + 1,
      width: part.getBoundingClientRect().width,
      contrast: shown && part instanceof HTMLElement ? contrast(part) : null,
      ...box(part),
    };
  });
  return {
    resting: resting
      ? {
          visible: !resting.closest("[inert]") && getComputedStyle(resting).visibility !== "hidden",
        }
      : null,
    fit: chip.dataset.modelFit ?? null,
    aria: chip.getAttribute("aria-label"),
    chip: box(chip),
    container: box(container),
    controls,
    parts,
  };
}

function overlaps(controls) {
  const found = [];
  for (let i = 0; i < controls.length; i++)
    for (let j = i + 1; j < controls.length; j++) {
      const [a, b] = [controls[i], controls[j]];
      if (
        a.left < b.right - 0.5 &&
        b.left < a.right - 0.5 &&
        a.top < b.bottom - 0.5 &&
        b.top < a.bottom - 0.5
      )
        found.push(`${a.name} × ${b.name}`);
    }
  return found;
}

async function runCase(input) {
  const { surface, scenario, theme, cssWidth, zoom, label, host, collapsed = false } = input;
  const { page, errors } = await open(input);
  const result = await page.evaluate(measure);
  const group = [surface, host, collapsed && "collapsed"].filter(Boolean).join("-");
  const id = `${group} ${scenario} ${label} ${theme}`;
  check(errors.length === 0, `${id}: page errors ${errors.join("; ")}`);
  check(
    collapsed ? result.resting?.visible === true : result.resting === null,
    `${id}: composer ${collapsed ? "did not rest its controls in view" : "collapsed"}`,
  );
  check(result.fit !== null, `${id}: chip has no fit`);
  const collisions = overlaps(result.controls);
  check(collisions.length === 0, `${id}: overlapping controls ${collisions.join(", ")}`);
  for (const control of result.controls) {
    check(
      control.right <= result.container.right + 0.5 && control.left >= result.container.left - 0.5,
      `${id}: ${control.name} outside the composer`,
    );
    check(
      control.width >= 24 && control.height >= 24,
      `${id}: ${control.name} target ${control.width}x${control.height}`,
    );
    check(
      control.clippedLabels.length === 0,
      `${id}: ${control.name} label clipped (${control.clippedLabels.join(", ")})`,
    );
    if (control.scrolled)
      check(
        control.right <= control.scrolled.right + 0.5 &&
          control.left >= control.scrolled.left - 0.5,
        `${id}: ${control.name} cut off by the toolbar edge`,
      );
  }
  for (const part of result.parts.filter((p) => p.shown)) {
    // Only `name` may end a long model name in an ellipsis, and it keeps three ems of it;
    // a name under six ems shows whole.
    if (part.part === "model" && result.fit === "name" && part.natural > 6 * part.fontSize)
      check(
        part.width >= 3 * part.fontSize - 1,
        `${id}: model name cut to ${Math.round(part.width)}px`,
      );
    else check(!part.clipped, `${id}: ${part.part} clipped`);
    check(part.right <= result.chip.right + 0.5, `${id}: ${part.part} outside the chip`);
    if (part.contrast !== null)
      check(part.contrast >= 4.5, `${id}: ${part.part} contrast ${part.contrast.toFixed(2)}`);
  }
  // Every fit but `icon` names the model, and only the narrowest panes give it up: a
  // short name shows whole or not at all, and `icon` keeps the usage ring.
  check(
    result.fit === "icon" || result.parts.some((p) => p.part === "model" && p.shown),
    `${id}: model name hidden at fit ${result.fit}`,
  );
  check(result.fit !== "icon" || cssWidth <= 360, `${id}: fit icon at ${cssWidth}px`);
  check(
    result.aria?.includes(identityFor(scenario)),
    `${id}: accessible name lacks ${identityFor(scenario)}: ${result.aria}`,
  );
  const phrase = statePhrase[surface][scenario];
  if (phrase) check(result.aria.includes(phrase), `${id}: accessible name lacks "${phrase}"`);
  const dir = NodePath.join(output, group);
  await NodeFSP.mkdir(dir, { recursive: true });
  const file = NodePath.join(dir, `${scenario}-${label}-${theme}.png`);
  await page.locator("[data-fixture-composer]").first().screenshot({ path: file });
  receipt.cases.push({
    surface,
    host: host ?? null,
    collapsed,
    scenario,
    theme,
    label,
    cssWidth,
    zoom,
    fit: result.fit,
    aria: result.aria,
    shown: result.parts.filter((p) => p.shown).map((p) => p.part),
    controls: result.controls.map(
      (c) => `${c.name} ${Math.round(c.width)}x${Math.round(c.height)}`,
    ),
    screenshot: file,
  });
  await page.close();
}

// A control that joins the chip's group after load, as an effort does when a coordinator
// run ends: the chip gives it room without a resize of its own.
async function runLateSibling({ surface, scenario, theme, cssWidth }) {
  const { page, errors } = await open({ surface, scenario, theme, cssWidth, zoom: 1 });
  const id = `late ${surface} ${scenario} ${cssWidth} ${theme}`;
  const before = await page.evaluate(measure);
  await page.evaluate(() => {
    const chip = document.querySelector("[data-chat-provider-model-picker]");
    const late = document.createElement("button");
    late.type = "button";
    late.setAttribute("aria-label", "Late control");
    late.style.cssText = "flex: none; width: 140px; height: 28px";
    chip.after(late);
  });
  await page.waitForTimeout(250);
  const after = await page.evaluate(measure);
  const late = after.controls.find((control) => control.name === "Late control");
  check(errors.length === 0, `${id}: page errors ${errors.join("; ")}`);
  check(
    FITS.indexOf(after.fit) > FITS.indexOf(before.fit),
    `${id}: fit stayed ${before.fit} -> ${after.fit}`,
  );
  check(
    late && late.right <= after.container.right + 0.5,
    `${id}: the late control is outside the composer (${late?.right} > ${after.container.right})`,
  );
  if (late?.scrolled)
    check(late.right <= late.scrolled.right + 0.5, `${id}: the late control is cut off`);
  check(overlaps(after.controls).length === 0, `${id}: overlapping controls`);
  const file = NodePath.join(output, "late", `${surface}-${scenario}-${cssWidth}-${theme}.png`);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await page.locator("[data-fixture-composer]").first().screenshot({ path: file });
  receipt.late.push({
    surface,
    scenario,
    theme,
    cssWidth,
    before: before.fit,
    after: after.fit,
    screenshot: file,
  });
  await page.close();
}

async function runFocus({ surface, scenario, theme, cssWidth }) {
  const { page, errors } = await open({ surface, scenario, theme, cssWidth, zoom: 1 });
  const id = `focus ${surface} ${scenario} ${cssWidth} ${theme}`;
  // Start in the message field, then walk the toolbar with the keyboard only.
  const field = page.locator(
    surface === "coordinator"
      ? ".sws-composer textarea"
      : '[data-testid="composer-editor"], [contenteditable="true"]',
  );
  await field.first().click();
  const order = [];
  let tooltip = null;
  let ring = null;
  const record = { surface, scenario, theme, cssWidth, tooltip, ring, order, screenshot: null };
  receipt.focus.push(record);
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(120);
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      // The walk ends where focus leaves the composer.
      if (!element || !element.closest("[data-fixture-composer]")) return null;
      const rect = element.getBoundingClientRect();
      return {
        name: element.getAttribute("aria-label") ?? element.textContent.trim().slice(0, 40),
        chip: element.hasAttribute("data-chat-provider-model-picker"),
        visible: rect.width > 0 && rect.height > 0 && !element.closest("[inert]"),
        focusVisible: element.matches(":focus-visible"),
        ring:
          getComputedStyle(element).boxShadow !== "none" ||
          getComputedStyle(element).outlineStyle !== "none",
      };
    });
    if (!focused) break;
    order.push(focused.name);
    check(focused.visible, `${id}: focus reached a hidden control ${focused.name}`);
    if (focused.chip && tooltip === null) {
      ring = focused.focusVisible && focused.ring;
      await page.waitForTimeout(700);
      tooltip = await page.evaluate(() =>
        [...document.querySelectorAll("[data-slot='tooltip-popup'], [role='tooltip']")]
          .map((element) => element.textContent)
          .join(" | "),
      );
      const file = NodePath.join(
        output,
        "focus",
        `${surface}-${scenario}-${cssWidth}-${theme}.png`,
      );
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      Object.assign(record, { tooltip, ring, screenshot: file });
    }
  }
  check(errors.length === 0, `${id}: page errors ${errors.join("; ")}`);
  check(ring === true, `${id}: the chip shows no keyboard focus ring`);
  check(tooltip?.includes(identity), `${id}: focus tooltip lacks ${identity}: ${tooltip}`);
  const chipAt = order.findIndex(
    (name) => name?.startsWith("Model:") || name?.startsWith("Coordinator model"),
  );
  check(chipAt >= 0, `${id}: Tab never reached the model chip (${order.join(" > ")})`);
  const attachAt = order.indexOf("Attach files");
  // The thread toolbar reads model, then its options, then attach and send; the
  // coordinator's card holds send, and its footer reads attach, model, effort, access.
  if (surface === "coordinator")
    check(
      attachAt < chipAt && chipAt < order.indexOf("Access: Full access"),
      `${id}: focus order ${order.join(" > ")}`,
    );
  else check(chipAt < attachAt, `${id}: focus order ${order.join(" > ")}`);
  await page.close();
}

try {
  for (const [surface, scenarios] of Object.entries(SURFACES))
    for (const scenario of scenarios)
      for (const theme of ["light", "dark"]) {
        const fits = [];
        for (const width of WIDTHS) {
          await runCase({ surface, scenario, theme, cssWidth: width, zoom: 1, label: `${width}` });
          fits.push(receipt.cases.at(-1).fit);
        }
        // Wider never shows less.
        for (let i = 1; i < fits.length; i++)
          check(
            FITS.indexOf(fits[i]) <= FITS.indexOf(fits[i - 1]),
            `${surface} ${scenario} ${theme}: fits not monotonic ${fits.join(",")}`,
          );
        for (const [pane, viewport] of ZOOM_PANES)
          await runCase({
            surface,
            scenario,
            theme,
            cssWidth: pane,
            zoom: 2,
            viewport,
            label: `z200-${pane}`,
          });
      }
  for (const [surface, host, scenarios] of COLLAPSED)
    for (const scenario of scenarios)
      for (const theme of ["light", "dark"]) {
        const fits = [];
        for (const width of COLLAPSED_WIDTHS) {
          await runCase({
            surface,
            scenario,
            theme,
            host,
            collapsed: true,
            cssWidth: width,
            viewport: width,
            zoom: 1,
            label: `${width}`,
          });
          fits.push(receipt.cases.at(-1).fit);
        }
        for (let i = 1; i < fits.length; i++)
          check(
            FITS.indexOf(fits[i]) <= FITS.indexOf(fits[i - 1]),
            `${surface} ${host ?? "inline"} collapsed ${scenario} ${theme}: fits not monotonic ${fits.join(",")}`,
          );
      }
  for (const theme of ["light", "dark"])
    for (const [surface, scenario, cssWidth] of [
      ["coordinator", "running", 400],
      ["details", "running", 400],
    ])
      await runLateSibling({ surface, scenario, theme, cssWidth });
  for (const theme of ["light", "dark"])
    for (const [surface, scenario, cssWidth] of [
      ["thread", "fallback", 360],
      ["thread", "next", 1024],
      ["design", "next", 320],
      ["coordinator", "fallback", 360],
      ["details", "idle", 400],
    ])
      await runFocus({ surface, scenario, theme, cssWidth });
  receipt.failures = failures;
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  if (failures.length) {
    console.error(failures.join("\n"));
    console.error(`FAIL ${failures.length} of ${receipt.cases.length} cases; ${output}`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS ${receipt.cases.length} width/zoom cases, ${receipt.late.length} late-control checks and ${receipt.focus.length} keyboard walks; ${output}`,
    );
  }
} finally {
  await browser.close();
  server.close();
}
