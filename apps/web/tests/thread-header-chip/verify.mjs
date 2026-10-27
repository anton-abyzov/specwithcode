// Build first: vp build --config apps/web/tests/thread-header-chip/vite.config.ts
//
// The real thread header's model chip, as Anton's October 26 screenshot shows it: a
// Codex GPT-6-Astra thread on a usage-limit fallback for Opus 5.5, in a panel crowded by
// subagents, artifacts, the response style and the chat's panel toggles. At each width,
// light and dark, in the browser and in the desktop app's title bar:
//
// - the chips line's floor never takes the title's first 3 em, the title always shows its
//   first letters, and nothing in its row runs past the row;
// - the fallback glyph and the provider mark show inside the chip and inside the chips'
//   visible line, unless the title is down to its first 3 em; the model name is whole,
//   or (fit `name`) a long name keeps at least its first 3 em, or (fit `mark`) it is
//   left out whole, never a stub like "G";
// - with a routing decision and a pull request after it, those chips wrap away before
//   the model gives up any of its name, and within one header layout a wider panel never
//   shows less of the name;
// - a badge that appears beside the chips line, or a chip there that grows, refits the
//   line's floor at once, so the title keeps its first 3 em;
// - a screen reader hears the provider, the model and the fallback at every fit;
// - in the desktop title bar the chip is outside the drag region (`-webkit-app-region:
//   no-drag`), or Electron gives hovering it to the window and the tooltip never opens;
// - hovering the chip, and reaching it with Tab, opens the tooltip naming the running
//   model, its provider, the pick it stands in for and why.
//
// Headless Chromium only. Usage: node apps/web/tests/thread-header-chip/verify.mjs <report-dir> [--baseline]
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);

const output = NodePath.resolve(process.argv[2] ?? ".artifacts/thread-header-chip/evidence");
const baseline = process.argv.includes("--baseline");
const site = NodeURL.fileURLToPath(
  new URL("../../../../.artifacts/thread-header-chip/site", import.meta.url),
);
await NodeFS.mkdir(output, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = NodeHttp.createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://fixture").pathname;
  const file = NodePath.join(site, path === "/" ? "index.html" : path);
  try {
    const body = await NodeFS.readFile(file);
    response.writeHead(200, {
      "content-type": types[NodePath.extname(file)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// 700 px is the screenshot's panel (1395 device pixels at 2x).
const WIDTHS = [320, 340, 360, 420, 520, 600, 610, 620, 640, 700, 800, 1000, 1280];
const BUSY_WIDTHS = [420, 520, 600, 610, 620, 640, 700, 800, 840, 880, 920, 1000, 1280];
// The name is compared only within one header layout: the crumb folds to an arrow and the
// chat's panel toggles fold into the menu as the header narrows (shell.css).
// How much of the running name each fit shows; the provider word may still give way to a
// routing or PR chip that comes back onto a wider line.
const NAME_SHOWN = { mark: 0, name: 1, model: 2, full: 2 };
const failures = [];
const receipt = { cases: [], hover: [], focus: [] };
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const MEASURE = `(() => {
  const chip = document.querySelector(".sws-thread-head .sws-model-chip");
  const line = document.querySelector(".sws-thread-head-chips");
  const head = document.querySelector(".sws-thread-head");
  const title = document.querySelector(".sws-thread-head-text h2");
  const text = document.querySelector(".sws-thread-head-text");
  const name = chip.querySelector(".sws-model-name");
  const mark = chip.querySelector(".sws-model-mark");
  const glyph = chip.querySelector(".sws-model-state-glyph");
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
  const chipBox = box(chip), lineBox = box(line), headBox = box(head);
  const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.width > 0;
  const nameStyle = getComputedStyle(name);
  const nameShown = nameStyle.position !== "absolute" && nameStyle.visibility !== "hidden";
  const region = (el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region");
  // What a screen reader hears: text outside aria-hidden and visibility:hidden parts.
  const spoken = (el) => {
    let text = "";
    const walk = (node) => {
      if (node.nodeType === 3) { text += node.data; return; }
      if (node.nodeType !== 1) return;
      if (node.getAttribute("aria-hidden") === "true") return;
      if (getComputedStyle(node).visibility === "hidden") return;
      for (const child of node.childNodes) walk(child);
    };
    walk(el);
    return text.replace(/\\s+/g, " ").trim();
  };
  return {
    fit: chip.dataset.rowFit ?? null,
    chip: chipBox, line: lineBox, head: headBox,
    title: title ? {
      width: title.getBoundingClientRect().width,
      // Its first 3 em, or all of a shorter title (rowModelFit.ts HEADER_TITLE_MIN_EM).
      least: Math.min(title.scrollWidth, 3 * parseFloat(getComputedStyle(title).fontSize)),
      cut: title.scrollWidth > title.clientWidth + 1,
    } : null,
    textOverflow: text.scrollWidth - text.clientWidth,
    // The most the floor may be now (rowModelFit.ts headerFloorRoom): the row's content
    // box, less its gaps, the controls beside the line and the title's first 3 em.
    floorRoom: (() => {
      const style = getComputedStyle(text);
      const items = [...text.children].filter((el) => getComputedStyle(el).display !== "none");
      let room = text.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      room -= (parseFloat(style.columnGap) || 0) * Math.max(0, items.length - 1);
      for (const el of items) {
        if (el === line) continue;
        const own = getComputedStyle(el);
        room -= parseFloat(own.flexShrink) > 0 && parseFloat(own.minWidth) === 0
          ? Math.min(el.scrollWidth, 3 * parseFloat(own.fontSize))
          : el.getBoundingClientRect().width;
      }
      return room;
    })(),
    floor: parseFloat(line.style.getPropertyValue("--sws-model-floor")) || 0,
    // The chip's own width at its fit, past what the line lets it show.
    chipNatural: chip.scrollWidth,
    layout: [".sws-thread-head-tools", ".sws-thread-crumb-label"]
      .map((selector) => getComputedStyle(document.querySelector(selector)).display)
      .join(" "),
    following: [...line.children].filter((el) => el !== chip).map((el) => ({
      name: el.getAttribute("aria-label") ?? el.textContent.trim(),
      onLine: !el.hasAttribute("data-row-wrapped") && getComputedStyle(el).visibility !== "hidden",
      inside: el.getBoundingClientRect().right <= lineBox.right + 0.5,
    })),
    nameShown,
    nameCut: nameShown && name.scrollWidth > name.clientWidth + 1,
    nameWidth: name.getBoundingClientRect().width,
    markInside: inside(box(mark), chipBox) && inside(box(mark), lineBox),
    glyphInside: glyph ? inside(box(glyph), chipBox) && inside(box(glyph), lineBox) : null,
    chipInside: chipBox.right <= headBox.right + 0.5,
    chipRegion: region(chip),
    headRegion: region(head),
    spoken: spoken(chip),
  };
})()`;

const TIP = `(() => {
  const popup = [...document.querySelectorAll('[data-slot="tooltip-popup"], [role="tooltip"]')]
    .find((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden");
  return popup ? popup.innerText.replace(/\\s+/g, " ").trim() : null;
})()`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const narrowerFit = new Map();
try {
  for (const theme of ["light", "dark"]) {
    for (const electron of [false, true]) {
      const mode = electron ? "desktop" : "browser";
      for (const width of WIDTHS) {
        const page = await browser.newPage({
          viewport: { width, height: 240 },
          deviceScaleFactor: 2,
          colorScheme: theme,
        });
        await page.goto(`${origin}/?theme=${theme}${electron ? "&electron=1" : ""}`);
        await page.waitForSelector("body[data-fixture-ready] .sws-thread-head .sws-model-chip");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(50);
        const at = await page.evaluate(MEASURE);
        receipt.cases.push({ theme, mode, width, ...at });
        const label = `${theme} ${mode} ${width}px`;
        check(`${label}: the chip's floor never takes the title's first 3 em`, () =>
          NodeAssert.ok(
            at.title.width >= at.title.least - 1 || at.line.width > at.floor + 0.5,
            JSON.stringify(at),
          ),
        );
        check(`${label}: the title shows its first letters`, () =>
          NodeAssert.ok(at.title.width >= Math.min(at.title.least, 12), JSON.stringify(at.title)),
        );
        check(`${label}: nothing beside the title runs past its row`, () =>
          NodeAssert.ok(at.textOverflow <= 1, JSON.stringify(at)),
        );
        // Only the title's first 3 em may cut the leanest chip: its floor was capped below it.
        check(`${label}: the fallback glyph shows inside the chip and its line`, () =>
          NodeAssert.ok(
            (at.glyphInside && at.markInside) ||
              (at.fit === "mark" && at.floor < at.chipNatural - 1),
            JSON.stringify(at),
          ),
        );
        const narrower = narrowerFit.get(`${theme} ${mode}`);
        narrowerFit.set(`${theme} ${mode}`, { fit: at.fit, layout: at.layout });
        check(`${label}: a wider panel in the same layout shows no less of the name`, () =>
          NodeAssert.ok(
            !narrower ||
              narrower.layout !== at.layout ||
              NAME_SHOWN[at.fit] >= NAME_SHOWN[narrower.fit],
            `${narrower?.fit} then ${at.fit}`,
          ),
        );
        check(`${label}: the model name is whole, keeps 3 em, or is left out whole`, () => {
          if (at.fit === "name")
            NodeAssert.ok(at.nameShown && at.nameWidth >= 3 * 12 - 1, JSON.stringify(at));
          else if (at.fit === "mark") NodeAssert.ok(!at.nameShown, JSON.stringify(at));
          else NodeAssert.ok(at.nameShown && !at.nameCut, JSON.stringify(at));
        });
        check(`${label}: the chip stays inside the header`, () =>
          NodeAssert.ok(at.chipInside, JSON.stringify(at)),
        );
        check(`${label}: a screen reader hears provider, model and fallback`, () => {
          NodeAssert.match(at.spoken, /Codex\s*GPT-6-Astra/, at.spoken);
          NodeAssert.match(at.spoken, /fallback for Claude Code · Opus 5\.5 \(usage limit\)/);
        });
        if (electron)
          check(`${label}: the chip takes the pointer in the title bar`, () => {
            NodeAssert.equal(at.headRegion, "drag", JSON.stringify(at));
            NodeAssert.equal(at.chipRegion, "no-drag", JSON.stringify(at));
          });
        const shot = NodePath.join(output, `${mode}-${width}-${theme}.png`);
        await page.locator("[data-panel]").screenshot({ path: shot });

        if (width === 700 || width === 420 || width === 1280) {
          await page.hover(".sws-thread-head .sws-model-chip");
          await page.waitForTimeout(900);
          const tip = await page.evaluate(TIP);
          receipt.hover.push({ theme, mode, width, tip });
          check(`${label}: hovering the chip names the model, provider and fallback`, () => {
            NodeAssert.ok(tip, "no tooltip opened");
            NodeAssert.match(tip, /Codex · GPT-6-Astra/);
            NodeAssert.match(tip, /Fallback for your pick, Claude Code · Opus 5\.5/);
            NodeAssert.match(tip, /hit its usage limit\./);
            // This is the open thread: its composer, not "open the thread", is the way back.
            NodeAssert.doesNotMatch(tip, /Open the thread/);
          });
          await page.screenshot({
            path: NodePath.join(output, `${mode}-${width}-${theme}-hover.png`),
            clip: { x: 0, y: 0, width, height: 200 },
          });
          await page.mouse.move(width - 2, 230);
          await page.waitForTimeout(400);

          // Keyboard: Tab from the back button reaches the chip, and focus opens the tooltip.
          await page.locator(".sws-thread-crumb").focus();
          let reached = false;
          for (let step = 0; step < 6 && !reached; step += 1) {
            await page.keyboard.press("Tab");
            reached = await page.evaluate(() =>
              document.activeElement?.matches(".sws-thread-head .sws-model-chip"),
            );
          }
          await page.waitForTimeout(900);
          const focusTip = reached ? await page.evaluate(TIP) : null;
          receipt.focus.push({ theme, mode, width, reached, tip: focusTip });
          check(`${label}: Tab reaches the chip and focus opens its tooltip`, () => {
            NodeAssert.ok(reached, "Tab never reached the model chip");
            NodeAssert.match(focusTip ?? "", /Codex · GPT-6-Astra/);
          });
          await page.screenshot({
            path: NodePath.join(output, `${mode}-${width}-${theme}-focus.png`),
            clip: { x: 0, y: 0, width, height: 200 },
          });
        }
        await page.close();
      }
    }
  }

  // A routing decision and a pull request after the model chip: they wrap away, whole,
  // before the model gives up any of its name.
  for (const theme of ["light", "dark"]) {
    let narrower = null;
    for (const width of BUSY_WIDTHS) {
      const page = await browser.newPage({
        viewport: { width, height: 240 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      await page.goto(`${origin}/?theme=${theme}&scenario=busy`);
      await page.waitForSelector("body[data-fixture-ready] .sws-thread-head .sws-model-chip");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(50);
      const at = await page.evaluate(MEASURE);
      receipt.cases.push({ theme, mode: "busy", width, ...at });
      const label = `${theme} busy ${width}px`;
      check(`${label}: the routing and PR chips leave before the model's name`, () => {
        if (at.fit === "name" || at.fit === "mark")
          NodeAssert.ok(
            at.following.every((chip) => !chip.onLine),
            JSON.stringify(at),
          );
      });
      check(`${label}: a chip on the line shows whole`, () =>
        NodeAssert.ok(
          at.following.every((chip) => !chip.onLine || chip.inside),
          JSON.stringify(at.following),
        ),
      );
      check(`${label}: a wider panel in the same layout shows no less of the name`, () =>
        NodeAssert.ok(
          narrower === null ||
            narrower.layout !== at.layout ||
            NAME_SHOWN[at.fit] >= NAME_SHOWN[narrower.fit],
          `${narrower?.fit} then ${at.fit}`,
        ),
      );
      check(`${label}: the fallback glyph shows inside the chip and its line`, () =>
        NodeAssert.ok(
          (at.glyphInside && at.markInside) || (at.fit === "mark" && at.floor < at.chipNatural - 1),
          JSON.stringify(at),
        ),
      );
      check(`${label}: nothing beside the title runs past its row`, () =>
        NodeAssert.ok(at.textOverflow <= 1, JSON.stringify(at)),
      );
      narrower = { fit: at.fit, layout: at.layout };
      await page
        .locator("[data-panel]")
        .screenshot({ path: NodePath.join(output, `busy-${width}-${theme}.png`) });
      await page.close();
    }
  }

  // A long title in the desktop title bar, then what arrives after the header renders: a
  // handoff status beside the chips line (a new element), the subagents chip's count
  // growing (new text) and that chip widening with no change to the page's elements
  // (a style). Each refits the line's floor before the next frame paints; what still runs
  // past the row with no floor at all is the row's own minimum, as on main.
  const fits = (at) =>
    at.floor <= Math.max(0, Math.floor(at.floorRoom)) + 1 &&
    (at.textOverflow <= 1 || at.floor === 0);
  for (const width of [560, 640, 680]) {
    const page = await browser.newPage({ viewport: { width, height: 240 }, deviceScaleFactor: 2 });
    await page.goto(`${origin}/?electron=1&title=long`);
    await page.waitForSelector("body[data-fixture-ready] .sws-thread-head .sws-model-chip");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(50);
    const frames = () =>
      page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
    const steps = {
      loaded: async () => {},
      // HandoffThreadHeaderBadge's status chip.
      "handoff status appears": () =>
        page.evaluate(() => {
          const badge = document.createElement("span");
          badge.className = "sws-chip";
          badge.setAttribute("role", "status");
          badge.textContent = "Behind";
          document.querySelector(".sws-subagents-chip").before(badge);
        }),
      "subagent count grows": () =>
        page.evaluate(() => {
          document.querySelector(".sws-subagents-chip").lastChild.data = "21 · 3";
        }),
      "subagents chip widens": () =>
        page.evaluate(() => {
          document.querySelector(".sws-subagents-chip").style.paddingInline = "12px";
        }),
    };
    for (const [step, run] of Object.entries(steps)) {
      await run();
      await frames();
      const at = await page.evaluate(MEASURE);
      receipt.cases.push({ theme: "light", mode: "late", width, step, ...at });
      check(`late ${width}px, ${step}: the floor is refit to the room beside the title`, () =>
        NodeAssert.ok(fits(at), JSON.stringify(at)),
      );
    }
    await page
      .locator("[data-panel]")
      .screenshot({ path: NodePath.join(output, `late-long-${width}.png`) });
    await page.close();
  }

  // A second Codex account: the tooltip names the connection that runs it.
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 240 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    await page.goto(`${origin}/?theme=${theme}&scenario=account`);
    await page.waitForSelector("body[data-fixture-ready] .sws-thread-head .sws-model-chip");
    await page.hover(".sws-thread-head .sws-model-chip");
    await page.waitForTimeout(900);
    const tip = await page.evaluate(TIP);
    receipt.hover.push({ theme, mode: "account", width: 1000, tip });
    check(`${theme} account: the tooltip names the Codex Work connection`, () =>
      NodeAssert.match(tip ?? "", /Codex Work/),
    );
    await page.screenshot({
      path: NodePath.join(output, `account-1000-${theme}-hover.png`),
      clip: { x: 0, y: 0, width: 1000, height: 200 },
    });
    await page.close();
  }

  // A usage pre-switch moved the idle thread before the limit: nothing "hit" it.
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 240 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    await page.goto(`${origin}/?theme=${theme}&scenario=preswitch`);
    await page.waitForSelector("body[data-fixture-ready] .sws-thread-head .sws-model-chip");
    await page.hover(".sws-thread-head .sws-model-chip");
    await page.waitForTimeout(900);
    const tip = await page.evaluate(TIP);
    const spoken = await page.evaluate(
      () => document.querySelector(".sws-thread-head .sws-model-state .sr-only")?.textContent ?? "",
    );
    receipt.hover.push({ theme, mode: "preswitch", width: 1000, tip, spoken });
    check(`${theme} preswitch: the tooltip says the pick neared its limit, not hit it`, () => {
      NodeAssert.match(tip ?? "", /Fallback for your pick, Claude Code · Opus 5\.5/);
      NodeAssert.match(tip ?? "", /Opus 5\.5 neared its usage limit, so this thread moved/);
      NodeAssert.doesNotMatch(tip ?? "", /hit its|Open the thread/);
      NodeAssert.match(spoken, /fallback for Claude Code · Opus 5\.5 \(near its usage limit\)/);
    });
    await page.screenshot({
      path: NodePath.join(output, `preswitch-1000-${theme}-hover.png`),
      clip: { x: 0, y: 0, width: 1000, height: 200 },
    });
    await page.close();
  }

  // A thread on its own pick: the tooltip still names the model and its provider.
  const plain = await browser.newPage({ viewport: { width: 1000, height: 240 } });
  await plain.goto(`${origin}/?scenario=plain`);
  await plain.waitForSelector("body[data-fixture-ready] .sws-thread-head .sws-model-chip");
  await plain.hover(".sws-thread-head .sws-model-chip");
  await plain.waitForTimeout(900);
  const plainTip = await plain.evaluate(TIP);
  receipt.hover.push({ theme: "light", mode: "plain", width: 1000, tip: plainTip });
  check("plain: the tooltip names the model and its provider", () =>
    NodeAssert.match(plainTip ?? "", /Codex · GPT-6-Astra/),
  );
  await plain.close();
} finally {
  await browser.close();
  server.close();
}

receipt.checks = checks;
receipt.failures = failures;
await NodeFS.writeFile(
  NodePath.join(output, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
if (failures.length > 0) {
  console.error(`thread header chip: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  if (!baseline) process.exit(1);
} else {
  console.log(`thread header chip ok: ${checks} checks; evidence in ${output}`);
}
