// Headless check of Add project > Local folder: the real panel and address-bar
// hook over a made-up disk. Run after building the fixture:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/add-folder/vite.config.ts
//   node apps/web/tests/add-folder/verify.mjs /absolute/owned/report-dir [--baseline]
// --baseline reports every check without failing the run.
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

const args = process.argv.slice(2);
const baseline = args.includes("--baseline");
const root = resolve(process.env.ADD_FOLDER_SITE ?? ".artifacts/add-folder/site");
const output = resolve(
  args.find((arg) => !arg.startsWith("--")) ?? ".artifacts/add-folder/evidence",
);
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
  ...(executablePath ? { executablePath } : {}),
});

const checks = [];
/** Opens the fixture and hands back the page with its main parts. */
async function open(query = {}, viewport = { width: 1280, height: 900 }, media = {}) {
  const context = await browser.newContext({ viewport, ...media });
  const page = await context.newPage();
  await page.goto(`${origin}/?${new URLSearchParams(query)}`);
  const bar = page.getByLabel("Folder path");
  await bar.waitFor();
  await page.locator('[data-slot="add-folder-status"]').waitFor();
  return {
    page,
    context,
    bar,
    status: page.locator('[data-slot="add-folder-status"]'),
    primary: page.locator('[data-slot="add-folder-primary"]'),
    rows: page.getByRole("listbox", { name: /^Folders/ }).getByRole("option"),
    /** Replaces the bar's text by typing, as a person would. */
    type: async (text) => {
      await bar.press("ControlOrMeta+a");
      await page.keyboard.type(text);
    },
    added: () => page.evaluate(() => window.added),
    addCalls: () => page.evaluate(() => window.addCalls),
    field: () =>
      bar.evaluate((el) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd })),
  };
}
async function check(name, run) {
  let view;
  try {
    view = await run();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error).split("\n")[0] });
  } finally {
    await view?.context.close();
  }
}
const names = (rows) => rows.evaluateAll((list) => list.map((row) => row.textContent.trim()));

try {
  // --- The November 11 photo: a folder with no folders inside, typed in full, then Enter.
  await check("photo state: typed folder with no subfolders, Enter adds it", async () => {
    const view = await open();
    await view.type("~/Projects/notes/");
    await view.page.getByText("No folders inside.", { exact: true }).waitFor();
    assert.equal(
      await view.status.innerText(),
      "No folders inside. notes itself becomes the project on Work Mac.",
    );
    assert.match(await view.primary.innerText(), /^Add notes/);
    await view.page.screenshot({ path: join(output, "photo-state-before-enter.png") });
    await view.bar.press("Enter");
    await view.page.waitForFunction(() => window.added !== null);
    assert.deepEqual(await view.added(), { machine: "mac", path: "/Users/you/Projects/notes" });
    return view;
  });
  await check("same folder without the trailing slash adds it", async () => {
    const view = await open();
    await view.type("/Users/you/Projects/notes");
    await view.bar.press("Enter");
    await view.page.waitForFunction(() => window.added !== null);
    assert.equal((await view.added()).path, "/Users/you/Projects/notes");
    return view;
  });
  await check("pointer resting on a row does not change what Enter does", async () => {
    const view = await open();
    await view.type("~/Projects/");
    await view.rows.first().hover();
    assert.equal(await view.rows.first().getAttribute("aria-selected"), "false");
    await view.bar.press("Enter");
    await view.page.waitForFunction(() => window.added !== null);
    assert.equal((await view.added()).path, "/Users/you/Projects");
    return view;
  });
  await check("ArrowDown writes the folder into the bar and Enter adds that folder", async () => {
    const view = await open();
    await view.type("~/Projects/");
    await view.bar.press("ArrowDown");
    assert.equal((await view.field()).value, "/Users/you/Projects/atlas-api");
    assert.equal(await view.rows.first().getAttribute("aria-selected"), "true");
    // The bar points assistive tech at the highlighted row.
    assert.equal(
      await view.bar.getAttribute("aria-activedescendant"),
      await view.rows.first().getAttribute("id"),
    );
    // The list still shows the folder's siblings, so the arrows keep working.
    assert.equal(await view.rows.count(), 4);
    assert.match(await view.primary.innerText(), /^Add atlas-api/);
    await view.bar.press("ArrowDown");
    assert.equal((await view.field()).value, "/Users/you/Projects/notes");
    await view.bar.press("Enter");
    await view.page.waitForFunction(() => window.added !== null);
    assert.equal((await view.added()).path, "/Users/you/Projects/notes");
    assert.deepEqual(await view.addCalls(), ["/Users/you/Projects/notes"]);
    return view;
  });
  if (!baseline) {
    await check(
      "Tab opens the highlighted folder; Backspace on the separator goes back up",
      async () => {
        const view = await open();
        await view.type("~/Projects/");
        await view.bar.press("ArrowDown");
        await view.bar.press("Tab");
        assert.equal((await view.field()).value, "/Users/you/Projects/atlas-api/");
        assert.deepEqual(await names(view.rows), ["api", "docs"]);
        assert.equal(await view.bar.evaluate((el) => el === document.activeElement), true);
        await view.bar.press("Backspace");
        assert.equal((await view.field()).value, "/Users/you/Projects/");
        assert.equal(await view.rows.count(), 4);
        await view.bar.press("ArrowDown");
        await view.bar.press("ArrowLeft");
        assert.equal((await view.field()).value, "/Users/you/");
        assert.equal(await view.added(), null);
        return view;
      },
    );
    await check("typing completes a folder name as a selection; Backspace removes it", async () => {
      const view = await open();
      await view.type("~/pro");
      assert.deepEqual(await view.field(), { value: "~/projects", start: 5, end: 10 });
      // The list filters by what was typed, not by the completion.
      assert.deepEqual(await names(view.rows), ["Projects"]);
      assert.match(await view.primary.innerText(), /^Add Projects/);
      await view.bar.press("Backspace");
      assert.deepEqual(await view.field(), { value: "~/pro", start: 5, end: 5 });
      await view.page.keyboard.type("x");
      assert.equal((await view.field()).value, "~/prox");
      assert.match(await view.primary.innerText(), /^Create and add/);
      // Tab accepts a completion and opens the folder.
      await view.type("~/Doc");
      await view.bar.press("Tab");
      assert.equal((await view.field()).value, "/Users/you/Documents/");
      return view;
    });
    await check("names match by case only where the machine does", async () => {
      const view = await open({ machine: "linux" });
      await view.type("~/w");
      assert.equal((await view.field()).value, "~/work");
      await view.type("~/W");
      assert.equal((await view.field()).value, "~/Work");
      return view;
    });
    await check("a pasted quoted path, file link or escaped path is cleaned up", async () => {
      const view = await open();
      const paste = (text) =>
        view.bar.evaluate((el, value) => {
          el.select();
          const data = new DataTransfer();
          data.setData("text", value);
          el.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, text);
      await paste('"/Users/you/Projects/notes"\n');
      await view.page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Folder path"]').value ===
          "/Users/you/Projects/notes",
      );
      await paste("file:///Users/you/Projects/atlas-api");
      await view.page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Folder path"]').value ===
          "/Users/you/Projects/atlas-api",
      );
      assert.equal(
        await view.status.innerText(),
        "atlas-api is a Git repository on Work Mac. It becomes the project.",
      );
      return view;
    });
    await check("a Windows path on a Mac is refused in the bar before any request", async () => {
      const view = await open();
      const before = await view.page.evaluate(() => window.browsed.length);
      await view.type("C:\\Users\\you");
      assert.match(await view.status.innerText(), /Work Mac is not a Windows machine/);
      assert.equal(await view.status.getAttribute("data-tone"), "problem");
      assert.equal(await view.primary.isDisabled(), true);
      await view.bar.press("Enter");
      assert.deepEqual(await view.addCalls(), []);
      assert.equal(await view.page.evaluate(() => window.browsed.length), before);
      return view;
    });
    await check("a Windows machine takes drive paths with its own separator", async () => {
      const view = await open({ machine: "pc", os: "windows", path: "C:\\Users\\you\\" });
      await view.rows.first().waitFor();
      await view.bar.press("ArrowDown");
      assert.equal((await view.field()).value, "C:\\Users\\you\\Desktop");
      await view.bar.press("ArrowDown");
      await view.bar.press("Tab");
      assert.equal((await view.field()).value, "C:\\Users\\you\\source\\");
      assert.deepEqual(await names(view.rows), ["repos"]);
      await view.type("/home/you");
      assert.match(await view.status.innerText(), /Office PC is a Windows machine/);
      return view;
    });
    await check("the button names the action: create, open an existing project", async () => {
      const view = await open();
      await view.type("~/Projects/new-thing");
      assert.match(await view.primary.innerText(), /^Create and add/);
      assert.equal(
        await view.status.innerText(),
        "new-thing is not there yet on Work Mac. It is created and added as a project.",
      );
      await view.type("~/Projects/storefront");
      assert.match(await view.primary.innerText(), /^Open project/);
      assert.equal(
        await view.status.innerText(),
        "storefront is already the project Storefront on Work Mac. Enter opens it.",
      );
      return view;
    });
    await check("Enter shows Adding at once and a second Enter is ignored", async () => {
      const view = await open({ copies: "1" });
      await view.type("~/Projects/notes/");
      await view.page.getByText("No folders inside.", { exact: true }).waitFor();
      await view.bar.press("Enter");
      await view.page.waitForFunction(
        () => document.querySelector('[data-slot="add-folder-primary"]').textContent === "Adding…",
        null,
        { timeout: 100 },
      );
      assert.equal(await view.primary.isDisabled(), true);
      assert.equal(await view.status.innerText(), "Looking for copies on other machines…");
      await view.bar.press("Enter");
      await view.bar.press("Enter");
      await view.page.waitForFunction(() => window.added !== null);
      assert.deepEqual(await view.addCalls(), ["/Users/you/Projects/notes"]);
      return view;
    });
    await check("a failed add keeps the panel open with the reason", async () => {
      const view = await open();
      await view.type("~/Documents/locked/");
      await view.page.getByText("No folders inside.", { exact: true }).waitFor();
      await view.bar.press("Enter");
      await view.page.getByRole("alert").waitFor();
      assert.equal(
        await view.status.innerText(),
        "The folder '/Users/you/Documents/locked' cannot be written to.",
      );
      assert.equal(await view.primary.isEnabled(), true);
      assert.equal(await view.added(), null);
      // Changing the bar clears the reason.
      await view.bar.press("Backspace");
      assert.match(await view.status.innerText(), /Documents becomes the project/);
      return view;
    });
    for (const [os, label, shortcut] of [
      ["macos", "Choose…", "Meta+o"],
      ["windows", "Browse…", "Control+o"],
      ["linux", "Browse…", "Control+o"],
    ]) {
      await check(`system dialog button on ${os}: ${label}, opened by the shortcut`, async () => {
        const view = await open({ os });
        const button = view.page.locator('[data-slot="system-folder-button"]');
        assert.equal((await button.innerText()).trim(), label);
        await view.bar.press(shortcut);
        assert.equal(await view.page.evaluate(() => window.pickerOpened), 1);
        await button.click();
        assert.equal(await view.page.evaluate(() => window.pickerOpened), 2);
        const enter = os === "macos" ? "↵" : "Enter";
        assert.ok((await view.primary.innerText()).includes(enter), `primary shows ${enter}`);
        return view;
      });
    }
    await check(
      "system dialog button is disabled with the reason for another machine",
      async () => {
        const view = await open({ machine: "linux" });
        const button = view.page.locator('[data-slot="system-folder-button"]');
        assert.equal(await button.isDisabled(), true);
        // The reason is on screen, not in a tooltip a disabled button never shows.
        const note = view.page.locator('[data-slot="add-folder-picker-note"]');
        assert.match(await note.innerText(), /Type or paste a path on Linux server/);
        assert.equal(await button.getAttribute("aria-describedby"), await note.getAttribute("id"));
        const browser = await open({ desktop: "0" });
        assert.equal(await browser.page.locator('[data-slot="system-folder-button"]').count(), 0);
        await browser.context.close();
        return view;
      },
    );
    const drop = (view, name) =>
      view.page.locator('[data-slot="add-folder"]').evaluate((panel, fileName) => {
        const data = new DataTransfer();
        data.items.add(new File([""], fileName));
        for (const type of ["dragover", "drop"]) {
          panel.dispatchEvent(
            new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
          );
        }
      }, name);
    await check("a dropped folder fills the bar and adds nothing", async () => {
      const view = await open();
      await view.page.evaluate(() => {
        window.droppedPaths = { weather: "/Users/you/Projects/weather" };
      });
      await drop(view, "weather");
      await view.page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Folder path"]').value ===
          "/Users/you/Projects/weather/",
      );
      assert.deepEqual(await view.addCalls(), []);
      assert.match(await view.primary.innerText(), /^Add weather/);
      return view;
    });
    await check("a drop is refused for another machine and in a browser", async () => {
      const view = await open({ machine: "linux" });
      await drop(view, "weather");
      assert.equal(
        await view.page.locator('[data-slot="add-folder-drop"]').innerText(),
        "The dropped folder is on this device, not on Linux server. Type or paste a path on that machine instead.",
      );
      assert.equal((await view.field()).value, "~/");
      const web = await open({ desktop: "0" });
      await drop(web, "weather");
      assert.match(
        await web.page.locator('[data-slot="add-folder-drop"]').innerText(),
        /Type or paste the path instead\.$/,
      );
      await web.context.close();
      return view;
    });
    await check("an added folder is a Recent place after a reload", async () => {
      const view = await open();
      await view.type("~/Projects/atlas-api/docs/");
      await view.page.getByText("No folders inside.", { exact: true }).waitFor();
      await view.bar.press("Enter");
      await view.page.waitForFunction(() => window.added !== null);
      await view.page.reload();
      const places = view.page.getByRole("group", { name: "Places" });
      await places.getByRole("button", { name: "docs", exact: true }).click();
      assert.equal((await view.field()).value, "/Users/you/Projects/atlas-api/docs/");
      return view;
    });
    // --- Every system, light and dark, desktop and phone width: nothing clipped, focus visible.
    for (const os of ["macos", "windows", "linux"]) {
      for (const theme of ["light", "dark"]) {
        for (const [width, height] of [
          [1280, 900],
          [390, 844],
        ]) {
          await check(`layout ${os} ${theme} ${width}px`, async () => {
            const view = await open({ os, theme, path: "~/Projects/" }, { width, height });
            await view.rows.first().waitFor();
            await view.bar.press("ArrowDown");
            await view.page.waitForTimeout(250);
            const layout = await view.page.evaluate(() => ({
              scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              platform: document.documentElement.dataset.platform,
              primary: document
                .querySelector('[data-slot="add-folder-primary"]')
                .getBoundingClientRect()
                .toJSON(),
              viewport: { width: innerWidth, height: innerHeight },
              clipped: [
                ...document.querySelectorAll(
                  '[data-slot="add-folder"] p, [data-slot="add-folder-primary"]',
                ),
              ]
                .filter(
                  (el) =>
                    el.scrollWidth > el.clientWidth + 1 &&
                    !el.classList.contains("truncate") &&
                    // The screen-reader announcement is one pixel wide on purpose.
                    !el.classList.contains("sr-only"),
                )
                .map((el) => el.textContent.slice(0, 40)),
            }));
            assert.equal(layout.platform, os);
            assert.equal(layout.scrolls, false, "no horizontal scroll");
            assert.deepEqual(layout.clipped, []);
            assert.ok(layout.primary.width >= 200, "primary is a full-size button");
            assert.ok(layout.primary.bottom <= layout.viewport.height, "primary is on screen");
            assert.ok(layout.primary.right <= layout.viewport.width, "primary fits the width");
            const outline = await view.bar.evaluate((el) => {
              const ring = getComputedStyle(el.closest('[data-slot="autocomplete-input"]') ?? el);
              return `${ring.outlineStyle} ${ring.boxShadow} ${getComputedStyle(el).caretColor}`;
            });
            assert.ok(outline.length > 0);
            await view.page.screenshot({ path: join(output, `${os}-${theme}-${width}.png`) });
            return view;
          });
        }
      }
    }
  }
  // --- Windows contrast themes: the highlighted folder, the bar's focus and the primary stay visible.
  for (const colorScheme of ["dark", "light"]) {
    await check(`contrast theme (${colorScheme}): selection, focus and the primary`, async () => {
      const view = await open({ os: "windows", path: "~/Projects/" }, undefined, {
        forcedColors: "active",
        colorScheme,
      });
      await view.rows.first().waitFor();
      await view.bar.press("ArrowDown");
      await view.page.locator('[aria-label^="Folders"] [aria-selected="true"]').waitFor();
      // Rows fade between colours; read them once the fade is over.
      await view.page.waitForTimeout(300);
      const seen = await view.page.evaluate(() => {
        const system = (name) => {
          const probe = document.createElement("i");
          probe.style.cssText = `forced-color-adjust:none;color:${name}`;
          document.body.append(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        };
        const list = document.querySelector('[role="listbox"][aria-label^="Folders"]');
        const picked = list.querySelector('[role="option"][aria-selected="true"]');
        const other = list.querySelector('[role="option"][aria-selected="false"]');
        const primary = getComputedStyle(
          document.querySelector('[data-slot="add-folder-primary"]'),
        );
        const bar = getComputedStyle(document.activeElement);
        return {
          forced: matchMedia("(forced-colors: active)").matches,
          highlight: system("Highlight"),
          highlightText: system("HighlightText"),
          picked: getComputedStyle(picked).backgroundColor,
          pickedText: getComputedStyle(picked.querySelector("span") ?? picked).color,
          other: getComputedStyle(other).backgroundColor,
          primary: `${primary.borderTopStyle} ${primary.borderTopWidth}`,
          focus: `${bar.outlineStyle} ${bar.outlineWidth}`,
        };
      });
      assert.equal(seen.forced, true);
      assert.equal(seen.picked, seen.highlight, "the highlighted folder is filled");
      assert.equal(seen.pickedText, seen.highlightText, "its name is readable on the fill");
      assert.notEqual(seen.other, seen.highlight, "only the highlighted folder is filled");
      assert.equal(seen.primary, "solid 1px", "the primary keeps its edge");
      assert.equal(seen.focus, "solid 2px", "the bar shows focus as an outline");
      await view.page.screenshot({ path: join(output, `contrast-${colorScheme}.png`) });
      return view;
    });
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

const failed = checks.filter((entry) => !entry.ok);
await writeFile(
  join(output, "receipt.json"),
  `${JSON.stringify(
    {
      headless: true,
      baseline,
      scope:
        "Real Add folder panel, address-bar hook and command dialog over a made-up disk; no project is added and no system dialog opens",
      passed: checks.length - failed.length,
      failed: failed.length,
      checks,
    },
    null,
    2,
  )}\n`,
);
for (const entry of checks) {
  console.log(`${entry.ok ? "ok  " : "FAIL"} ${entry.name}${entry.ok ? "" : `: ${entry.error}`}`);
}
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; evidence in ${output}`,
);
process.exit(failed.length > 0 && !baseline ? 1 : 0);
