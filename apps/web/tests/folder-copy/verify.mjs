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
    "the leading ghost action (Stop copy, Change setup, Undo…) is leftmost with mr-auto",
    "the dialog title on each screen: Hand off/Copy {project}, then {project} is on {machine}",
  ],
  cases: [],
};

// The step line as "id:state" words, read the same way in and out of the page. It lists only
// the steps this run shows: one click skips What, and Review when nothing needs reviewing.
const BAR_SCRIPT = () =>
  [...document.querySelectorAll('[data-slot="copy-step"]')]
    .map((item) => `${item.dataset.stepId}:${item.dataset.state}`)
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
  /** Opens the ⋯ menu in the footer and picks one of its items. */
  const menu = async (name) => {
    await footer.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  /**
   * `primary` is the one enabled primary's label, or null where the step is busy and offers
   * none. `steps` is the expected bar, `leading` the ghost action at the far left (null for
   * none), `title` the dialog title.
   */
  const check = async (stage, { primary, steps, leading, title }) => {
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
      const full = popup.querySelector('[data-slot="copy-steps"]');
      // A phone shows one "Step N of M · Label" line in place of the full bar.
      const compact = popup.querySelector('[data-slot="copy-steps-compact"]');
      const phone = !!full && full.getClientRects().length === 0;
      const bar = phone ? compact : full;
      const box = popup.getBoundingClientRect();
      const items = bar
        ? phone
          ? [bar]
          : [...bar.querySelectorAll('[data-slot="copy-step"]')]
        : [];
      const lead = footer.querySelector("button[data-leading]");
      const actions = footer.querySelector('[data-slot="copy-actions"]');
      return {
        title: popup.querySelector('[data-slot="dialog-title"], h2')?.textContent.trim() ?? null,
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
          ? phone
            ? Math.round(
                bar.getBoundingClientRect().height /
                  parseFloat(getComputedStyle(bar).lineHeight || "16"),
              ) || 1
            : new Set([...bar.children].map((li) => Math.round(li.getBoundingClientRect().top)))
                .size
          : 0,
        compact: phone ? (compact?.textContent ?? null) : null,
        steps: new Function(`return (${script})()`)(),
        primaries: [...footer.querySelectorAll("button")]
          .filter((button) => button.classList.contains("bg-primary") && !button.disabled)
          .map((button) => ({
            text: button.textContent.trim(),
            rect: button.getBoundingClientRect().toJSON(),
            inScroll: !!button.closest('[data-slot="scroll-area-viewport"]'),
          })),
        leading: lead
          ? {
              text: lead.textContent.trim(),
              // Leftmost of the buttons on its row, whatever the row's direction.
              leftmost: [...actions.querySelectorAll("button")].every((button) => {
                const rect = button.getBoundingClientRect();
                const own = lead.getBoundingClientRect();
                return Math.abs(rect.top - own.top) > 4 || rect.left >= own.left - 1;
              }),
              // The row is reversed: the leading action is pushed left by mr-auto.
              mrAuto: actions.className.includes("[&>[data-leading]]:mr-auto"),
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
    if (title) NodeAssert.equal(layout.title, title, `${label} ${flow} ${stage}: title`);
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
    if (leading !== undefined) {
      NodeAssert.equal(layout.leading?.text ?? null, leading, `${label} ${flow} ${stage}: leading`);
      if (leading)
        NodeAssert.deepEqual(
          { leftmost: layout.leading.leftmost, mrAuto: layout.leading.mrAuto },
          { leftmost: true, mrAuto: true },
          `${label} ${flow} ${stage}: ${leading} sits at the far left`,
        );
    }
    const file = `${label}-${flow}-${String(stages.length + 1).padStart(2, "0")}-${stage}.png`;
    await page.screenshot({ path: NodePath.join(output, file), fullPage: true });
    stages.push({
      stage,
      primary,
      title: layout.title,
      steps: layout.steps,
      stepRows: layout.stepRows,
      file,
    });
  };
  /**
   * Closing unmounts the copy flow, as the real dialog does; reopening mounts it again.
   * Escape closes whether the dialog has a text Cancel or only its X.
   */
  const close = async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  };
  const reopen = async () => {
    await page.locator('[data-slot="fixture-reopen"]').click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page.locator('[data-slot="dialog-popup"]').evaluate(async (popup) => {
      await new Promise(requestAnimationFrame);
      await Promise.all(
        popup
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
  };
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
    menu,
    check,
    close,
    reopen,
  };
};

const folderBox = (page) => page.getByRole("textbox", { name: "Folder on ministorm" });
/** "Let me choose file types first", under More options. */
const chooseFirst = async (page) => {
  const box = page.getByRole("checkbox", { name: "Let me choose file types first" });
  if (!(await box.isVisible())) await page.getByRole("button", { name: "More options" }).click();
  await box.click();
};
/** Which half of the "What to do" toggle is pressed. */
const intent = (page) =>
  page
    .getByRole("group", { name: "What to do" })
    .locator('button[aria-pressed="true"]')
    .textContent();
const COPY_TITLE = "Copy SpecWeave";
const MOVE_TITLE = "Hand off SpecWeave";
const DONE_TITLE = "SpecWeave is on ministorm";
// A copy of files only leaves the project here: its Done says copied, not on.
const COPIED_TITLE = "SpecWeave is copied to ministorm";
const COPY_ONLY = ["where", "what", "review", "copy", "done"];
const ONE_CLICK = ["where", "copy", "done"];
const MOVE = ["where", "what", "review", "copy", "transfer", "done"];
const bar = (states, ids = COPY_ONLY) => ids.map((id, index) => `${id}:${states[index]}`).join(" ");

/**
 * Choosing flow: choose file types first, refresh the scan, preview, Change setup back to
 * Where, compare again, close and reopen mid-Review, copy, then reopen on the archived last copy.
 */
const choosing = async (page, w) => {
  const { action, pause, release, calls, body, check, close, reopen } = w;
  await check("where", {
    primary: "Copy to ministorm",
    steps: bar(["current", "next", "next"], ONE_CLICK),
    leading: null,
    title: COPY_TITLE,
  });
  NodeAssert.equal(await action("Cancel").count(), 1, "Where offers Cancel");
  NodeAssert.equal(await intent(page), "Copy files only", "the dialog opened as a copy");
  await chooseFirst(page);
  await check("where-choose", {
    primary: "Copy to ministorm",
    steps: bar(["current", "next", "next", "next", "next"]),
    leading: null,
  });
  await pause("copyOffer");
  await action("Copy to ministorm").click();
  await check("measuring", {
    primary: null,
    steps: bar(["done", "current", "next", "next", "next"]),
    leading: "Stop copy",
  });
  NodeAssert.match(
    await page.locator('[data-slot="copy-measuring"]').textContent(),
    /^Measuring…/,
    "one progress line while measuring",
  );
  NodeAssert.match(await body(), /You can close this window\. We’ll notify you when it’s done\./);
  NodeAssert.equal(await action("Stop copy").isEnabled(), true);
  await release("copyOffer");
  await check("what", {
    primary: "Preview on ministorm",
    steps: bar(["done", "current", "next", "next", "next"]),
    leading: "Stop copy",
  });
  NodeAssert.match(await body(), /Measured (?!earlier)[^·]+·Measure again/);
  NodeAssert.match(await body(), /Your choices.*Copy to ministorm: \/home\/anton/);
  const pendingBeforeRefresh = await page.evaluate(() =>
    localStorage.getItem("specwithcode:folder-copy:m4:source"),
  );
  await page.getByRole("button", { name: "Measure again", exact: true }).click();
  await page
    .getByText("Nothing changed since then, so your choices stay.", { exact: false })
    .waitFor();
  await check("what-refreshed", { primary: "Preview on ministorm", leading: "Stop copy" });
  NodeAssert.equal(
    await page.evaluate(() => localStorage.getItem("specwithcode:folder-copy:m4:source")),
    pendingBeforeRefresh,
    "refresh preserves the job pointer and choices",
  );
  await page.evaluate(() => {
    window.__folderCopyFixture.scanCurrent = false;
  });
  await page.getByRole("button", { name: "Measure again", exact: true }).click();
  await page.getByRole("button", { name: "Measure and compare again", exact: true }).waitFor();
  NodeAssert.equal(await action("Preview on ministorm").isDisabled(), true);
  await check("what-source-changed", { primary: null, leading: "Stop copy" });
  await page.evaluate(() => {
    window.__folderCopyFixture.scanCurrent = true;
  });
  await page.getByRole("button", { name: "Measure again", exact: true }).click();
  await page
    .getByText("Nothing changed since then, so your choices stay.", { exact: false })
    .waitFor();
  // The step bar only shows progress: nothing in it can be clicked.
  NodeAssert.equal(
    await page.locator('[data-slot="copy-steps"] button').count(),
    0,
    "the step bar has no buttons",
  );

  const offers = await calls("copyOffer");
  await pause("copyStart");
  await action("Preview on ministorm").click();
  await check("comparing", {
    primary: null,
    steps: bar(["done", "done", "current", "next", "next"]),
    leading: "Stop copy",
  });
  NodeAssert.match(
    await page.locator('[data-slot="copy-working"]').textContent(),
    /^Comparing with ministorm…/,
  );
  await release("copyStart");
  await check("review", {
    primary: "Copy to ministorm",
    steps: bar(["done", "done", "current", "next", "next"]),
    leading: "Change setup",
  });
  NodeAssert.match(await body(), /Nothing on ministorm would be replaced\./);

  // Change setup stops this copy and goes back to Where with the same choices.
  await action("Change setup").click();
  await check("changed-setup", {
    primary: "Copy to ministorm",
    steps: bar(["current", "next", "next", "next", "next"]),
    leading: null,
    title: COPY_TITLE,
  });
  NodeAssert.match(await body(), /Copy cancelled\. Nothing on ministorm changed\./);
  NodeAssert.equal(await calls("copyCancel"), 1, "Change setup cancels the compared copy");
  NodeAssert.equal(
    await page.getByRole("checkbox", { name: "Let me choose file types first" }).isChecked(),
    true,
    "the choices are kept",
  );
  await action("Copy to ministorm").click();
  await check("rechosen", {
    primary: "Preview on ministorm",
    steps: bar(["done", "current", "next", "next", "next"]),
  });
  NodeAssert.equal(await calls("copyOffer"), offers + 1, "starting again measures again");
  await action("Preview on ministorm").click();
  await check("review-again", { primary: "Copy to ministorm", leading: "Change setup" });

  // Mid-Review: the reopen checks the copy, then brings Review back.
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
  await release("copyStatus");
  await check("restored", {
    primary: "Copy to ministorm",
    steps: bar(["done", "done", "current", "next", "next"]),
    leading: "Change setup",
  });

  await pause("copyApprove");
  await action("Copy to ministorm").click();
  await check("copying", {
    primary: null,
    steps: bar(["done", "done", "done", "current", "next"]),
    leading: "Stop copy",
  });
  NodeAssert.match(await body(), /Copying 2\.0 KB…/);
  await release("copyApprove");
  await check("done", {
    primary: "Open on ministorm",
    steps: bar(["done", "done", "done", "done", "current"]),
    leading: "Undo…",
    title: COPIED_TITLE,
  });
  NodeAssert.match(await body(), /ministorm has a copy\. The coordinator stays here\./);

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
    primary: "Copy to ministorm",
    steps: bar(["current", "next", "next", "next", "next"]),
    leading: null,
    title: COPY_TITLE,
  });
  NodeAssert.equal(await calls("copyStatus"), statuses, "an archived copy is not checked");
  await page.locator('[data-slot="copy-last"]').getByRole("button", { name: "View" }).click();
  await check("last-copy-view", {
    primary: "Open on ministorm",
    steps: bar(["done", "done", "done", "done", "current"]),
    leading: "Undo…",
    title: COPIED_TITLE,
  });
};

/**
 * One-click flow: Copy to X runs to Done, with What and Review left off the step line. A copy
 * closed while copying shows Checking on reopen, then what happened.
 */
const oneClick = async (page, w) => {
  const { action, step, pause, release, body, menu, check, close, reopen } = w;
  await check("where", { primary: "Copy to ministorm", leading: null, title: COPY_TITLE });
  await action("Copy to ministorm").click();
  const finished = bar(["done", "done", "current"], ONE_CLICK);
  await check("done", {
    primary: "Open on ministorm",
    steps: finished,
    leading: "Undo…",
    title: COPIED_TITLE,
  });
  NodeAssert.equal(await step("what").count(), 0, "a step this run skipped is not listed");

  // A second copy closed while copying: the reopen checks it, then says it finished.
  await menu("Start a new copy");
  await check("where-new", { primary: "Copy to ministorm", leading: null, title: COPY_TITLE });
  await pause("copyApprove");
  await action("Copy to ministorm").click();
  await check("copying", {
    primary: null,
    steps: bar(["done", "current", "next"], ONE_CLICK),
    leading: "Stop copy",
  });
  await close();
  await release("copyApprove");
  await pause("copyStatus");
  await reopen();
  await page.getByText(/Checking the copy to/).waitFor();
  await check("checking", {
    primary: null,
    steps: bar(["done", "current", "next"], ONE_CLICK),
  });
  await release("copyStatus");
  await check("finished-while-closed", {
    primary: "Open on ministorm",
    steps: finished,
    title: COPIED_TITLE,
  });
  NodeAssert.match(await body(), /finished while the window was closed/);
};

/**
 * A move chosen step by step: the source scope, a failed copy and its retry, the deferred
 * coordinator move (which locks closing), and a measure error in the footer.
 */
const move = async (page, w) => {
  const { footer, action, pause, release, calls, body, menu, check, fixture } = w;
  await page
    .getByRole("group", { name: "What to do" })
    .getByRole("button", { name: "Hand off and continue there" })
    .click();
  NodeAssert.equal(await intent(page), "Hand off and continue there");
  await chooseFirst(page);
  await check("where", {
    primary: "Hand off to ministorm",
    steps: bar(["current", "next", "next", "next", "next", "next"], MOVE),
    leading: null,
    title: MOVE_TITLE,
  });
  // A clipped path fades its cut-off start under the "…", which has no background of its
  // own: nothing shows through it in dark mode either.
  NodeAssert.deepEqual(
    await page.evaluate(() => {
      const box = document.querySelector('[data-slot="folder-box"]');
      const mark = box.querySelector('[data-slot="folder-ellipsis"]');
      const clipped = box.hasAttribute("data-clipped");
      const faded = getComputedStyle(box.querySelector("input")).maskImage.includes("gradient");
      return {
        markBackground: getComputedStyle(mark).backgroundColor,
        fadedWhenClipped: faded === clipped,
      };
    }),
    { markBackground: "rgba(0, 0, 0, 0)", fadedWhenClipped: true },
    "the folder field's ellipsis",
  );
  const projectOnly = page.getByRole("checkbox", { name: "Copy only this project folder" });
  NodeAssert.equal(await projectOnly.isChecked(), false, "the whole umbrella goes by default");
  await projectOnly.scrollIntoViewIfNeeded();
  await check("umbrella-scope", { primary: "Hand off to ministorm" });
  await projectOnly.click();
  NodeAssert.equal(
    await folderBox(page).inputValue(),
    "/home/anton/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
  );
  await check("child-scope", { primary: "Hand off to ministorm" });
  await projectOnly.click();
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
  await check("scrolled", { primary: "Hand off to ministorm" });
  NodeAssert.equal((await footer.boundingBox()).y, beforeScroll.y, "the footer stays put");

  // Two clicks in one task start one measure.
  await pause("copyOffer");
  await action("Hand off to ministorm").evaluate((element) => {
    element.click();
    element.click();
  });
  await check("measuring", { primary: null, leading: "Stop handoff" });
  // A move's last step runs in this window: the close hint says to come back for it.
  NodeAssert.match(await body(), /then reopen it to finish the handoff\./);
  NodeAssert.equal(await calls("copyOffer"), 1, "a double click offers once");
  await release("copyOffer");
  await check("what", { primary: "Preview on ministorm", leading: "Stop handoff" });
  NodeAssert.match(
    await body(),
    /Work is still running here\. Files that change during the copy won.t be included, and the project moves once that work stops\./,
  );
  await action("Preview on ministorm").click();
  await check("review", {
    primary: "Hand off to ministorm",
    steps: bar(["done", "done", "current", "next", "next", "next"], MOVE),
    leading: "Change setup",
    title: MOVE_TITLE,
  });
  NodeAssert.deepEqual(await fixture(() => window.__folderCopyFixture.copyRequests.at(-1)), {
    copyRoot: "/Users/you/Projects/github/specweave-umb",
    projectRelativePath: "repositories/anton-abyzov/specweave",
    targetFolder: "/home/anton/Projects/github/specweave-umb",
  });
  await fixture(() => {
    window.__folderCopyFixture.failCopy = true;
  });
  await action("Hand off to ministorm").click();
  await check("failed", { primary: "Retry", leading: "Stop handoff" });
  // The stopped step reads in the error colour, not in the plain current-step colour.
  NodeAssert.deepEqual(
    await w.step("copy").evaluate((item) => {
      const error = document.querySelector(
        '[data-slot="dialog-panel"] .text-destructive-foreground',
      );
      const label = item.querySelector('[data-slot="copy-step-label"]');
      return {
        tone: item.dataset.tone,
        coloured: !!error && getComputedStyle(label).color === getComputedStyle(error).color,
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
  await check("review-retry", { primary: "Hand off to ministorm", leading: "Change setup" });
  await action("Hand off to ministorm").click();
  await check("deferred", {
    primary: "Hand off coordinator now",
    steps: bar(["done", "done", "done", "done", "current", "next"], MOVE),
    title: DONE_TITLE,
  });
  NodeAssert.match(
    await page.locator('[data-slot="copy-done"]').textContent(),
    /Files are copied\. Hand off the coordinator once work here is idle\./,
  );
  await fixture(() => {
    window.__folderCopyFixture.transferReady = true;
  });
  await pause("prepare");
  await action("Hand off coordinator now").click();
  await check("transferring", { primary: null });
  const closers = page.getByRole("dialog").getByRole("button", { name: /^(Close|Cancel)$/ });
  for (const closer of await closers.all())
    NodeAssert.equal(await closer.isDisabled(), true, "moving the coordinator locks closing");
  await page.keyboard.press("Escape");
  NodeAssert.equal(await page.getByRole("dialog").count(), 1, "Escape keeps a locked dialog");
  await release("prepare");
  await check("done", {
    primary: "Open on ministorm",
    steps: bar(["done", "done", "done", "done", "done", "current"], MOVE),
    title: DONE_TITLE,
  });
  NodeAssert.match(
    await page.locator('[data-slot="copy-done"]').textContent(),
    /The coordinator now runs on ministorm\./,
  );
  // Running work matters before Apply only: Done never contradicts the finished move.
  NodeAssert.doesNotMatch(await body(), /Work is still running here/);
  await menu("Start a new copy");
  await fixture(() =>
    window.__folderCopyFixture.failNext("copyOffer", "io", "The source folder cannot be read."),
  );
  const start = footer.locator("button.bg-primary").first();
  const startLabel = (await start.textContent()).trim();
  await start.click();
  await page.locator('[data-slot="dialog-footer"] [role="alert"]').waitFor();
  await check("error", { primary: startLabel, leading: null });
  NodeAssert.match(await footer.textContent(), /The source folder cannot be read/);
};

/** A source refusal must lead to a new review, including after closing the dialog. */
const staleRecovery = async (page, w) => {
  const { action, fixture, check, close, reopen } = w;
  await fixture(() => {
    window.__folderCopyFixture.destinationHasFiles = true;
  });
  await chooseFirst(page);
  await action("Copy to ministorm").click();
  await action("Preview on ministorm").click();
  await fixture(() =>
    window.__folderCopyFixture.failNext(
      "copyApprove",
      "refused",
      "The source changed or this saved scan has no freshness evidence. Refresh the scan and review a new comparison before copying.",
    ),
  );
  await action("Copy with my choices").click();
  await check("stale-preview", { primary: "Measure and compare again", leading: "Change setup" });
  NodeAssert.equal(await action("Copy with my choices").isDisabled(), true);
  NodeAssert.equal(await action("Replace everything").isDisabled(), true);
  NodeAssert.equal(
    await fixture(() => window.__folderCopyFixture.calls.filter((x) => x === "copyApprove").length),
    1,
  );
  await close();
  await reopen();
  await check("stale-reopened", { primary: "Measure and compare again", leading: "Change setup" });
  NodeAssert.equal(await action("Copy with my choices").isDisabled(), true);
  NodeAssert.equal(await action("Replace everything").isDisabled(), true);
  NodeAssert.equal(
    await fixture(() => window.__folderCopyFixture.calls.filter((x) => x === "copyApprove").length),
    1,
  );
  await action("Measure and compare again").click();
  await action("Preview on ministorm").click();
  await check("fresh-comparison", { primary: "Copy with my choices", leading: "Change setup" });
  await action("Copy with my choices").click();
  await check("recovered-copy", {
    primary: "Open on ministorm",
    leading: "Undo…",
    title: COPIED_TITLE,
  });
};

/** Captured files remain an explicit review even when active source writers keep changing. */
const capturedCopy = async (page, w) => {
  const { action, fixture, check, calls, body, close, reopen } = w;
  await fixture(() => {
    window.__folderCopyFixture.captured = true;
    window.__folderCopyFixture.destinationHasFiles = true;
  });
  await action("Copy to ministorm").click();
  await check("captured-review", { primary: "Copy with my choices", leading: "Change setup" });
  NodeAssert.equal(await calls("copyApprove"), 0, "capture never approves itself");
  NodeAssert.match(await body(), /This copy uses files captured/);
  NodeAssert.match(await body(), /Work is still running here. Later changes stay on the source/);
  NodeAssert.doesNotMatch(await body(), /Files that change during the copy/);
  NodeAssert.match(await body(), /New files and later edits stay on the source/);
  await fixture(() => {
    window.__folderCopyFixture.scanCurrent = false;
  });
  await page.getByRole("button", { name: "Measure again", exact: true }).click();
  await page.getByText(/The source changed. You can still copy the captured files/).waitFor();
  NodeAssert.match(await body(), /measurements and notices show the current source/);
  await check("captured-newer-source", {
    primary: "Copy with my choices",
    leading: "Change setup",
  });
  NodeAssert.equal(await calls("copyApprove"), 0);
  await close();
  await reopen();
  await check("captured-reopened", { primary: "Copy with my choices", leading: "Change setup" });
  NodeAssert.equal(await calls("copyApprove"), 0, "reopen keeps the review pending");
  await action("Copy with my choices").click();
  await check("captured-copy-done", {
    primary: "Open on ministorm",
    leading: "Undo…",
    title: COPIED_TITLE,
  });
  NodeAssert.equal(await calls("copyApprove"), 1, "only the person's click approves the copy");
};

/**
 * A ledger written on the source after the copy: the move lists it, the person moves
 * without it, and Done names the path that stayed on the source.
 */
const moveWithout = async (page, w) => {
  const { action, fixture, check, calls, body } = w;
  const ledger = ".specweave/increments/0001-move/ledger.jsonl";
  await fixture(() => {
    window.__folderCopyFixture.transferReady = true;
    window.__folderCopyFixture.sourceChanges = {
      digest: "c".repeat(64),
      total: 1,
      truncated: false,
      acceptable: true,
      rows: [{ path: ".specweave/increments/0001-move/ledger.jsonl", kind: "changed", size: 2048 }],
    };
  });
  await page
    .getByRole("group", { name: "What to do" })
    .getByRole("button", { name: "Hand off and continue there" })
    .click();
  await action("Hand off to ministorm").click();
  await page.locator('[data-slot="source-changes"]').waitFor();
  await check("source-changes", { primary: "Copy again", title: DONE_TITLE });
  NodeAssert.match(
    await page.locator('[data-slot="source-changes"]').textContent(),
    /ledger\.jsonl/,
  );
  NodeAssert.doesNotMatch(await body(), /The coordinator now runs on ministorm/);
  await action("Move without this path").click();
  await page.locator('[data-slot="copy-left-on-source"]').waitFor();
  await check("moved-without", { primary: "Open on ministorm", title: DONE_TITLE });
  NodeAssert.match(
    await page.locator('[data-slot="copy-done"]').textContent(),
    /The coordinator now runs on ministorm\./,
  );
  NodeAssert.ok(
    (await page.locator('[data-slot="copy-left-on-source"]').textContent()).includes(ledger),
    "Done names the path left on the source",
  );
  NodeAssert.ok((await calls("copyDrift")) >= 1, "Done reads what stayed on the source");
};

const FLOWS = {
  choosing,
  "one-click": oneClick,
  move,
  "move-without": moveWithout,
  "stale-recovery": staleRecovery,
  "captured-copy": capturedCopy,
};
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
