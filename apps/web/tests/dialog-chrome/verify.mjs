// Headless check of what follows the system in shared dialog chrome: button
// order, key labels, corner radius, scrollbars, the font stack and Windows
// contrast themes. Run after building the fixture:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/dialog-chrome/vite.config.ts
//   node apps/web/tests/dialog-chrome/verify.mjs /absolute/owned/artifact-dir
// The site is read from <artifact-dir>/site; screenshots and receipt.json go to
// <artifact-dir>/evidence. Fonts are this machine's: the check proves the stack
// and the conventions, not how Segoe UI or a Linux desktop font renders.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { mkdir, readFile, writeFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");

const artifacts = resolve(process.argv[2] ?? ".artifacts/dialog-chrome");
const root = resolve(process.env.DIALOG_CHROME_SITE ?? join(artifacts, "site"));
const output = join(artifacts, "evidence");
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  // Headless Chromium hides scrollbars unless told otherwise, and they are checked here.
  ignoreDefaultArgs: ["--hide-scrollbars"],
  ...(executablePath ? { executablePath } : {}),
});

const SYSTEMS = ["macos", "windows", "linux"];
const DESKTOP = { width: 1100, height: 760 };
const PHONE = { width: 390, height: 780 };
const POPUP = "[data-slot=dialog-popup],[data-slot=alert-dialog-popup]";
const RADIUS = { macos: [8, 14], windows: [4, 8], linux: [6, 12] };
const KEYS = { macos: ["⇥", "↵", "esc", "⌘O"], other: ["Tab", "Enter", "Esc", "Ctrl+O"] };

const checks = [];
async function check(name, run) {
  let page = null;
  try {
    page = await run();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) });
  } finally {
    await page?.context().close();
  }
}

async function open(query, viewport = DESKTOP, context = {}) {
  const page = await (await browser.newContext({ viewport, ...context })).newPage();
  await page.goto(`${origin}/?${new URLSearchParams(query)}`);
  await page.locator(POPUP).first().waitFor();
  await page.waitForTimeout(350);
  return page;
}

/**
 * Moves focus to the control with the Tab key, the way that shows a focus ring.
 * The dialog opens on its field, which is where a check starts.
 */
async function tabTo(page, target) {
  for (let presses = 0; presses < 6; presses += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached the control");
}

/** Where each named button is drawn inside the popup. */
const boxes = (page, names) =>
  page.evaluate(
    ([selector, wanted]) => {
      const popup = document.querySelector(selector);
      const found = {};
      for (const el of popup.querySelectorAll("button, label")) {
        const name = el.textContent.trim();
        if (wanted.includes(name)) found[name] = el.getBoundingClientRect().toJSON();
      }
      return { ...found, popup: popup.getBoundingClientRect().toJSON() };
    },
    [POPUP, names],
  );

/** Nothing spills sideways and no line of text is cut off. */
async function assertFits(page) {
  const layout = await page.evaluate((selector) => {
    const popup = document.querySelector(selector);
    return {
      scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      popupScrolls: popup.scrollWidth > popup.clientWidth + 1,
      clipped: [...popup.querySelectorAll("button, p, h2, label, kbd")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 && !el.classList.contains("sr-only"))
        .map((el) => el.textContent.trim().slice(0, 40)),
    };
  }, POPUP);
  assert.equal(layout.scrolls, false, "no horizontal scroll");
  assert.equal(layout.popupScrolls, false, "the dialog does not scroll sideways");
  assert.deepEqual(layout.clipped, []);
}

for (const os of SYSTEMS) {
  const first = os === "windows";

  await check(`${os}: the default button is drawn ${first ? "first" : "last"}`, async () => {
    const page = await open({ case: "form", platform: os });
    const at = await boxes(page, ["Cancel", "Save"]);
    assert.equal(at.Save.left < at.Cancel.left, first);
    // Either way the pair sits at the end of the footer, next to each other.
    const end = Math.max(at.Save.right, at.Cancel.right);
    assert.ok(at.popup.right - end < 40, "the buttons end at the footer's edge");
    assert.ok(Math.abs(at.Save.top - at.Cancel.top) < 2, "the buttons share a row");
    await assertFits(page);
    await page.screenshot({ path: join(output, `form-${os}.png`) });
    return page;
  });

  await check(`${os}: buttons stack at phone width with the default on top`, async () => {
    const page = await open({ case: "form", platform: os }, PHONE);
    const at = await boxes(page, ["Cancel", "Save"]);
    assert.ok(at.Save.bottom <= at.Cancel.top, "Save is above Cancel");
    assert.ok(at.Save.width > 300, "buttons take the width");
    await assertFits(page);
    return page;
  });

  await check(`${os}: a destructive confirm opens on Cancel`, async () => {
    const page = await open({ case: "confirm", platform: os });
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert.equal(focused, "Cancel");
    const at = await boxes(page, ["Cancel", "Delete"]);
    assert.equal(at.Delete.left < at.Cancel.left, first);
    // Enter on the focused button must not delete: it closes the confirm.
    await page.keyboard.press("Enter");
    await page.locator(POPUP).first().waitFor({ state: "detached" });
    return page;
  });

  await check(`${os}: a leading control stays at the start`, async () => {
    const page = await open({ case: "leading", platform: os });
    const at = await boxes(page, ["Use the default name", "Cancel", "Save"]);
    const lead = at["Use the default name"];
    assert.ok(lead.right <= Math.min(at.Cancel.left, at.Save.left), "leading is before both");
    assert.ok(lead.left - at.popup.left < 40, "leading sits at the start edge");
    assert.equal(at.Save.left < at.Cancel.left, first);
    assert.ok(at.popup.right - Math.max(at.Save.right, at.Cancel.right) < 40);
    await assertFits(page);
    await page.screenshot({ path: join(output, `leading-${os}.png`) });
    return page;
  });

  await check(`${os}: a control led with a width-scoped margin stays at the start`, async () => {
    const page = await open({ case: "leading-sm", platform: os });
    const at = await boxes(page, ["Abort", "Cancel", "Save"]);
    assert.ok(at.Abort.right <= Math.min(at.Cancel.left, at.Save.left), "Abort is before both");
    assert.ok(at.Abort.left - at.popup.left < 40, "Abort sits at the start edge");
    assert.equal(at.Save.left < at.Cancel.left, first);
    await assertFits(page);
    return page;
  });

  await check(`${os}: a footer that spreads its children apart is left alone`, async () => {
    const page = await open({ case: "between", platform: os });
    const at = await boxes(page, ["Set price"]);
    const note = await page
      .getByText("No known price")
      .evaluate((el) => el.getBoundingClientRect().toJSON());
    assert.ok(note.right <= at["Set price"].left, "the note stays before the button");
    assert.ok(note.left - at.popup.left < 40 && at.popup.right - at["Set price"].right < 40);
    return page;
  });

  await check(`${os}: Back stays before the default`, async () => {
    const page = await open({ case: "back", platform: os });
    const at = await boxes(page, ["Back", "Next"]);
    assert.ok(at.Back.right <= at.Next.left, "Back, then Next");
    assert.ok(at.popup.right - at.Next.right < 40, "the pair ends at the footer's edge");
    return page;
  });

  await check(`${os}: the wizard keeps its leading control and orders its buttons`, async () => {
    const page = await open({ case: "wizard", platform: os });
    const at = await boxes(page, ["Don't show this again", "Not now", "Continue"]);
    const lead = at["Don't show this again"];
    assert.ok(lead.right <= Math.min(at["Not now"].left, at.Continue.left));
    assert.equal(at.Continue.left < at["Not now"].left, first);
    assert.ok(at.popup.right - Math.max(at.Continue.right, at["Not now"].right) < 40);
    await assertFits(page);
    return page;
  });

  for (const theme of ["light", "dark"]) {
    await check(`${os} ${theme}: keys, radius, scrollbar and font stack`, async () => {
      const page = await open({ case: "chrome", platform: os, theme });
      const seen = await page.evaluate((selector) => {
        const popup = document.querySelector(selector);
        const scroller = popup.querySelector('[data-slot="chrome-scroller"]');
        const border = Number.parseFloat(getComputedStyle(scroller).borderLeftWidth) * 2;
        const add = [...popup.querySelectorAll("button")].find(
          (button) => button.textContent.trim() === "Add folder",
        );
        return {
          platform: document.documentElement.dataset.platform,
          keys: [...popup.querySelectorAll('[data-slot="chrome-keys"] kbd')].map(
            (key) => key.textContent,
          ),
          control: Number.parseFloat(getComputedStyle(add).borderTopLeftRadius),
          dialog: Number.parseFloat(getComputedStyle(popup).borderTopLeftRadius),
          scrollbar: scroller.offsetWidth - scroller.clientWidth - border,
          overflows: scroller.scrollHeight > scroller.clientHeight,
          thumb: getComputedStyle(scroller, "::-webkit-scrollbar-thumb").backgroundColor,
          font: getComputedStyle(document.body).fontFamily,
        };
      }, POPUP);
      assert.equal(seen.platform, os);
      assert.deepEqual(seen.keys, os === "macos" ? KEYS.macos : KEYS.other);
      assert.deepEqual([seen.control, seen.dialog], RADIUS[os]);
      assert.equal(seen.overflows, true, "the list overflows");
      if (os === "macos") assert.equal(seen.scrollbar, 6, "thin on macOS");
      else assert.ok(seen.scrollbar >= 10, `at least 10 px: ${seen.scrollbar}`);
      assert.notEqual(seen.thumb, "rgba(0, 0, 0, 0)", "the thumb is drawn");
      for (const family of ["Segoe UI Variable Text", "Segoe UI", "system-ui", "Adwaita Sans"]) {
        assert.ok(seen.font.includes(family), `font stack names ${family}`);
      }
      assert.ok(
        // Chromium prints -apple-system as system-ui too, so the generic is the last one.
        seen.font.indexOf("Segoe UI Variable Text") < seen.font.lastIndexOf("system-ui") &&
          seen.font.lastIndexOf("system-ui") < seen.font.indexOf("Adwaita Sans"),
        "Segoe UI Variable, then the desktop's font, then named fallbacks",
      );
      // Focus is visible on a button and on the field.
      for (const target of [
        page.getByLabel("Folder path"),
        page.getByRole("button", { name: "Add folder" }),
      ]) {
        await tabTo(page, target);
        const ring = await target.evaluate((el) => {
          const style = getComputedStyle(el);
          return { shadow: style.boxShadow, outline: style.outlineStyle };
        });
        assert.ok(ring.shadow !== "none" || ring.outline !== "none", "focus is drawn");
      }
      await assertFits(page);
      await page.screenshot({ path: join(output, `chrome-${os}-${theme}.png`) });
      return page;
    });
  }

  await check(`${os}: the chrome case fits at phone width`, async () => {
    const page = await open({ case: "chrome", platform: os }, PHONE);
    await assertFits(page);
    await page.screenshot({ path: join(output, `chrome-${os}-phone.png`) });
    return page;
  });
}

// --- Windows contrast themes: selection, focus, fields and buttons stay visible.
for (const scheme of ["dark", "light"]) {
  await check(`contrast theme (${scheme}): selection, focus, field and buttons`, async () => {
    const page = await open({ case: "chrome", platform: "windows", theme: scheme }, DESKTOP, {
      forcedColors: "active",
      colorScheme: scheme,
    });
    assert.equal(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), true);
    await tabTo(page, page.getByLabel("Folder path"));
    const seen = await page.evaluate((selector) => {
      const popup = document.querySelector(selector);
      const system = (name) => {
        const probe = document.createElement("i");
        probe.style.cssText = `forced-color-adjust:none;color:${name}`;
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      const picked = popup.querySelector('[role="option"][aria-selected="true"]');
      const other = popup.querySelector(
        '[role="option"][aria-selected="false"]:not([data-highlighted])',
      );
      const keyed = popup.querySelector('[role="option"][data-highlighted]');
      const input = popup.querySelector("input");
      const buttons = [...popup.querySelectorAll('[data-slot="dialog-footer"] button')];
      return {
        highlight: system("Highlight"),
        highlightText: system("HighlightText"),
        picked: getComputedStyle(picked).backgroundColor,
        pickedText: getComputedStyle(picked.firstElementChild).color,
        pickedNote: getComputedStyle(picked.lastElementChild).color,
        other: getComputedStyle(other).backgroundColor,
        keyed: getComputedStyle(keyed).backgroundColor,
        keyedEdge: `${getComputedStyle(keyed).outlineStyle} ${getComputedStyle(keyed).outlineWidth}`,
        otherEdge: getComputedStyle(other).outlineStyle,
        focusOutline: `${getComputedStyle(input).outlineStyle} ${getComputedStyle(input).outlineWidth}`,
        fieldBorder: `${getComputedStyle(input).borderTopStyle} ${getComputedStyle(input).borderTopWidth}`,
        buttonBorders: buttons.map(
          (button) =>
            `${getComputedStyle(button).borderTopStyle} ${getComputedStyle(button).borderTopWidth}`,
        ),
      };
    }, POPUP);
    assert.equal(seen.picked, seen.highlight, "the selected row is filled with Highlight");
    assert.equal(seen.pickedText, seen.highlightText);
    assert.equal(seen.pickedNote, seen.highlightText, "muted text in the row stays readable");
    assert.notEqual(seen.other, seen.highlight, "only the selection is filled");
    // The row the keys are on is told apart from the chosen one: an edge, not a fill.
    assert.notEqual(seen.keyed, seen.highlight, "the keyed row is not filled");
    assert.equal(seen.keyedEdge, "solid 2px", "the keyed row has an edge");
    assert.equal(seen.otherEdge, "none", "only the keyed row has an edge");
    assert.equal(seen.focusOutline, "solid 2px", "focus is an outline, not a shadow");
    assert.equal(seen.fieldBorder, "solid 1px");
    assert.equal(seen.buttonBorders.length, 2);
    for (const border of seen.buttonBorders) assert.equal(border, "solid 1px");
    await tabTo(page, page.getByRole("button", { name: "Add folder" }));
    const outline = await page
      .getByRole("button", { name: "Add folder" })
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    assert.equal(outline, "solid", "the primary button shows focus");
    await page.screenshot({ path: join(output, `contrast-${scheme}.png`) });
    return page;
  });
}

await browser.close();
server.close();
const failed = checks.filter((entry) => !entry.ok);
await writeFile(
  join(output, "receipt.json"),
  JSON.stringify({ checks: checks.length, failed: failed.length, results: checks }, null, 2),
);
for (const entry of checks)
  console.log(
    `${entry.ok ? "ok  " : "FAIL"} ${entry.name}${entry.ok ? "" : `\n     ${entry.error}`}`,
  );
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; evidence in ${output}`,
);
process.exit(failed.length === 0 ? 0 : 1);
