// Build first: vp build --config apps/web/tests/thread-row-meta/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/thread-row-meta/model-unit.mjs [/absolute/evidence-dir]
//
// The model unit of a thread on its usage-limit fallback, across pane widths, in light
// and dark: the running model first and never cut, then the fallback glyph alone (the
// pick it stands in for is in the tooltip and the accessible name). The provider word
// gives way whole before the line's plan or PR is pushed off. In the thread header, a
// chip that wraps away leaves sight and the Tab order. Also the keyboard path to the
// words the compact form leaves out, a phone tap on the header chip, and the Unplanned
// glyph's name and explanation.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/thread-row-meta/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/thread-row-meta/model-unit");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
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
const WIDTHS = [320, 360, 420, 520, 640, 900];
const FITS = ["full", "model"];
// `twin` falls back to the same model on another provider (Devin's GPT-6.1 Sol).
const FALLBACKS = ["matchcam", "setup", "orchestrators", "fresh", "approval", "twin"];
// "Approval requested" is the longest status word. Beside a fallback in a 320px pane the
// line cannot hold it, the mark, the whole name and the glyph: the name keeps its
// minimum and the glyph, and the receipt records it.
const LONG_STATUS = new Set(["approval"]);
const receipt = {
  headless: true,
  checks: [],
  rows: {},
  nameCutWithLongStatus: [],
  header: {},
  touch: {},
  screenshots: [],
};
const check = (name, fn) => {
  fn();
  receipt.checks.push(name);
};

// What a screen reader reads: text that is neither aria-hidden nor visibility-hidden.
const ACCESSIBLE_TEXT = `(root) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent.closest('[aria-hidden="true"]')) continue;
    if (getComputedStyle(parent).visibility === "hidden") continue;
    text += node.data;
  }
  return text.replace(/\\s+/g, " ").trim();
}`;

const readUnits = (ids) =>
  ids.map((id) => {
    const row = document.querySelector(`.sws-thread-row[data-thread-id=${id}]`);
    const meta = row.querySelector(".sws-thread-meta");
    const metaBox = meta.getBoundingClientRect();
    const unit = meta.querySelector(".sws-model");
    const name = unit.querySelector(".sws-model-name");
    const shown = (el) => getComputedStyle(el).visibility !== "hidden";
    const parts = [...unit.querySelectorAll("[data-row-part]")].map((part) => ({
      part: part.dataset.rowPart,
      shown: shown(part),
      right: part.getBoundingClientRect().right,
      hidden: part.getAttribute("aria-hidden"),
    }));
    const unitRight = Math.max(
      unit.querySelector(".sws-model-state").getBoundingClientRect().right,
      ...parts.filter((part) => part.shown).map((part) => part.right),
    );
    // Chips after the unit that the room is left for (not the machine name or an error).
    const rest = [...meta.querySelectorAll(".sws-thread-meta-rest > *")]
      .filter((chip) => !chip.matches(".sws-thread-machine, .sws-thread-error"))
      .map((chip) => {
        const box = chip.getBoundingClientRect();
        return {
          text: chip.textContent.replace(/\s+/g, " ").trim(),
          onLine: box.top < metaBox.bottom - 0.5 && box.right <= metaBox.right + 0.5,
          left: box.left,
          top: box.top,
        };
      });
    const visible = [
      ...unit.querySelectorAll(".sws-model-provider, .sws-model-name, [data-row-part]"),
    ]
      .filter((el) => shown(el) && !el.closest(".sr-only"))
      .map((el) => el.textContent.trim())
      .filter(Boolean)
      .join(" ");
    const status = meta.querySelector(".sws-thread-status");
    const statusText = (() => {
      if (!status) return null;
      const range = document.createRange();
      range.selectNodeContents(status);
      return range.getBoundingClientRect().right;
    })();
    const mark = unit.querySelector(".sws-model-mark");
    const glyph = unit.querySelector("[data-fallback-glyph]");
    const unitBox = unit.getBoundingClientRect();
    return {
      id,
      status: status
        ? {
            cut: status.scrollWidth > status.clientWidth + 1,
            // From the status word's last letter to the running provider's mark.
            gap: mark.getBoundingClientRect().left - statusText,
          }
        : null,
      dot: getComputedStyle(unit, "::before").display,
      glyphInside: !!glyph && glyph.getBoundingClientRect().right <= unitBox.right + 0.5,
      nameShown: name.clientWidth,
      fit: unit.dataset.rowFit ?? null,
      metaWidth: metaBox.width,
      nameCut: name.scrollWidth > name.clientWidth + 1,
      nameRight: name.getBoundingClientRect().right,
      unitRight,
      metaRight: metaBox.right,
      unitTop: unit.getBoundingClientRect().top,
      parts,
      rest,
      visible,
      glyph: !!unit.querySelector("[data-fallback-glyph]"),
      aria: unit.querySelector(".sws-model-state .sr-only")?.textContent ?? "",
      provider: unit.querySelector("[data-model-provider-name]")?.textContent.trim() ?? "",
      // What the state shows after the glyph, outside the sentence for screen readers.
      stateShown: [...unit.querySelector(".sws-model-state").childNodes]
        .filter((node) => !(node instanceof Element && node.matches(".sr-only")))
        .map((node) => node.textContent.trim())
        .join(""),
    };
  });

// The pane pages its threads: open every page so the oldest fallback rows mount too.
async function showAllThreads(page) {
  const more = page.locator(".sws-show-more", { hasText: "Show more" });
  while ((await more.count()) > 0) {
    await more.first().click();
  }
}

const settle = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );

try {
  for (const theme of ["light", "dark"]) {
    const byRow = Object.fromEntries(FALLBACKS.map((id) => [id, []]));
    for (const width of WIDTHS) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.waitForSelector("body[data-fixture-ready]");
      await showAllThreads(page);
      await page.evaluate(() => document.fonts.ready);
      // Every fallback row has taken a fit before anything is read.
      await page.waitForFunction(
        (ids) =>
          ids.every((id) =>
            document.querySelector(
              `.sws-thread-row[data-thread-id=${id}] .sws-model[data-row-fit]`,
            ),
          ),
        FALLBACKS,
      );
      const units = await page.evaluate(readUnits, FALLBACKS);
      check(`${theme} ${width}px: no page errors`, () => NodeAssert.deepEqual(errors, []));
      for (const unit of units) {
        byRow[unit.id].push({ width, ...unit });
        const label = `${theme} ${width}px ${unit.id}`;
        // A status word beside the unit (Answer needed at 320px) still leaves it whole.
        if (LONG_STATUS.has(unit.id) && unit.nameCut) {
          receipt.nameCutWithLongStatus.push(label);
          check(`${label}: beside the longest status word the name keeps its minimum`, () => {
            NodeAssert.equal(unit.fit, FITS.at(-1), label);
            NodeAssert.ok(unit.nameShown >= 40, `${unit.nameShown}`);
          });
        } else
          check(`${label}: the running model's name is whole`, () =>
            NodeAssert.equal(unit.nameCut, false, label),
          );
        check(`${label}: the fallback glyph is never clipped`, () =>
          NodeAssert.ok(unit.glyphInside, label),
        );
        check(`${label}: a screen reader hears the running provider at every fit`, () =>
          NodeAssert.equal(unit.provider, unit.id === "twin" ? "Devin" : "Codex"),
        );
        if (unit.status) {
          check(`${label}: the status word is whole and set apart from the unit`, () => {
            NodeAssert.equal(unit.status.cut, false, label);
            NodeAssert.ok(unit.status.gap >= 5, `${label}: gap ${unit.status.gap}`);
          });
        }
        check(`${label}: the running model's name stays on its line`, () =>
          NodeAssert.ok(unit.nameRight <= unit.metaRight + 0.5),
        );
        check(`${label}: the unit stays inside its line`, () =>
          NodeAssert.ok(
            unit.unitRight <= unit.metaRight + 0.5,
            `${unit.unitRight} > ${unit.metaRight}`,
          ),
        );
        check(`${label}: the fallback glyph shows at every fit`, () => NodeAssert.ok(unit.glyph));
        check(`${label}: the fallback is its glyph alone, with no home pick`, () => {
          NodeAssert.equal(unit.stateShown, "", label);
          NodeAssert.ok(
            unit.parts.every((part) => part.part === "provider"),
            label,
          );
        });
        check(`${label}: the accessible name keeps the pick and the reason`, () =>
          NodeAssert.match(unit.aria, /^, fallback for .+ \(usage limit\)$/),
        );
        check(`${label}: the visible provider word is not read twice`, () =>
          NodeAssert.ok(unit.parts.every((part) => part.hidden === "true")),
        );
        if (unit.fit !== FITS.at(-1)) {
          check(`${label}: the plan and PR keep the line while the provider word shows`, () =>
            NodeAssert.ok(
              unit.rest.every((chip) => chip.onLine),
              JSON.stringify(unit.rest),
            ),
          );
        }
        for (const chip of unit.rest.filter((chip) => chip.onLine)) {
          check(`${label}: ${chip.text} starts after the unit`, () =>
            NodeAssert.ok(chip.left >= unit.unitRight - 0.5 || chip.top > unit.unitTop + 1),
          );
        }
      }
      // Hovering a row keeps its line as it was: the unit was fitted within the hover
      // action's room, so nothing refits or slides under the pointer. A chip at the end
      // may wrap away under the action; none moves.
      for (const id of FALLBACKS) {
        const [before] = await page.evaluate(readUnits, [id]);
        await page.locator(`.sws-thread-row[data-thread-id=${id}] strong`).hover();
        await settle(page);
        const [after] = await page.evaluate(readUnits, [id]);
        await page.mouse.move(0, 0);
        await settle(page);
        const line = (unit) => ({
          fit: unit.fit,
          nameCut: unit.nameCut,
          glyphInside: unit.glyphInside,
          dot: unit.dot,
          metaWidth: Math.round(unit.metaWidth),
        });
        const onLine = (unit) =>
          new Map(
            unit.rest
              .filter((chip) => chip.onLine)
              .map((chip) => [chip.text, Math.round(chip.left)]),
          );
        check(`${theme} ${width}px ${id}: hovering the row changes nothing on its line`, () => {
          NodeAssert.deepEqual(line(after), line(before), id);
          const was = onLine(before);
          for (const [text, left] of onLine(after)) NodeAssert.equal(left, was.get(text), text);
        });
      }

      // A row with a handoff action (HandoffRowAction's button, placed as ThreadsPane
      // places it): on hover the action steps aside for Resolve without narrowing the
      // row's text, so nothing refits, and neither covers the text the line keeps.
      for (const id of ["fresh", "matchcam"]) {
        const row = `.sws-thread-row[data-thread-id=${id}]`;
        await page.evaluate((selector) => {
          const action = document.createElement("button");
          action.type = "button";
          action.className = "sws-thread-handoff-action";
          action.dataset.fixtureHandoff = "";
          action.textContent = "Continue here";
          const host = document.querySelector(selector);
          host.insertBefore(action, host.querySelector(".sws-thread-action"));
        }, row);
        await settle(page);
        const readRow = () =>
          page.evaluate((selector) => {
            const host = document.querySelector(selector);
            const box = (el) => el?.getBoundingClientRect() ?? null;
            const strong = host.querySelector(".sws-thread-text > strong");
            const range = document.createRange();
            range.selectNodeContents(strong);
            const meta = host.querySelector(".sws-thread-meta");
            const metaBox = box(meta);
            const lineEnd = Math.max(
              box(host.querySelector(".sws-model")).right,
              ...[...meta.querySelectorAll(".sws-thread-meta-rest > *")]
                .map(box)
                .filter((chip) => chip.top < metaBox.bottom - 0.5 && chip.right <= metaBox.right)
                .map((chip) => chip.right),
            );
            return {
              open: Math.round(box(host.querySelector(".sws-thread-open")).width),
              fit: host.querySelector(".sws-model").dataset.rowFit,
              textEnd: Math.min(range.getBoundingClientRect().right, box(strong).right),
              lineEnd,
              handoff: box(host.querySelector("[data-fixture-handoff]")),
              resolve: box(host.querySelector(".sws-thread-action")),
            };
          }, row);
        const before = await readRow();
        await page.locator(`${row} strong`).hover();
        await settle(page);
        const after = await readRow();
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.querySelector("[data-fixture-handoff]")?.remove());
        await settle(page);
        check(`${theme} ${width}px ${id}: a handoff row keeps its text and fit on hover`, () => {
          NodeAssert.equal(after.open, before.open, JSON.stringify({ before, after }));
          NodeAssert.equal(after.fit, before.fit);
          NodeAssert.ok(after.handoff.right <= after.resolve.left + 0.5, JSON.stringify(after));
          NodeAssert.ok(after.handoff.left >= after.textEnd - 0.5, JSON.stringify(after));
          NodeAssert.ok(after.handoff.left >= after.lineEnd - 0.5, JSON.stringify(after));
        });
      }

      // The opened thread's header: its chips share the row with the title and buttons.
      const header = await page.evaluate(`(() => {
        const accessibleText = ${ACCESSIBLE_TEXT};
        const chips = document.querySelector("[data-header-fixture] .sws-thread-head-chips");
        const unit = chips.querySelector(".sws-model");
        const name = unit.querySelector(".sws-model-name");
        const glyph = unit.querySelector("[data-fallback-glyph]");
        const box = unit.getBoundingClientRect();
        const chipsBox = chips.getBoundingClientRect();
        const following = [...chips.children].filter((chip) => chip !== unit);
        const shown = (chip) => getComputedStyle(chip).visibility !== "hidden";
        const onLine = following.filter((chip) => chip.getBoundingClientRect().top < box.bottom - 0.5);
        const lastRight = Math.max(box.right, ...onLine.map((chip) => chip.getBoundingClientRect().right));
        // What the next richer fit would add: the parts it shows that this one hides.
        const order = ["model", "full"];
        const adds = { model: ["provider"] };
        const fit = unit.dataset.rowFit ?? null;
        const nextCost = (adds[fit] ?? []).reduce(
          (sum, part) =>
            sum +
            [...unit.querySelectorAll(\`[data-row-part="\${part}"]\`)].reduce(
              (width, el) => width + el.getBoundingClientRect().width,
              0,
            ),
          0,
        );
        return {
          chipsWidth: chipsBox.width,
          fit,
          nameCut: name.scrollWidth > name.clientWidth + 1,
          glyphInside: !!glyph && glyph.getBoundingClientRect().right <= box.right + 0.5,
          unitInside: box.right <= chipsBox.right + 0.5,
          text: accessibleText(unit),
          chips: following.map((chip) => ({
            text: chip.textContent.replace(/\\s+/g, " ").trim(),
            name: chip.getAttribute("aria-label") ?? chip.textContent.replace(/\\s+/g, " ").trim(),
            onLine: onLine.includes(chip),
            inside: chip.getBoundingClientRect().right <= chipsBox.right + 0.5,
            shown: shown(chip),
            marked: chip.hasAttribute("data-row-wrapped"),
          })),
          free: chipsBox.right - lastRight,
          nextCost: order.indexOf(fit) < order.length - 1 ? nextCost : null,
        };
      })()`);
      receipt.header[`${theme}:${width}`] = header;
      check(`${theme} ${width}px header: the running name is whole beside the title`, () => {
        NodeAssert.equal(header.nameCut, false, JSON.stringify(header));
        NodeAssert.ok(header.glyphInside && header.unitInside, JSON.stringify(header));
      });
      check(`${theme} ${width}px header: a chip shows whole on the line or leaves it`, () => {
        for (const chip of header.chips) {
          if (chip.onLine) NodeAssert.ok(chip.shown && chip.inside && !chip.marked, chip.text);
          else NodeAssert.ok(!chip.shown && chip.marked, chip.text);
        }
      });
      // The fit takes the room a wrapped chip gives up: the next richer fit would not fit
      // (its parts plus their gaps, at most two parts of 5 px each, and the 1 px slack).
      if (header.nextCost !== null) {
        check(`${theme} ${width}px header: the unit leaves no richer fit's room unused`, () =>
          NodeAssert.ok(header.free < header.nextCost + 11, JSON.stringify(header)),
        );
      }

      check(`${theme} ${width}px header: a screen reader hears who runs it and why`, () => {
        NodeAssert.match(header.text, /^Codex GPT-6\.1-Sol\b/, header.text);
        NodeAssert.match(header.text, /fallback for Claude Code · Opus 5\.5 \(usage limit\)/);
      });

      if (width === 900) {
        const [matchcam, setup, orchestrators] = units;
        check(`${theme} 900px: a fallback shows its running model in full, then its glyph`, () => {
          NodeAssert.equal(matchcam.fit, "full");
          NodeAssert.equal(setup.fit, "full");
          NodeAssert.match(matchcam.visible, /^Codex · GPT-6\.1-Sol$/);
        });
        check(`${theme} 900px: a same-provider fallback names only the running model`, () => {
          NodeAssert.match(orchestrators.visible, /^Codex · GPT-6-Astra$/);
          NodeAssert.doesNotMatch(orchestrators.visible, /Sol/);
        });
      }
      const file = NodePath.join(output, `rows-${width}-${theme}.png`);
      await page.locator("[data-fixture-pane]").screenshot({ path: file });
      receipt.screenshots.push(file);
      const crop = NodePath.join(output, `row-matchcam-${width}-${theme}.png`);
      await page.locator(".sws-thread-row[data-thread-id=matchcam]").screenshot({ path: crop });
      receipt.screenshots.push(crop);

      if (width === 520) {
        // Keyboard: Tab reaches the header's model chip, and focus names the pick.
        await page.locator("h2").first().click();
        let reached = false;
        for (let step = 0; step < 60 && !reached; step += 1) {
          await page.keyboard.press("Tab");
          reached = await page.evaluate(() =>
            document.activeElement?.matches("[data-header-fixture] .sws-model-chip"),
          );
        }
        check(`${theme}: Tab reaches the header model chip`, () => NodeAssert.ok(reached));
        const tip = page.locator("[data-slot='tooltip-popup']", {
          hasText: "Fallback for your pick",
        });
        await tip.waitFor({ timeout: 3000 });
        const tipText = await tip.textContent();
        check(`${theme}: focus explains the fallback and the way back`, () => {
          NodeAssert.match(tipText, /Fallback for your pick, Claude Code · Opus 5\.5/);
          NodeAssert.match(tipText, /hit its usage limit/);
        });
        const focusShot = NodePath.join(output, `header-focus-tooltip-${theme}.png`);
        await page.screenshot({ path: focusShot });
        receipt.screenshots.push(focusShot);
        await page.keyboard.press("Escape");
        const closed = await tip
          .waitFor({ state: "hidden", timeout: 3000 })
          .then(() => true)
          .catch(() => false);
        check(`${theme}: Escape closes the tooltip`, () => NodeAssert.ok(closed));

        // Unplanned: hover names the glyph and says where to act; keyboard focus lands on
        // the row, whose accessible name carries the same words.
        const unplanned = page.locator("[data-thread-id=business] [data-thread-unplanned]");
        const inside = await unplanned.evaluate((el) => ({
          button: !!el.closest("button, [role=button]"),
          glyph: !!el.querySelector("[data-unplanned-glyph]"),
          aria: el.querySelector(".sr-only")?.textContent ?? "",
          glyphWidth:
            el.querySelector("[data-unplanned-glyph]")?.getBoundingClientRect().width ?? 0,
          color: getComputedStyle(el).color,
          muted: getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground"),
        }));
        check(`${theme}: Unplanned keeps its accessible name`, () => {
          NodeAssert.ok(inside.button);
          NodeAssert.ok(inside.glyph);
          NodeAssert.equal(
            inside.aria,
            "No increment: changed code without an increment. Open the thread to link an increment or mark it not needed.",
          );
          NodeAssert.ok(inside.glyphWidth > 0 && inside.glyphWidth <= 16, `${inside.glyphWidth}`);
        });
        // The row's accessible name, as the accessibility tree computes it, carries the
        // guidance, so keyboard and screen reader users get it on the row.
        const guided = page.locator("[data-thread-id=business]").getByRole("button", {
          name: /No increment: changed code without an increment\. Open the thread to link an increment or mark it not needed\./,
        });
        const guidedCount = await guided.count();
        check(`${theme}: the Unplanned row's accessible name carries the guidance`, () =>
          NodeAssert.equal(guidedCount, 1),
        );
        await unplanned.hover();
        const unplannedTip = page.locator("[data-slot='tooltip-popup']", {
          hasText: "No increment",
        });
        await unplannedTip.waitFor({ timeout: 3000 });
        const unplannedText = await unplannedTip.textContent();
        check(`${theme}: the Unplanned tooltip points to the plan actions`, () =>
          NodeAssert.match(
            unplannedText,
            /Open the thread to link an increment or mark it not needed\./,
          ),
        );
        const unplannedShot = NodePath.join(output, `unplanned-tooltip-${theme}.png`);
        await page.screenshot({ path: unplannedShot });
        receipt.screenshots.push(unplannedShot);
        const glyphShot = NodePath.join(output, `unplanned-glyph-${theme}.png`);
        await page
          .locator("[data-thread-id=business] .sws-thread-meta")
          .screenshot({ path: glyphShot });
        receipt.screenshots.push(glyphShot);
      }
      // Last, so its focus and tooltips never touch the checks above: Tab through the
      // header lands only on what shows, and never scrolls the chips' line from the model.
      await page.locator("[data-header-fixture] h2").click();
      const walk = [];
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press("Tab");
        const at = await page.evaluate(() => {
          const el = document.activeElement;
          const chips = document.querySelector("[data-header-fixture] .sws-thread-head-chips");
          const unit = chips.querySelector(".sws-model").getBoundingClientRect();
          const box = chips.getBoundingClientRect();
          if (!el?.closest("[data-header-fixture]")) return null;
          return {
            name: el.matches(".sws-model")
              ? "model chip"
              : (el.getAttribute("aria-label") ?? el.textContent.replace(/\s+/g, " ").trim()),
            shown: getComputedStyle(el).visibility !== "hidden",
            scrollTop: chips.scrollTop,
            unitInView: unit.top >= box.top - 0.5 && unit.bottom <= box.bottom + 0.5,
          };
        });
        if (!at) break;
        walk.push(at);
      }
      await page.keyboard.press("Escape");
      await page.mouse.click(1, 1);
      header.focusWalk = walk.map((at) => at.name);
      // Tab goes model chip, then exactly the chips on the line, then the header's
      // buttons: never a chip that wrapped away.
      const onLineNames = header.chips.filter((chip) => chip.onLine).map((chip) => chip.name);
      const awayNames = header.chips.filter((chip) => !chip.onLine).map((chip) => chip.name);
      check(`${theme} ${width}px header: Tab lands only on chips that show`, () => {
        NodeAssert.deepEqual(
          header.focusWalk.slice(0, 1 + onLineNames.length),
          ["model chip", ...onLineNames],
          JSON.stringify(header.focusWalk),
        );
        NodeAssert.ok(header.focusWalk.length > 1 + onLineNames.length);
        for (const name of awayNames) NodeAssert.ok(!header.focusWalk.includes(name), name);
        for (const at of walk) {
          NodeAssert.ok(at.shown, at.name);
          NodeAssert.equal(at.scrollTop, 0, at.name);
          NodeAssert.ok(at.unitInView, at.name);
        }
      });
      // A chip that wraps away while focused hands focus to the model chip.
      if (onLineNames.length > 0) {
        const last = header.chips.filter((chip) => chip.onLine).at(-1);
        await page
          .locator("[data-header-fixture] .sws-thread-head-chips > *")
          .filter({ hasText: last.text })
          .focus();
        await page.setViewportSize({ width: 360, height: 1000 });
        await page.waitForFunction(() =>
          document.querySelector(
            "[data-header-fixture] .sws-thread-head-chips > [data-row-wrapped]",
          ),
        );
        await settle(page);
        const handed = await page.evaluate(() => ({
          wrapped: [...document.querySelectorAll("[data-header-fixture] [data-row-wrapped]")]
            .length,
          model: !!document.activeElement?.matches("[data-header-fixture] .sws-model"),
        }));
        header.focusHandoff = handed;
        check(
          `${theme} ${width}px header: focus on a chip that wraps away moves to the model`,
          () => {
            NodeAssert.ok(handed.wrapped > 0, JSON.stringify(handed));
            NodeAssert.ok(handed.model, JSON.stringify(handed));
          },
        );
      }
      await page.close();
    }
    for (const id of FALLBACKS) {
      const seen = byRow[id].map((row) => FITS.indexOf(row.fit));
      receipt.rows[`${theme}:${id}`] = byRow[id].map((row) => ({
        width: row.width,
        fit: row.fit,
        visible: row.visible,
        rest: row.rest.filter((chip) => chip.onLine).map((chip) => chip.text),
      }));
      check(`${theme} ${id}: a wider pane never shows less`, () => {
        for (let index = 1; index < seen.length; index += 1)
          NodeAssert.ok(
            seen[index] <= seen[index - 1],
            `${id}: ${JSON.stringify(byRow[id].map((row) => row.fit))}`,
          );
      });
    }

    // Touch: a tap on the header chip, as on a phone. Record what it shows.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      colorScheme: theme,
    });
    const phone = await context.newPage();
    await phone.goto(`${origin}/?theme=${theme}`);
    await phone.waitForSelector("body[data-fixture-ready]");
    await phone.locator("[data-header-fixture] .sws-model-chip").tap();
    await phone.waitForTimeout(400);
    const touched = await phone.evaluate(() => ({
      focused: !!document.activeElement?.matches("[data-header-fixture] .sws-model-chip"),
      tooltip: document.querySelector("[data-slot='tooltip-popup']")?.textContent ?? null,
      fit: document.querySelector("[data-header-fixture] .sws-model-chip")?.dataset.rowFit ?? null,
      nameCut: (() => {
        const name = document.querySelector("[data-header-fixture] .sws-model-name");
        return !name || name.scrollWidth > name.clientWidth + 1;
      })(),
      visible: [
        ...document.querySelectorAll(
          "[data-header-fixture] .sws-model-provider, [data-header-fixture] .sws-model-name, [data-header-fixture] [data-row-part]",
        ),
      ]
        .filter((el) => getComputedStyle(el).visibility !== "hidden")
        .map((el) => el.textContent.trim())
        .filter(Boolean)
        .join(" "),
    }));
    receipt.touch[theme] = touched;
    // A tap focuses the chip; touch has no tooltip, so the visible unit and its
    // accessible name carry the identity.
    check(`${theme} phone: a tap focuses the header chip and its name stays whole`, () => {
      NodeAssert.ok(touched.focused);
      NodeAssert.equal(touched.nameCut, false, JSON.stringify(touched));
      NodeAssert.match(touched.visible, /GPT-6\.1-Sol/);
    });
    const touchShot = NodePath.join(output, `phone-header-tap-${theme}.png`);
    await phone.screenshot({ path: touchShot });
    receipt.screenshots.push(touchShot);
    await context.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "model-unit-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(`model unit ok: ${receipt.checks.length} checks; evidence in ${output}`);
} finally {
  await browser.close();
  server.close();
}
