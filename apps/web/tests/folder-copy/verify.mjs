import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = process.cwd();
const site = NodePath.join(root, ".artifacts/folder-copy/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/folder-copy/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
// Playwright's own headless shell when it is installed, else the newest one on this machine.
const headlessShell = () => {
  if (process.env.STUDIO_CHROMIUM_EXECUTABLE) return process.env.STUDIO_CHROMIUM_EXECUTABLE;
  if (NodeFS.existsSync(chromium.executablePath())) return undefined;
  const cache = NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright");
  const shells = NodeFS.existsSync(cache)
    ? NodeFS.readdirSync(cache)
        .filter((name) => name.startsWith("chromium_headless_shell-"))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const shell of shells) {
    const file = NodePath.join(
      cache,
      shell,
      `chrome-headless-shell-mac-${process.arch === "arm64" ? "arm64" : "x64"}`,
      "chrome-headless-shell",
    );
    if (NodeFS.existsSync(file)) return file;
  }
  return undefined;
};
const server = NodeHttp.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return response.writeHead(403).end();
    // Read first: a missing file must answer 404, not crash on a second writeHead.
    const body = await NodeFSP.readFile(file);
    response.writeHead(200, {
      "Content-Type":
        { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
          NodePath.extname(file)
        ] ?? "text/html",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const executablePath = headlessShell();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const receipt = {
  headless: true,
  source:
    "Real MachineHandoffDialog and HandoffFolderCopy; synthetic RPC only, not live Ministorm UI or provider activity",
  checks: [
    "no horizontal scroll on the page, dialog, footer or step bar",
    "every step of the bar inside the dialog",
    "exactly one enabled primary on each step that waits for the person; none while busy or checking",
    "the primary is visible without scrolling and sits in the non-scrolling footer",
    "Back is the leftmost footer action with mr-auto, and absent on Where",
  ],
  cases: [],
};

// The step bar as "id:state[+auto][+viewing]" words, read the same way in and out of the page.
const BAR_SCRIPT = () =>
  [...document.querySelectorAll('[data-slot="copy-step"]')]
    .map(
      (item) =>
        `${item.dataset.stepId}:${item.dataset.state}${item.dataset.auto ? "+auto" : ""}${item.dataset.viewing ? "+viewing" : ""}`,
    )
    .join(" ");

/** Helpers bound to one page; every checkpoint asserts the layout and saves a screenshot. */
const walker = (page, label, flow, viewport) => {
  const stages = [];
  const footer = page.locator('[data-slot="dialog-footer"]');
  const action = (name) => footer.getByRole("button", { name, exact: true });
  const step = (id) => page.locator(`[data-slot="copy-step"][data-step-id="${id}"]`);
  const fixture = (script, arg) => page.evaluate(script, arg);
  const pause = (name) => fixture((name) => window.__folderCopyFixture.pauseNext(name), name);
  const release = (name) => fixture((name) => window.__folderCopyFixture.release(name), name);
  const calls = (name) =>
    fixture(
      (name) => window.__folderCopyFixture.calls.filter((call) => call === name).length,
      name,
    );
  const body = () => page.locator('[data-slot="dialog-panel"]').textContent();
  /**
   * `primary` is the one enabled primary's label, or null where the step is busy and offers
   * none. `steps` is the expected bar, `back` whether Back shows.
   */
  const check = async (stage, { primary, steps, back }) => {
    if (primary) await action(primary).waitFor();
    if (steps)
      await page
        .waitForFunction(
          ([script, expected]) => new Function(`return (${script})()`)() === expected,
          [BAR_SCRIPT.toString(), steps],
          { timeout: 10_000 },
        )
        .catch(() => {});
    // Let the footer settle: a primary that is about to disable must not be counted.
    await page.waitForTimeout(150);
    const layout = await page.evaluate((script) => {
      const popup = document.querySelector('[data-slot="dialog-popup"]');
      const footer = popup.querySelector('[data-slot="dialog-footer"]');
      const bar = popup.querySelector('[data-slot="copy-steps"]');
      const box = popup.getBoundingClientRect();
      const items = bar ? [...bar.querySelectorAll('[data-slot="copy-step"]')] : [];
      const back = footer.querySelector('[data-slot="copy-back"]');
      const actions = footer.querySelector('[data-slot="copy-actions"]');
      return {
        overflow: {
          page: document.documentElement.scrollWidth > window.innerWidth,
          popup: popup.scrollWidth > popup.clientWidth,
          footer: footer.scrollWidth > footer.clientWidth,
          steps: bar ? bar.scrollWidth > bar.clientWidth : false,
        },
        stepsOutside: items.some((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left < box.left || rect.right > box.right;
        }),
        stepRows: bar
          ? new Set([...bar.children].map((li) => Math.round(li.getBoundingClientRect().top))).size
          : 0,
        steps: new Function(`return (${script})()`)(),
        primaries: [...footer.querySelectorAll("button")]
          .filter((button) => button.classList.contains("bg-primary") && !button.disabled)
          .map((button) => ({
            text: button.textContent.trim(),
            rect: button.getBoundingClientRect().toJSON(),
            inScroll: !!button.closest('[data-slot="scroll-area-viewport"]'),
          })),
        back: back
          ? {
              // Leftmost of the buttons on its row, whatever the row's direction.
              leftmost: [...actions.querySelectorAll("button")].every((button) => {
                const rect = button.getBoundingClientRect();
                const own = back.getBoundingClientRect();
                return Math.abs(rect.top - own.top) > 4 || rect.left >= own.left - 1;
              }),
              mrAuto: back.classList.contains("mr-auto"),
            }
          : null,
      };
    }, BAR_SCRIPT.toString());
    NodeAssert.deepEqual(
      layout.overflow,
      { page: false, popup: false, footer: false, steps: false },
      `${label} ${flow} ${stage}: horizontal overflow`,
    );
    NodeAssert.equal(layout.stepsOutside, false, `${label} ${flow} ${stage}: step outside`);
    if (steps) NodeAssert.equal(layout.steps, steps, `${label} ${flow} ${stage}: step bar`);
    if (primary === null)
      NodeAssert.deepEqual(layout.primaries, [], `${label} ${flow} ${stage}: no enabled primary`);
    else {
      NodeAssert.deepEqual(
        layout.primaries.map((entry) => entry.text),
        [primary],
        `${label} ${flow} ${stage}: exactly one enabled primary`,
      );
      const { rect, inScroll } = layout.primaries[0];
      NodeAssert.ok(
        rect.y >= 0 &&
          rect.y + rect.height <= viewport.height &&
          rect.x >= 0 &&
          rect.x + rect.width <= viewport.width,
        `${label} ${flow} ${stage}: ${primary} is visible without scrolling`,
      );
      NodeAssert.equal(inScroll, false, `${label} ${flow} ${stage}: ${primary} is in the footer`);
    }
    if (back !== undefined)
      NodeAssert.deepEqual(
        layout.back,
        back ? { leftmost: true, mrAuto: true } : null,
        `${label} ${flow} ${stage}: Back`,
      );
    const file = `${label}-${flow}-${String(stages.length + 1).padStart(2, "0")}-${stage}.png`;
    await page.screenshot({ path: NodePath.join(output, file), fullPage: true });
    stages.push({ stage, primary, steps: layout.steps, stepRows: layout.stepRows, file });
  };
  /**
   * Closing unmounts the copy flow, as the real dialog does; reopening mounts it again.
   * Escape closes whether the dialog has a text Close or only its X.
   */
  const close = async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  };
  const reopen = () => page.locator('[data-slot="fixture-reopen"]').click();
  return {
    stages,
    footer,
    action,
    step,
    fixture,
    pause,
    release,
    calls,
    body,
    check,
    close,
    reopen,
  };
};

const folderBox = (page) => page.getByRole("textbox", { name: "Folder on ministorm" });
const chooseFirst = (page) => page.getByRole("checkbox", { name: "Choose what to copy" });
const COPY_ONLY = ["where", "what", "review", "copy", "done"];
const MOVE = ["where", "what", "review", "copy", "transfer", "done"];
const bar = (states, ids = COPY_ONLY) => ids.map((id, index) => `${id}:${states[index]}`).join(" ");

/**
 * Choosing flow: Measure, look back at Where, Preview, Back to What, change what to copy,
 * compare again, close and reopen mid-Review, copy, then reopen on the archived last copy.
 */
const choosing = async (page, w) => {
  const { action, step, pause, release, calls, body, check, close, reopen } = w;
  await check("where", {
    primary: "Copy to ministorm",
    steps: bar(["current", "next", "next", "next", "next"]),
    back: false,
  });
  await chooseFirst(page).click();
  await check("where-choose", { primary: "Measure the folder", back: false });
  await pause("copyOffer");
  await action("Measure the folder").click();
  await check("measuring", {
    primary: null,
    steps: bar(["done", "current", "next", "next", "next"]),
  });
  NodeAssert.equal(await action("Cancel copy").isEnabled(), true);
  await release("copyOffer");
  await check("what", {
    primary: "Preview on ministorm",
    steps: bar(["done", "current", "next", "next", "next"]),
    back: true,
  });
  NodeAssert.match(await body(), /Saved scan from/);
  const pendingBeforeRefresh = await page.evaluate(() =>
    localStorage.getItem("specwithcode:folder-copy:m4:source"),
  );
  await page.getByRole("button", { name: "Refresh scan", exact: true }).click();
  await page.getByText("The source still matches this scan.", { exact: false }).waitFor();
  await check("what-refreshed", { primary: "Preview on ministorm", back: true });
  NodeAssert.equal(
    await page.evaluate(() => localStorage.getItem("specwithcode:folder-copy:m4:source")),
    pendingBeforeRefresh,
    "refresh preserves the job pointer and choices",
  );
  await page.evaluate(() => {
    window.__folderCopyFixture.scanCurrent = false;
  });
  await page.getByRole("button", { name: "Refresh scan", exact: true }).click();
  await page.getByRole("button", { name: "Measure and compare again", exact: true }).waitFor();
  NodeAssert.equal(await action("Preview on ministorm").isDisabled(), true);
  await check("what-source-changed", { primary: null, back: true });
  await page.evaluate(() => {
    window.__folderCopyFixture.scanCurrent = true;
  });
  await page.getByRole("button", { name: "Refresh scan", exact: true }).click();
  await page.getByText("The source still matches this scan.", { exact: false }).waitFor();
  NodeAssert.equal(await step("review").isDisabled(), true, "a future step is disabled");

  await step("where").click();
  await check("where-review", {
    primary: "Go to What",
    steps: bar(["done+viewing", "current", "next", "next", "next"]),
    back: false,
  });
  NodeAssert.match(await body(), /You're viewing Where\. The copy is at What\./);
  NodeAssert.equal(await folderBox(page).isDisabled(), true, "the Where review is read-only");
  NodeAssert.equal(await action("Change folder").count(), 1);
  NodeAssert.equal(await action("Preview on ministorm").count(), 0, "live actions are hidden");
  const offers = await calls("copyOffer");
  await action("Go to What").click();
  await check("what-again", { primary: "Preview on ministorm", back: true });
  NodeAssert.equal(await calls("copyOffer"), offers, "looking back calls no machine");

  await pause("copyStart");
  await action("Preview on ministorm").click();
  await check("comparing", {
    primary: null,
    steps: bar(["done", "done", "current", "next", "next"]),
  });
  await release("copyStart");
  await check("review", {
    primary: "Copy to ministorm",
    steps: bar(["done", "done", "current", "next", "next"]),
    back: true,
  });

  await action("Back").click();
  await check("what-review", {
    primary: "Go to Review",
    steps: bar(["done", "done+viewing", "current", "next", "next"]),
    back: true,
  });
  NodeAssert.match(await body(), /You're viewing What\. The copy is at Review\./);
  await action("Change what to copy (measures again)").click();
  await check("rechosen", {
    primary: "Preview on ministorm",
    steps: bar(["done", "current", "next", "next", "next"]),
    back: true,
  });
  NodeAssert.equal(await calls("copyOffer"), offers + 1, "changing what to copy measures again");
  NodeAssert.equal(await calls("copyCancel"), 1, "and cancels the compared copy");
  await action("Preview on ministorm").click();
  await check("review-again", { primary: "Copy to ministorm" });

  // Mid-Review, looking at What: the reopen checks the copy, then brings What back.
  await step("what").click();
  await check("what-before-close", { primary: "Go to Review" });
  await close();
  await pause("copyStatus");
  await reopen();
  await page.getByText(/Checking the copy to/).waitFor();
  await check("checking", {
    primary: null,
    steps: bar(["done", "done", "current", "next", "next"]),
  });
  NodeAssert.match(
    await body(),
    /Checking the copy to \/home\/anton\/Projects\/github\/specweave-umb on ministorm…/,
  );
  NodeAssert.equal(await step("where").isDisabled(), true, "every step is locked while checking");
  await release("copyStatus");
  await check("restored", {
    primary: "Go to Review",
    steps: bar(["done", "done+viewing", "current", "next", "next"]),
    back: true,
  });
  NodeAssert.match(await body(), /Picked up where you left off\./);
  await action("Go to Review").click();

  await pause("copyApprove");
  await action("Copy to ministorm").click();
  await check("copying", {
    primary: null,
    steps: bar(["done", "done", "done", "current", "next"]),
  });
  await release("copyApprove");
  await check("done", {
    primary: "Open on ministorm",
    steps: bar(["done", "done", "done", "done", "current"]),
    back: true,
  });
  NodeAssert.equal(await action("Undo…").count(), 1);

  // Done was seen: the reopen archives the copy and starts at Where with a last-copy strip.
  await close();
  const statuses = await calls("copyStatus");
  await reopen();
  await page.locator('[data-slot="copy-last"]').waitFor();
  // The reopen shows the last copy without scrolling.
  NodeAssert.ok(
    await page.evaluate(() => {
      const strip = document.querySelector('[data-slot="copy-last"]').getBoundingClientRect();
      const body = document.querySelector('[data-slot="dialog-popup"]').getBoundingClientRect();
      return strip.top >= body.top && strip.bottom <= body.bottom - 80;
    }),
    "the last-copy line is visible on reopen",
  );
  await check("last-copy", {
    primary: "Measure the folder",
    steps: bar(["current", "next", "next", "next", "next"]),
    back: false,
  });
  NodeAssert.equal(await calls("copyStatus"), statuses, "an archived copy is not checked");
  await page.locator('[data-slot="copy-last"]').getByRole("button", { name: "View" }).click();
  await check("last-copy-view", {
    primary: "Open on ministorm",
    steps: bar(["done", "done", "done", "done", "current"]),
  });
  NodeAssert.equal(await action("Undo…").count(), 1, "View leads to Done with Undo");
};

/**
 * One-click flow: Copy to X runs to Done, with What and Review marked automatic and open to
 * look at. A copy closed while copying shows Checking on reopen, then what happened.
 */
const oneClick = async (page, w) => {
  const { action, step, pause, release, body, check, close, reopen } = w;
  await check("where", { primary: "Copy to ministorm", back: false });
  await action("Copy to ministorm").click();
  const finished = bar(["done", "done+auto", "done+auto", "done", "current"]);
  await check("done", { primary: "Open on ministorm", steps: finished, back: true });
  NodeAssert.equal(await step("what").isEnabled(), true, "an automatic step can be opened");
  NodeAssert.equal(await step("review").isEnabled(), true);
  await step("what").click();
  await check("what-auto", {
    primary: "Go to Done",
    steps: bar(["done", "done+auto+viewing", "done+auto", "done", "current"]),
    back: true,
  });
  NodeAssert.match(await body(), /Chosen automatically\./);
  await step("review").click();
  await check("review-auto", {
    primary: "Go to Done",
    steps: bar(["done", "done+auto", "done+auto+viewing", "done", "current"]),
    back: true,
  });
  NodeAssert.match(await body(), /Plan as approved\..*approved automatically/);
  await action("Go to Done").click();
  await check("done-again", { primary: "Open on ministorm", steps: finished });

  // A second copy closed while copying: the reopen checks it, then says it finished.
  await action("Start a new copy").click();
  await check("where-new", { primary: "Copy to ministorm", back: false });
  await pause("copyApprove");
  await action("Copy to ministorm").click();
  await check("copying", {
    primary: null,
    steps: bar(["done", "done+auto", "done+auto", "current", "next"]),
  });
  await close();
  await release("copyApprove");
  await pause("copyStatus");
  await reopen();
  await page.getByText(/Checking the copy to/).waitFor();
  await check("checking", {
    primary: null,
    steps: bar(["done", "done", "done", "current", "next"]),
  });
  await release("copyStatus");
  await check("finished-while-closed", { primary: "Open on ministorm", steps: finished });
  NodeAssert.match(await body(), /finished while the window was closed/);
};

/**
 * A move chosen step by step: the source scopes, a failed copy and its retry, the deferred
 * context transfer (which locks closing), and a measure error in the footer.
 */
const move = async (page, w) => {
  const { footer, action, pause, release, calls, body, check, fixture } = w;
  await chooseFirst(page).click();
  await page.locator("label").filter({ hasText: "Copy and transfer coordinator context" }).click();
  await check("where", {
    primary: "Measure the folder",
    steps: bar(["current", "next", "next", "next", "next", "next"], MOVE),
    back: false,
  });
  const scopes = page.getByRole("radiogroup", { name: "Source folder" });
  NodeAssert.match(
    await scopes.locator('[aria-checked="true"]').locator("..").locator("..").textContent(),
    /Whole umbrella.*recommended/,
  );
  await scopes.scrollIntoViewIfNeeded();
  await page.getByText("Included repositories (4)", { exact: true }).click();
  await page
    .locator('[data-slot="copy-source-folder"]')
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await check("umbrella-scope", { primary: "Measure the folder" });
  await scopes.locator("label").filter({ hasText: "This project folder only" }).click();
  NodeAssert.equal(
    await folderBox(page).inputValue(),
    "/home/anton/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
  );
  await check("child-scope", { primary: "Measure the folder" });
  await scopes.locator("label").filter({ hasText: "Whole umbrella" }).click();
  await page.locator('[data-slot="copy-destination-project"]').scrollIntoViewIfNeeded();
  NodeAssert.match(
    await page.locator('[data-slot="copy-destination-project"]').textContent(),
    /specweave-umb\/repositories\/anton-abyzov\/specweave/,
  );
  const beforeScroll = await footer.boundingBox();
  const scroll = await page.locator('[data-slot="dialog-panel"]').evaluate((element) => {
    const viewport = element.parentElement;
    viewport.scrollTop = viewport.scrollHeight;
    return {
      scrollTop: viewport.scrollTop,
      maximum: viewport.scrollHeight - viewport.clientHeight,
    };
  });
  NodeAssert.ok(scroll.maximum > 0 && scroll.scrollTop > 0, "the body really scrolls");
  await check("scrolled", { primary: "Measure the folder" });
  NodeAssert.equal((await footer.boundingBox()).y, beforeScroll.y, "the footer stays put");

  // Two clicks in one task start one measure.
  await pause("copyOffer");
  await action("Measure the folder").evaluate((element) => {
    element.click();
    element.click();
  });
  await check("measuring", { primary: null });
  NodeAssert.equal(await calls("copyOffer"), 1, "a double click offers once");
  await release("copyOffer");
  await check("what", { primary: "Preview on ministorm", back: true });
  NodeAssert.match(await body(), /You can copy now/);
  await action("Preview on ministorm").click();
  await check("review", {
    primary: "Copy and transfer context to ministorm",
    steps: bar(["done", "done", "current", "next", "next", "next"], MOVE),
    back: true,
  });
  NodeAssert.deepEqual(await fixture(() => window.__folderCopyFixture.copyRequests.at(-1)), {
    copyRoot: "/Users/you/Projects/github/specweave-umb",
    projectRelativePath: "repositories/anton-abyzov/specweave",
    targetFolder: "/home/anton/Projects/github/specweave-umb",
  });
  await fixture(() => {
    window.__folderCopyFixture.failCopy = true;
  });
  await action("Copy and transfer context to ministorm").click();
  await check("failed", { primary: "Retry", back: true });
  // The stopped step reads in the error colour, not in the plain current-step colour.
  NodeAssert.deepEqual(
    await w.step("copy").evaluate((item) => {
      const error = document.querySelector(
        '[data-slot="dialog-panel"] .text-destructive-foreground',
      );
      return {
        tone: item.dataset.tone,
        coloured: !!error && getComputedStyle(item).color === getComputedStyle(error).color,
      };
    }),
    { tone: "failed", coloured: true },
  );
  NodeAssert.match(
    await body(),
    /Nothing in \/home\/anton\/Projects\/github\/specweave-umb changed/,
  );
  // Nothing changed before Apply, so Retry runs the same copy again from measuring.
  await fixture(() => {
    window.__folderCopyFixture.failCopy = false;
  });
  await pause("copyOffer");
  await action("Retry").focus();
  await page.keyboard.press("Space");
  await check("retrying", {
    primary: null,
    steps: bar(["done", "current", "next", "next", "next", "next"], MOVE),
  });
  await release("copyOffer");
  await action("Preview on ministorm").click();
  await check("review-retry", { primary: "Copy and transfer context to ministorm", back: true });
  await action("Copy and transfer context to ministorm").click();
  await check("deferred", {
    primary: "Transfer coordinator context",
    steps: bar(["done", "done", "done", "done", "current", "next"], MOVE),
    back: true,
  });
  NodeAssert.match(
    await page.locator('[data-slot="copy-done"]').textContent(),
    /files are copied. Work is still running/,
  );
  await fixture(() => {
    window.__folderCopyFixture.transferReady = true;
  });
  await pause("prepare");
  await action("Transfer coordinator context").click();
  await check("transferring", { primary: null });
  const closers = page.getByRole("dialog").getByRole("button", { name: "Close" });
  for (const closer of await closers.all())
    NodeAssert.equal(await closer.isDisabled(), true, "the transfer locks closing");
  await page.keyboard.press("Escape");
  NodeAssert.equal(await page.getByRole("dialog").count(), 1, "Escape keeps a locked dialog");
  await release("prepare");
  await check("done", {
    primary: "Open on ministorm",
    steps: bar(["done", "done", "done", "done", "done", "current"], MOVE),
    back: true,
  });
  NodeAssert.match(
    await page.locator('[data-slot="copy-done"]').textContent(),
    /The coordinator continues/,
  );
  await action("Start a new copy").click();
  await fixture(() =>
    window.__folderCopyFixture.failNext("copyOffer", "io", "The source folder cannot be read."),
  );
  await action("Measure the folder").click();
  await page.locator('[data-slot="dialog-footer"] [role="alert"]').waitFor();
  await check("error", { primary: "Measure the folder", back: false });
  NodeAssert.match(await footer.textContent(), /The source folder cannot be read/);
};

const FLOWS = { choosing, "one-click": oneClick, move };
try {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 1280, height: 800 },
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const [flow, walk] of Object.entries(FLOWS)) {
        const label = `${theme}-${viewport.width}x${viewport.height}`;
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
        await page.waitForLoadState("networkidle");
        await folderBox(page).waitFor();
        NodeAssert.equal(
          await folderBox(page).inputValue(),
          "/home/anton/Projects/github/specweave-umb",
        );
        const w = walker(page, label, flow, viewport);
        try {
          await walk(page, w);
        } catch (cause) {
          await page.screenshot({
            path: NodePath.join(output, `${label}-${flow}-FAILED.png`),
            fullPage: true,
          });
          throw cause;
        }
        NodeAssert.deepEqual(errors, [], `${label} ${flow}: page errors`);
        receipt.cases.push({ flow, theme, viewport, result: "passed", stages: w.stages });
        await page.close();
      }
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      result: "passed",
      headless: true,
      cases: receipt.cases.length,
      screenshots: receipt.cases.reduce((total, entry) => total + entry.stages.length, 0),
      output,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
