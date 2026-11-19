// Build first: vp build --config apps/web/tests/project-sync/vite.config.ts
// Usage: node apps/web/tests/project-sync/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Checks and shoots, light and dark, 1280 and 390 px wide: every state of the Sync dialog
// (picker, checking, the plan with each kind of repository row, running, each result, the
// extras with a secret, a finding and a file past a limit, each failure) and the machine menu
// with each sync fact, "Sync…" and "Add to another machine…"; then the plan screen in each of
// the eight languages. Each shot is measured for clipped text; the numbers are in the JSON.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const output = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".artifacts/project-sync/evidence",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/project-sync/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const results = [];
const errors = [];
const languageFailures = [];
const WIDTHS = [1280, 390];
const DIALOG = '[data-slot="dialog-popup"]';

async function open(query, width = 1280, height = 900) {
  const colorScheme = /(^|&)theme=dark(&|$)/.test(query) ? "dark" : "light";
  const page = await browser.newPage({ viewport: { width, height }, colorScheme });
  page.on("pageerror", (error) => errors.push(`${query}: ${error.message}`));
  await page.goto(`${origin}/?${query}`);
  return page;
}
const events = (page) => page.evaluate(() => window.__events ?? []);
const texts = (page, selector) => page.locator(selector).allTextContents();
const stage = (page) => page.locator("[data-project-sync]").getAttribute("data-project-sync");
const waitStage = (page, kind) => page.locator(`[data-project-sync="${kind}"]`).waitFor();
const cell = (page, repo, side) =>
  page.locator(`[data-sync-row="${repo}"] [data-sync-cell="${side}"]`);
/** The sentence, facts and Git detail of one repository on one machine, as shown. */
const said = async (page, repo, side) => ({
  sentence: await cell(page, repo, side).locator("[data-sync-sentence]").textContent(),
  facts: await cell(page, repo, side).locator("[data-sync-fact]").allTextContents(),
});

/** Text in the dialog or menu that is cut off, or that runs past its popup or the window. */
async function layoutProblems(page, scope) {
  return page.evaluate((scope) => {
    const popup = document.querySelector(scope);
    if (!popup) return [`nothing matches ${scope}`];
    const problems = [];
    const edge = popup.getBoundingClientRect();
    if (
      edge.right > window.innerWidth + 1 ||
      edge.left < -1 ||
      edge.bottom > window.innerHeight + 1
    )
      problems.push("the popup runs past the window");
    for (const el of popup.querySelectorAll(
      "h2,h3,p,button,label,code,li,[data-sync-cell] span,[data-row-sync],[data-row-note],[role=menuitem],[role=menuitemradio] .truncate",
    )) {
      const box = el.getBoundingClientRect();
      // The line for screen readers is clipped to a pixel on purpose.
      if (box.width === 0 || el.classList.contains("sr-only")) continue;
      const name = `${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 50)}"`;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== "inline")
        problems.push(`clipped ${name}: ${el.scrollWidth}px of text in ${el.clientWidth}px`);
      if (box.right > edge.right + 1 || box.left < edge.left - 1)
        problems.push(`past the popup edge ${name}`);
    }
    return problems;
  }, scope);
}
const shot = async (page, name, scope = DIALOG) => {
  const file = path.join(output, `${name}.png`);
  // The dialog scrolls inside itself: the shot is the window, and a second one its full list.
  await page.screenshot({ path: file });
  return { file, layout: await layoutProblems(page, scope) };
};
/** The whole scrolling panel in one image, for a list longer than the window. */
const longShot = async (page, name) => {
  const file = path.join(output, `${name}.png`);
  const height = await page.evaluate(() => {
    const panel = document.querySelector('[data-slot="dialog-panel"]');
    const scroller = panel?.closest('[data-slot="scroll-area-viewport"]') ?? panel;
    return scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
  });
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: size.height + Math.max(0, height) + 40 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file });
  const layout = await layoutProblems(page, DIALOG);
  await page.setViewportSize(size);
  return { file, layout };
};
const tick = (page, side, kind, nth = 0) =>
  page
    .locator(`[data-sync-extras="${side}"] [data-sync-extra="${kind}"] [data-slot="checkbox"]`)
    .nth(nth)
    .click();

/** What the plan says per repository on [m4, m5]: the sentence, then its facts. */
const OTHER = (branch) =>
  `On ${branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out`;
const NO_REMOTE = 'Not in Git on a remote. Use "Compare all files…"';
const NO_UPSTREAM = "No upstream. Its commits are listed as an extra";
/** state=upstream, on m4: the plan names which upstream it is; an older machine's row stays. */
const UPSTREAM_PLAN = {
  "apps/web": "Follows second/feature/menu, which is not a branch of origin. Not moved",
  "apps/api": "origin/release is no longer on origin. Not moved",
  docs: NO_UPSTREAM,
  "apps/status": "Moves forward 2 commits",
};
const UPSTREAM_RESULT = {
  "apps/web": UPSTREAM_PLAN["apps/web"],
  "apps/api": UPSTREAM_PLAN["apps/api"],
  "apps/status": "origin/main is no longer on origin. Not moved",
  "apps/worker":
    "Sync did not change it: origin could not be asked whether the branch is still there",
  // Its state could not be read at the run: never "0 uncommitted files".
  "tools/cli": "Not moved",
};
const PLAN = {
  // Level with its upstream, with uncommitted files and a thread at work: never bare.
  ".": [["Up to date"], ["Up to date", "2 uncommitted files", "In use by Docs lint"]],
  "apps/web": [["Moves forward 99 commits"], ["Up to date"]],
  "packages/ui": [["3 commits not pushed (listed as an extra)"], ["Moves forward 1 commit"]],
  "apps/status": [["Has 2 commits of its own and is 5 behind. Not moved"], ["Up to date"]],
  "apps/platform": [["Up to date"], ["Not moved forward: 3 uncommitted files"]],
  "apps/api": [["Up to date"], ["In use by Fix the login redirect"]],
  "tools/cli": [[OTHER("main")], [OTHER("feature/flags")]],
  docs: [["Up to date"], ["Not on a branch. Not moved"]],
  "vendor/mirror": [[NO_UPSTREAM], [NO_UPSTREAM]],
  notes: [[NO_REMOTE], [NO_REMOTE]],
  "apps/site": [["Up to date"], ["Clones it from https://git.example.com/acme/apps-site.git"]],
  scratch: [[NO_REMOTE], [NO_REMOTE]],
  "apps/worker": [
    ["Up to date"],
    [
      "Could not fetch: fatal: unable to access the remote: could not resolve host. The other repositories continue",
    ],
  ],
  infra: [
    ["Not fetched: this repository mirrors its remote, and a fetch would move its branches"],
    ["Up to date"],
  ],
};

try {
  for (const theme of ["light", "dark"])
    for (const width of WIDTHS) {
      const tag = `${theme}-${width}`;
      const at = (query) => open(`theme=${theme}&${query}`, width);

      // 1. The plan: one row per kind of repository, extras on both machines, all unticked.
      let page = await at("case=dialog&state=plan");
      await waitStage(page, "plan");
      assert.equal(await page.locator("h2").textContent(), "Sync Atlas: m4 and m5");
      assert.deepEqual(await events(page), [
        "fetch:m4",
        "fetch:m5",
        "inventory:m4",
        "inventory:m5",
      ]);
      const rows = await page
        .locator("[data-sync-row]")
        .evaluateAll((items) => items.map((item) => item.getAttribute("data-sync-row")));
      assert.equal(rows.length, 14);
      const plan = {};
      for (const repo of rows)
        plan[repo] = [await said(page, repo, "a"), await said(page, repo, "b")];
      for (const [repo, [a, b]] of Object.entries(PLAN)) {
        assert.deepEqual([plan[repo][0].sentence, ...plan[repo][0].facts], a, `${repo} on m4`);
        assert.deepEqual([plan[repo][1].sentence, ...plan[repo][1].facts], b, `${repo} on m5`);
      }
      assert.deepEqual(Object.keys(PLAN).sort(), [...rows].sort());
      assert.equal(await page.locator('[data-slot="checkbox"][data-checked]').count(), 0);
      // Stashes are listed and stay: the line has no box and no label to tick.
      const stash = page.locator('[data-sync-extra="stashes"]');
      assert.equal(await stash.count(), 1);
      assert.match(await stash.textContent(), /^1 stash in /);
      assert.equal(
        await stash.locator('[data-slot="checkbox"], [role="checkbox"], label').count(),
        0,
      );
      assert.ok(
        (await page.locator('[data-sync-extra="uncommitted"] [data-slot="checkbox"]').count()) > 0,
      );
      assert.equal(await page.locator("[data-sync-run]").isDisabled(), false);
      assert.equal(await page.locator("[data-sync-run]").textContent(), "Sync");
      // A secret by its name is never offered; a finding and an unread file are, once their
      // repository's uncommitted files are ticked.
      assert.equal(
        await page.locator('[data-sync-left-out="name"] [data-sync-send-anyway]').count(),
        0,
      );
      assert.equal(await page.locator("[data-sync-send-anyway]").count(), 2);
      assert.equal(await page.locator("[data-sync-send-anyway]").first().isDisabled(), true);
      let taken = await shot(page, `plan-${tag}`);
      const whole = await longShot(page, `plan-whole-${tag}`);
      results.push({ theme, width, case: "plan", ...taken, whole, plan });

      // Tick extras: two branches, the uncommitted files, and "Send anyway" for the finding.
      await tick(page, "a", "not-pushed");
      await tick(page, "a", "only-here");
      await tick(page, "a", "uncommitted");
      await tick(page, "b", "uncommitted");
      const anyway = page.locator('[data-sync-left-out="content"] [data-sync-send-anyway]');
      assert.equal(await anyway.isDisabled(), false);
      await anyway.click();
      assert.equal(await anyway.textContent(), "Will be sent");
      await page.locator('[data-sync-extras="a"]').scrollIntoViewIfNeeded();
      const ticked = await shot(page, `plan-extras-ticked-${tag}`);

      // 2. The result: what moved, what stays and why, and each extra with its branch.
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      const calls = (await events(page)).slice(4);
      assert.equal(calls.filter((call) => call.startsWith("run:")).length, 2);
      assert.ok(
        calls.includes(
          'run:m4:{"fastForward":[{"path":"apps/web","otherBranch":"main"}],"clone":[]}',
        ),
        calls.join("\n"),
      );
      const sent = calls.filter((call) => call.startsWith("extras:"));
      assert.equal(sent.length, 2);
      assert.ok(sent[0].startsWith("extras:m4>m5:"));
      assert.ok(sent[0].includes('"sendAnyway":["notes/keys.txt"]'), sent[0]);
      assert.ok(!sent[0].includes(".env.local"), "a secret by its name was sent");
      assert.ok(sent[1].startsWith("extras:m5>m4:"));
      assert.equal((await said(page, "apps/web", "a")).sentence, "Moved forward 99 commits");
      // Still never bare after the run.
      assert.deepEqual((await said(page, ".", "b")).facts, [
        "2 uncommitted files",
        "In use by Docs lint",
      ]);
      const extraResults = await texts(page, "[data-sync-extra-result]");
      assert.equal(extraResults.length, 4);
      assert.ok(
        extraResults.some((line) => line.includes("swc/from-m4/fix/menu")),
        extraResults.join("\n"),
      );
      assert.equal(
        await page.locator('[data-sync-extra-result="stays"]').count(),
        1,
        "the file past the limit stays",
      );
      // Not everything is in sync: the title does not claim it.
      assert.equal(await page.locator("h2").textContent(), "Sync Atlas: m4 and m5");
      taken = await shot(page, `result-${tag}`);
      const wholeResult = await longShot(page, `result-whole-${tag}`);
      results.push({
        theme,
        width,
        case: "result",
        ...taken,
        ticked,
        whole: wholeResult,
        extraResults,
      });
      // "Check again" fetches on both machines again.
      await page.locator("[data-sync-again]").click();
      await waitStage(page, "plan");
      assert.deepEqual((await events(page)).slice(-4), [
        "fetch:m4",
        "fetch:m5",
        "inventory:m4",
        "inventory:m5",
      ]);
      await page.close();

      // 3. Running: the run has not answered; nothing can be pressed and it cannot be closed.
      page = await at("case=dialog&state=small&hold=run");
      await waitStage(page, "plan");
      assert.equal((await said(page, "apps/web", "b")).sentence, "Moves forward 12 commits");
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "running");
      assert.equal(await page.locator("[data-sync-progress]").textContent(), "Syncing m4 and m5…");
      assert.equal(await page.locator("[data-sync-run]").isDisabled(), true);
      assert.equal(await page.locator("[data-sync-run]").textContent(), "Syncing…");
      await page.keyboard.press("Escape");
      assert.equal(await stage(page), "running");
      taken = await shot(page, `running-${tag}`);
      results.push({ theme, width, case: "running", ...taken });
      await page.close();

      // 4. One repository to move, and afterwards the project is in sync.
      page = await at("case=dialog&state=small");
      await waitStage(page, "plan");
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      assert.equal(await page.locator("h2").textContent(), "Atlas is in sync on m4 and m5");
      assert.equal(
        await page.locator("[data-sync-live]").textContent(),
        "Atlas is in sync on m4 and m5",
      );
      // The repositories are a table: each cell is heard under its machine's column.
      assert.deepEqual(await texts(page, `${DIALOG} [role="columnheader"]`), [
        "Repository",
        "m4",
        "m5",
      ]);
      assert.equal((await said(page, "apps/web", "b")).sentence, "Moved forward 12 commits");
      // Only m5 had something to do.
      assert.deepEqual(
        (await events(page)).filter((call) => call.startsWith("run:")),
        ['run:m5:{"fastForward":[{"path":"apps/web","otherBranch":"main"}],"clone":[]}'],
      );
      taken = await shot(page, `result-in-sync-${tag}`);
      results.push({ theme, width, case: "result, in sync", ...taken });
      await page.locator("[data-sync-done]").click();
      await page.locator('[data-dialog-page="closed"]').waitFor();
      await page.close();

      // 5. Nothing to do: Sync is off, and says why.
      page = await at("case=dialog&state=idle");
      await waitStage(page, "plan");
      assert.equal(await page.locator("[data-sync-run]").isDisabled(), true);
      assert.equal(
        await page.locator("[data-sync-idle]").textContent(),
        "Nothing to move forward or clone. Tick an extra to send it.",
      );
      taken = await shot(page, `plan-nothing-to-do-${tag}`);
      results.push({ theme, width, case: "plan, nothing to do", ...taken });
      // "Compare all files…" hands over to the measured folder copy and closes this dialog.
      await page.locator("[data-sync-compare]").click();
      assert.deepEqual((await events(page)).slice(-2), ["compare:m5", "closed"]);
      await page.close();

      // 6. Several machines: a picker first, and nothing is fetched before a pick.
      page = await at("case=dialog&state=picker");
      await waitStage(page, "pick");
      assert.equal(await page.locator("h2").textContent(), "Sync Atlas");
      assert.deepEqual(await events(page), []);
      assert.deepEqual(await texts(page, "[data-sync-target]"), [
        "m5",
        // The row names the machine: the reason is said without it.
        "linux-miniOffline",
        "m1Needs update · 1.4.2",
        "m3This window can only read m3",
        "m2Separate project",
      ]);
      assert.deepEqual(
        await page
          .locator("[data-sync-target]")
          .evaluateAll((items) => items.map((item) => item.disabled)),
        [false, true, true, true, true],
      );
      taken = await shot(page, `picker-${tag}`);
      results.push({ theme, width, case: "picker", ...taken });
      await page.locator('[data-sync-target="m5:p"]').click();
      await waitStage(page, "plan");
      await page.close();

      // 7. The fetch has not answered.
      page = await at("case=dialog&state=checking");
      await waitStage(page, "checking");
      assert.equal(await page.locator("[data-sync-live]").textContent(), "Fetching on m4 and m5…");
      // One live region that stays: the visible line is not a second one.
      assert.equal(await page.locator(`${DIALOG} p[role="status"]`).count(), 1);
      assert.equal(await page.locator("[data-sync-run]").isDisabled(), true);
      taken = await shot(page, `checking-${tag}`);
      results.push({ theme, width, case: "checking", ...taken });
      await page.close();

      // 8. Why a machine could not take part: nothing changed, and the slow path is offered.
      const failures = {
        offline: "m5 is offline. Sync needs both machines connected.",
        "read-only":
          "This window can only read m5, so it cannot sync it. Open SpecWithCode on m5, or connect to it with full access.",
        "needs-update":
          'Update SpecWithCode on m5 to sync with Git. "Compare all files…" works now.',
        "not-found": "m5 does not have this project.",
        "not-git": 'The project folder on m5 is not a Git repository. Use "Compare all files…".',
        failed: "m5 could not sync: The project folder is on a drive that is not connected.",
        unreadable:
          "m5 answered in a way this version does not read. Update SpecWithCode on this machine, then check again.",
      };
      for (const [kind, line] of Object.entries(failures)) {
        page = await at(`case=dialog&state=${kind}`);
        await waitStage(page, "failed");
        assert.equal(await page.locator(`[data-sync-failure="${kind}"]`).textContent(), line);
        assert.ok(
          (await page.locator("[data-sync-failures]").textContent()).includes(
            "Nothing was moved or sent.",
          ),
        );
        // A failure is an alert, and the title holds the focus.
        assert.ok((await page.locator(`${DIALOG} [role="alert"]`).count()) > 0);
        assert.equal(
          await page.evaluate(() => document.activeElement?.parentElement?.tagName),
          "H2",
          `focus after ${kind}`,
        );
        assert.equal(await page.locator("[data-sync-run]").count(), 0);
        assert.equal(await page.locator("[data-sync-compare]").isDisabled(), false);
        assert.equal(
          (await events(page)).some((call) => call.startsWith("run:")),
          false,
        );
        taken = await shot(page, `failed-${kind}-${tag}`);
        results.push({ theme, width, case: `failed: ${kind}`, ...taken });
        await page.close();
      }

      // 9. A machine whose extras could not be listed still syncs through Git.
      page = await at("case=dialog&state=inventory-failed");
      await waitStage(page, "plan");
      assert.ok(
        (await page.locator('[data-sync-extras="b"]').textContent()).includes(
          "Work that is only on m5 could not be listed.",
        ),
      );
      assert.equal(await page.locator("[data-sync-run]").isDisabled(), false);
      await page.locator('[data-sync-extras="b"]').scrollIntoViewIfNeeded();
      taken = await shot(page, `plan-extras-not-listed-${tag}`);
      results.push({ theme, width, case: "plan, extras not listed", ...taken });
      await page.close();

      // 10. A folder past the scan limits: only its top repository, and it says so.
      page = await at("case=dialog&state=scan-limited");
      await waitStage(page, "plan");
      assert.ok(
        (await page.locator(DIALOG).textContent()).includes(
          "Only the top repository of m5 is listed",
        ),
      );
      taken = await shot(page, `plan-scan-limited-${tag}`);
      results.push({ theme, width, case: "plan, scan limited", ...taken });
      await page.close();

      // 11. Git refuses on one machine and the other does not run: each says so.
      page = await at("case=dialog&state=run-refused");
      await waitStage(page, "plan");
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      assert.ok(
        (await page.locator(DIALOG).textContent()).includes(
          "m4 did not finish its part of the sync.",
        ),
      );
      // m4 gave no answer: its rows say so, and never "Not done".
      assert.equal(
        (await said(page, "apps/web", "a")).sentence,
        'No answer came for this repository, and it may have moved. "Check again" shows where it stands',
      );
      assert.equal(
        await page.locator("[data-sync-live]").textContent(),
        "Sync ended, and not everything was moved or sent. Each repository says why.",
      );
      assert.equal(await page.locator("h2").textContent(), "Sync Atlas: m4 and m5");
      const refused = await page.locator('[data-sync-cell][data-tone="failed"]').count();
      assert.ok(refused > 0, "no refused step is shown");
      taken = await shot(page, `result-refused-${tag}`);
      const wholeRefused = await longShot(page, `result-refused-whole-${tag}`);
      results.push({ theme, width, case: "result, refused", ...taken, whole: wholeRefused });
      await page.close();

      // 11b. Upstreams Sync does not move to. The plan says which it is; the run finds a
      // branch gone, an origin it could not ask, and a clone's leftover folder.
      page = await at("case=dialog&state=upstream");
      await waitStage(page, "plan");
      for (const [repo, sentence] of Object.entries(UPSTREAM_PLAN))
        assert.equal((await said(page, repo, "a")).sentence, sentence, `${repo} on m4`);
      assert.equal(await cell(page, "apps/web", "a").locator("[data-sync-detail]").count(), 0);
      assert.equal(await cell(page, "apps/api", "a").locator("[data-sync-detail]").count(), 0);
      taken = await shot(page, `plan-upstream-${tag}`);
      const wholeUpstream = await longShot(page, `plan-upstream-whole-${tag}`);
      results.push({ theme, width, case: "plan, upstreams", ...taken, whole: wholeUpstream });
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      for (const [repo, sentence] of Object.entries(UPSTREAM_RESULT))
        assert.equal((await said(page, repo, "a")).sentence, sentence, `${repo} on m4, result`);
      assert.equal(
        await cell(page, "tools/cli", "a").locator("[data-sync-detail]").textContent(),
        "Its state could not be read, so it was not moved.",
      );
      assert.deepEqual(await texts(page, "[data-sync-leftover]"), [
        "m4: A clone that was stopped left .apps-site.clone-7f3a behind, and it could not be removed",
      ]);
      taken = await shot(page, `result-upstream-${tag}`);
      const wholeUpstreamResult = await longShot(page, `result-upstream-whole-${tag}`);
      results.push({
        theme,
        width,
        case: "result, upstreams",
        ...taken,
        whole: wholeUpstreamResult,
      });
      await page.close();

      // 12. The extras could not be sent: Git still moved, and the extras say why.
      page = await at("case=dialog&state=extras-failed");
      await waitStage(page, "plan");
      await tick(page, "a", "not-pushed");
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      const notSent = page.locator('[data-sync-extra-results="a"]');
      assert.ok((await notSent.textContent()).includes("The extras from m4 were not sent."));
      assert.deepEqual(
        await notSent
          .locator("[data-sync-extra-result]")
          .evaluateAll((items) => items.map((item) => item.dataset.syncExtraResult)),
        ["not-sent"],
      );
      await notSent.scrollIntoViewIfNeeded();
      taken = await shot(page, `result-extras-not-sent-${tag}`);
      results.push({ theme, width, case: "result, extras not sent", ...taken });
      await page.close();

      // 12a. The extras were sent and the answer could not be read: neither sent nor failed.
      page = await at("case=dialog&state=extras-unknown");
      await waitStage(page, "plan");
      await tick(page, "a", "not-pushed");
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      const unknown = page.locator('[data-sync-extra-results="a"]');
      assert.equal(
        await unknown.locator("[data-sync-extras-outcome]").textContent(),
        "m4 sent extras and no answer came back. They may have arrived: check m5 before sending again.",
      );
      assert.ok(!(await unknown.textContent()).includes("were not sent"));
      assert.deepEqual(
        await unknown
          .locator("[data-sync-extra-result]")
          .evaluateAll((items) => items.map((item) => item.dataset.syncExtraResult)),
        ["unknown"],
      );
      assert.ok(
        (await unknown.locator('[data-sync-extra-result="unknown"]').textContent()).includes(
          "No answer came back. It may have arrived on m5: check m5 before sending again.",
        ),
      );
      assert.equal(
        await page.locator("[data-sync-live]").textContent(),
        "Sync ended, and not every answer came back. Each line says what to check.",
      );
      await unknown.scrollIntoViewIfNeeded();
      taken = await shot(page, `result-extras-unknown-${tag}`);
      results.push({ theme, width, case: "result, extras with no answer", ...taken });
      await page.close();

      // 12c. The window loses its grant on m5 while the plan is on screen: the plan goes.
      page = await at("case=dialog&state=small");
      await waitStage(page, "plan");
      assert.equal(await page.locator("[data-sync-run]").isDisabled(), false);
      await page.evaluate(() => window.loseGrant());
      await waitStage(page, "failed");
      assert.equal(
        await page.locator('[data-sync-failure="blocked"]').textContent(),
        "This window can only read m5",
      );
      assert.equal(await page.locator("[data-sync-run]").count(), 0);
      assert.ok(!(await events(page)).some((event) => event.startsWith("run:")));
      taken = await shot(page, `plan-grant-lost-${tag}`);
      results.push({ theme, width, case: "plan, grant lost", ...taken });
      await page.close();

      // 12d. Every step is done and m5 ended on another branch: finished, never "in sync".
      page = await at("case=dialog&state=diverged");
      await waitStage(page, "plan");
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      assert.equal(await page.locator("h2").textContent(), "Sync finished for Atlas: m4 and m5");
      taken = await shot(page, `result-not-proven-${tag}`);
      results.push({ theme, width, case: "result, not proven in sync", ...taken });
      await page.close();

      // 12b. A machine in the middle of work: 179 uncommitted files and 11 branches only there.
      page = await at("case=dialog&state=long");
      await waitStage(page, "plan");
      const long = await texts(page, '[data-sync-extras="a"] [data-sync-extra] label');
      assert.ok(
        long.some((line) => line.startsWith("11 branches that exist only on m4")),
        long.join(" | "),
      );
      assert.ok(
        long.some((line) => line.startsWith("179 uncommitted files in Atlas")),
        long.join(" | "),
      );
      // The check note stands wherever uncommitted files can be ticked.
      assert.ok(
        (
          await page.locator('[data-sync-extras="a"] [data-sync-check-note]').textContent()
        ).includes("Checked by file name, and untracked files by their first 64 KB."),
      );
      // "Send anyway" is off until the files are ticked, says why, and reads "Will be sent"
      // only while they are.
      const longAnyway = page.locator('[data-sync-left-out="content"] [data-sync-send-anyway]');
      assert.equal(await longAnyway.isDisabled(), true);
      assert.equal(
        await longAnyway.getAttribute("title"),
        "Tick the uncommitted files of Atlas first.",
      );
      await tick(page, "a", "uncommitted");
      await longAnyway.click();
      assert.equal(await longAnyway.textContent(), "Will be sent");
      await tick(page, "a", "uncommitted");
      assert.equal(await longAnyway.textContent(), "Send anyway");
      await page.locator('[data-sync-extras="a"]').scrollIntoViewIfNeeded();
      taken = await shot(page, `plan-long-${tag}`);
      const wholeLong = await longShot(page, `plan-long-whole-${tag}`);
      // Nothing was moved, and work is still listed on m4: finished, never "in sync".
      await tick(page, "a", "only-here");
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      assert.equal(await page.locator("h2").textContent(), "Sync finished for Atlas: m4 and m5");
      const wholeLongResult = await longShot(page, `result-long-whole-${tag}`);
      results.push({
        theme,
        width,
        case: "plan and result, 179 files and 11 branches",
        ...taken,
        whole: wholeLong,
        result: wholeLongResult,
        long,
      });
      await page.close();

      // 13. The machine menu on m4's page: one sync fact per row, "Sync…" and "Add…".
      page = await open(`theme=${theme}&case=menu`, width, 820);
      await page.locator("[data-coordinator-machine]").click();
      await page.locator('[role="menu"]').waitFor();
      await page.waitForTimeout(250);
      assert.deepEqual(await events(page), ["menu:open"]);
      const facts = await page.locator('[role="menuitemradio"]').evaluateAll((items) =>
        items.map((item) => ({
          machine: item.getAttribute("data-orchestrator-view")?.split(":")[0],
          tone: item.querySelector("[data-row-sync]")?.getAttribute("data-row-sync") ?? null,
          fact: item.querySelector("[data-row-sync]")?.textContent ?? null,
          notes: [...item.querySelectorAll("[data-row-note]")].map((note) => note.textContent),
        })),
      );
      const fact = (name) => facts.find((row) => row.machine === name);
      // The machine shown is what the others are compared with: no fact of its own.
      assert.equal(fact("m4").fact, null);
      assert.deepEqual([fact("m5").tone, fact("m5").fact], ["same", "Same as m4"]);
      assert.deepEqual(
        [fact("m1").tone, fact("m1").fact],
        ["differs", "2 of 5 repositories differ"],
      );
      assert.equal(fact("linux-mini").tone, "differs");
      assert.match(fact("linux-mini").fact, /^1 of 5 repositories differ · as of /);
      assert.deepEqual(fact("linux-mini").notes, ["Offline · last seen 25m ago"]);
      // From before Sync: its note, and no guess about its files.
      assert.deepEqual([fact("m3").tone, fact("m3").fact], ["unknown", "Not checked yet"]);
      assert.deepEqual(fact("m3").notes, ["Needs update · 1.4.2"]);
      assert.deepEqual([fact("m2").tone, fact("m2").fact], ["unknown", "Not checked yet"]);
      const items = await texts(page, '[role="menuitem"]');
      for (const item of [
        "Sync…",
        "Add to another machine…",
        "Move running threads…",
        "Leave this machine…",
      ])
        assert.ok(items.includes(item), `menu item ${item}: ${items.join(" | ")}`);
      assert.ok(!items.some((item) => item.includes("Send to another machine")));
      taken = await shot(page, `menu-sync-facts-${tag}`, '[role="menu"]');
      await page.locator('[data-machine-action="sync"]').click();
      await page.locator('[role="menu"]').waitFor({ state: "detached" });
      await page.waitForTimeout(100);
      assert.ok((await events(page)).includes("sync"));
      await page.locator("[data-coordinator-machine]").click();
      await page.locator('[role="menu"]').waitFor();
      await page.locator('[data-machine-action="add"]').click();
      await page.locator('[role="menu"]').waitFor({ state: "detached" });
      await page.waitForTimeout(100);
      assert.ok((await events(page)).includes("add"));
      results.push({ theme, width, case: "menu, sync facts", ...taken, facts });
      await page.close();

      // "Sync…" greyed with its reason; pressing it does nothing.
      page = await open(`theme=${theme}&case=menu&blocked=1`, width, 820);
      await page.locator("[data-coordinator-machine]").click();
      await page.locator('[role="menu"]').waitFor();
      await page.waitForTimeout(250);
      const sync = page.locator('[data-machine-action="sync"]');
      assert.equal(await sync.getAttribute("aria-disabled"), "true");
      assert.equal(
        await page.locator("[data-sync-blocked]").textContent(),
        "This window can only read m4",
      );
      taken = await shot(page, `menu-sync-blocked-${tag}`, '[role="menu"]');
      await sync.click({ force: true });
      assert.equal((await events(page)).includes("sync"), false);
      results.push({ theme, width, case: "menu, Sync greyed", ...taken });
      await page.close();

      // A window that can only read, through the real menu hook: each row keeps its sync
      // fact, "Sync…" is greyed with why, nothing is added and no dialog opens.
      page = await open(`theme=${theme}&case=menu&window=read-only`, width, 820);
      await page.locator("[data-coordinator-machine]").click();
      await page.locator('[role="menu"]').waitFor();
      await page.waitForTimeout(250);
      const seen = await page
        .locator('[role="menuitemradio"]')
        .evaluateAll((items) =>
          Object.fromEntries(
            items.map((item) => [
              item.getAttribute("data-orchestrator-view")?.split(":")[0],
              item.querySelector("[data-row-sync]")?.textContent ?? null,
            ]),
          ),
        );
      assert.equal(seen.m4, null);
      assert.equal(seen.m5, "Same as m4");
      assert.equal(seen.m1, "2 of 5 repositories differ");
      assert.equal(seen.m2, "Same as m4");
      assert.match(seen["linux-mini"], /^1 of 5 repositories differ · as of /);
      assert.equal(seen.m3, "Not checked yet");
      const readOnlySync = page.locator('[data-machine-action="sync"]');
      assert.equal(await readOnlySync.getAttribute("aria-disabled"), "true");
      assert.equal(
        await page.locator("[data-sync-blocked]").textContent(),
        "This window can only read m4",
      );
      assert.equal(await page.locator('[data-machine-action="add"]').count(), 0);
      taken = await shot(page, `menu-read-only-window-${tag}`, '[role="menu"]');
      await readOnlySync.click({ force: true });
      assert.equal((await events(page)).includes("sync"), false);
      assert.equal(
        await page.locator("[data-sync-dialog-open]").getAttribute("data-sync-dialog-open"),
        "no",
      );
      results.push({ theme, width, case: "menu, read-only window", ...taken, seen });
      await page.close();
    }
  assert.deepEqual(errors, []);

  // 14. The plan screen in each language: nothing falls back to English, nothing is cut off.
  const english = {};
  for (const lang of ["en", "ru", "es", "zh-CN", "ja", "pt-BR", "ko", "de", "fr"]) {
    const read = {};
    for (const width of lang === "en" ? [1280] : WIDTHS) {
      const page = await open(`theme=light&case=dialog&state=plan&lang=${lang}`, width);
      await waitStage(page, "plan");
      if (width === 1280) {
        read.title = await page.locator("h2").textContent();
        read.description = await page.locator('[data-slot="dialog-description"]').textContent();
        read.sentences = await texts(page, "[data-sync-sentence]");
        read.facts = await texts(page, "[data-sync-fact]");
        read.headings = await texts(page, `${DIALOG} h3`);
        read.extras = await texts(page, "[data-sync-extra]");
        read.leftOut = await texts(page, "[data-sync-left-out] span span");
        read.buttons = await texts(page, `${DIALOG} [data-slot="dialog-footer"] button`);
      }
      if (lang !== "en") {
        const taken = await longShot(page, `plan-${lang}-${width}`);
        results.push({ lang, width, case: `plan in ${lang}`, ...taken });
      }
      await page.close();
    }
    // The upstream rows and results: every sentence of theirs is translated too.
    {
      const page = await open(`theme=light&case=dialog&state=upstream&lang=${lang}`, 1280);
      await waitStage(page, "plan");
      read.upstreamPlan = await texts(page, '[data-sync-cell="a"] [data-sync-sentence]');
      await page.locator("[data-sync-run]").click();
      await waitStage(page, "result");
      read.upstreamResult = await texts(page, '[data-sync-cell="a"] [data-sync-sentence]');
      read.leftovers = await texts(page, "[data-sync-leftover]");
      if (lang !== "en") {
        const taken = await longShot(page, `result-upstream-${lang}-1280`);
        results.push({ lang, width: 1280, case: `result, upstreams in ${lang}`, ...taken });
      }
      await page.close();
    }
    if (lang === "en") {
      Object.assign(english, read);
      continue;
    }
    const misses = [];
    for (const [part, value] of Object.entries(read)) {
      const before = english[part];
      for (const [index, text] of [value].flat().entries()) {
        const was = [before].flat()[index];
        // A sentence with letters that reads the same as English was not translated.
        if (text === was && /[A-Za-z]{4}/.test(text)) misses.push(`${part}: "${text}"`);
      }
    }
    for (const miss of new Set(misses)) languageFailures.push(`${lang}: not translated: ${miss}`);
    const menu = await open(`theme=light&case=menu&lang=${lang}`, 1280, 820);
    await menu.locator("[data-coordinator-machine]").click();
    await menu.locator('[role="menu"]').waitFor();
    await menu.waitForTimeout(250);
    const taken = await shot(menu, `menu-${lang}`, '[role="menu"]');
    const rowFacts = await texts(menu, "[data-row-sync]");
    for (const text of rowFacts)
      if (/Same as|repositories differ|Not checked yet/.test(text))
        languageFailures.push(`${lang}: row fact not translated: "${text}"`);
    for (const action of ["sync", "add"]) {
      const text = await menu.locator(`[data-machine-action="${action}"]`).textContent();
      if (/^Sync…$|Add to another machine/.test(text))
        languageFailures.push(`${lang}: menu item not translated: "${text}"`);
    }
    results.push({ lang, case: `menu in ${lang}`, ...taken, rowFacts });
    await menu.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
const layout = results.flatMap((item) =>
  [item, item.whole, item.ticked]
    .filter((part) => part?.layout?.length)
    .map((part) => ({ file: part.file, problems: part.layout })),
);
await fs.writeFile(
  path.join(output, "project-sync.json"),
  JSON.stringify({ results, layout, languageFailures }, null, 2),
);
console.log(
  JSON.stringify(
    {
      shots: results.length,
      layout,
      // Every miss is in the JSON file; the first ten are enough to read here.
      languageFailures: languageFailures.slice(0, 10),
      languageFailureCount: languageFailures.length,
    },
    null,
    2,
  ),
);
if (layout.length) {
  console.error(`Clipped or overflowing text in ${layout.length} shots.`);
  process.exitCode = 1;
}
if (languageFailures.length) {
  console.error(`Eight-language loop: ${languageFailures.length} problems in the 8 catalogs.`);
  process.exitCode = 1;
}
