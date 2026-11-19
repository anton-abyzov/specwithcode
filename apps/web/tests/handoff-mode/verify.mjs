// Headless screenshots of the handoff mode badges, dialogs and settings (0967 AC-12).
// Build first: vp build --config apps/web/tests/handoff-mode/vite.config.ts
// Usage: node apps/web/tests/handoff-mode/verify.mjs /absolute/report-dir
// Playwright comes from STUDIO_PLAYWRIGHT_MODULE (an installed playwright-core entry).
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/handoff-mode/site");
// Evidence goes outside the repository: the folder passed, else a new temporary one.
const output = process.argv[2]
  ? NodePath.resolve(process.argv[2])
  : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-mode-evidence-"));
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) return void res.writeHead(403).end();
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
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
const errors = [];
const shots = [];
// AC-21 results not on main yet. When each PR lands, add its case to progressCases.ts and
// drop it from here; the receipt lists what is still missing.
const PENDING_CASES = [
  {
    result:
      "The coordinator was refused in step 3: threads held, Hand off without the coordinator or Cancel",
    pr: "#717",
  },
  {
    result:
      "The window closed in steps 1 to 3: the session card with Continue the hand off and Resume them here",
    pr: "#717",
  },
  {
    result: "Folder work could not be put into the working folder: it is a branch on the target",
    pr: "#717",
  },
  { result: "A routine was refused or got no answer: Try the routines again", pr: "#717" },
  {
    result: "The coordinator row greyed: Stays while {n} threads keep working or waiting",
    pr: "#717",
  },
  {
    result: "Continue it on {source} offered only after the target answered it did not continue",
    pr: "#717",
  },
  { result: "Idle threads listed in the Hand off dialog (AC-17)", pr: "T-12 finding 5" },
  { result: "Per-provider usage in the Hand off dialog (AC-22)", pr: "T-12 finding 6" },
];
const cases = [
  ["badges", "M3 is offline"],
  ["thread-check", "Minis: no .env.local"],
  ["thread-done", "continues on Minis."],
  ["thread-switch", "Switch and continue"],
  ["machine", "Minis: no .env.local"],
  ["machine-done", "Open on Minis"],
  // 0969 AC-10: the machine menu scopes the dialog to one project.
  ["migrate", "Scope: atlas"],
  ["resume", "Resume all threads on this machine?"],
  // 1121: one machine default; projects are set on their own page.
  ["settings", "Keep threads ready to move"],
  ["settings-overrides", "Old app (archived): Off"],
  ["project", "Keep this project's threads ready to move"],
];
try {
  const page = await browser.newPage({ reducedMotion: "reduce", deviceScaleFactor: 2 });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const [view, text] of cases) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: 900, height: 720 });
      await page.goto(`${origin}/?view=${view}&theme=${theme}`);
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(150);
      const path = NodePath.join(output, `${view}-${theme}.png`);
      await page.screenshot({ path });
      shots.push(path);
    }
  }
  // A failed check keeps the thread here: Hand off stays disabled until the checks pass.
  await page.goto(`${origin}/?view=thread-check`);
  NodeAssert.equal(
    await page.getByRole("button", { name: "Hand off to Minis" }).isDisabled(),
    true,
  );
  await page.goto(`${origin}/?view=thread-ready`);
  NodeAssert.equal(
    await page.getByRole("button", { name: "Hand off to Minis" }).isDisabled(),
    false,
  );
  // No per-project list, no automated or archived groups, no inert auto-continue row.
  await page.goto(`${origin}/?view=settings`);
  await page.getByText("Keep threads ready to move").first().waitFor();
  for (const gone of ["Show automated", "Show archived", "Continue automatically"])
    NodeAssert.equal(await page.getByText(gone).count(), 0, gone);
  // The handoff banner with its history open stops at 40% of the coordinator column and
  // scrolls inside; the conversation keeps the rest, starting below the banner.
  for (const [width, height] of [
    [1280, 800],
    [375, 812],
  ]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?view=coordinator-banner&theme=${theme}`);
      await page.getByText("First message on Minis").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(150);
      const box = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        const banner = document.querySelector('[data-slot="handoff-history"]');
        return {
          column: rect('[data-testid="coordinator"]').height,
          banner: rect('[data-slot="handoff-history"]'),
          conversation: rect('[data-testid="conversation"]'),
          scrolls: banner.scrollHeight > banner.clientHeight,
        };
      });
      NodeAssert.ok(box.banner.height <= box.column * 0.4 + 1, `banner ${JSON.stringify(box)}`);
      NodeAssert.ok(box.scrolls, "the open history scrolls inside the banner");
      NodeAssert.ok(box.conversation.top >= box.banner.bottom, "conversation starts below it");
      NodeAssert.ok(box.conversation.height >= box.column * 0.5, "conversation keeps the rest");
      const path = NodePath.join(output, `coordinator-banner-${theme}-${width}x${height}.png`);
      await page.screenshot({ path });
      shots.push(path);
    }
  }
  // 1390 AC-21, AC-31: the Hand off dialog's progress, one case per partial result, light and
  // dark at 1280 and 390 px. The cases and the "Stays" reasons come from the fixture page,
  // which reads them from the server source; each must render on its row.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/?view=cases`);
  const index = JSON.parse(await page.locator("#cases").textContent());
  // The source parse must keep finding the runner's reasons: a refactor that hides them fails.
  const reasonNames = index.stays.map((reason) => reason.name);
  const STAYS_NAMES = [
    "TURN_DID_NOT_STOP",
    "UNSENT_TOO_OLD",
    "RESUMED_HERE",
    "NO_MACHINE_ACCEPTED",
    "NOT_RECORDED",
    "ARRIVED_FOR_THIS_RUN",
    "BATCH_CUT",
    "AUTOMATIC_OFF",
    "AUTOMATIC_RUN_CHANGED",
    "AUTOMATIC_DISPOSITION_CHANGED",
    "LEGACY_HOLD_WAITS",
    "FOLLOW_NOT_RECORDED",
    "UNSETTLED_CHILD_REFUSAL",
  ];
  for (const name of STAYS_NAMES)
    NodeAssert.ok(reasonNames.includes(name), `Stays reason ${name} is not read from the server`);
  // The rendered stays case has exactly one row per literal name above, by its title.
  await page.goto(`${origin}/?view=handoff-progress&case=stays`);
  await page.locator('[data-slot="hand-off-progress"]').waitFor({ timeout: 10_000 });
  for (const name of STAYS_NAMES)
    NodeAssert.equal(
      await page
        .locator("li[data-row-state]")
        .filter({ has: page.getByText(`Stays: ${name}`, { exact: true }) })
        .count(),
      1,
      `the stays case renders one row for ${name}`,
    );
  const progressResults = [];
  for (const entry of index.cases) {
    for (const theme of ["light", "dark"]) {
      for (const width of [1280, 390]) {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        await page.goto(`${origin}/?view=handoff-progress&case=${entry.key}&theme=${theme}`);
        await page.locator('[data-slot="hand-off-progress"]').waitFor({ timeout: 10_000 });
        const items = page.locator("li[data-row-state]");
        NodeAssert.equal(await items.count(), entry.rows.length, `${entry.key}: row count`);
        for (const [n, row] of entry.rows.entries()) {
          const item = items.nth(n);
          NodeAssert.equal(await item.getAttribute("data-row-state"), row.state, row.title);
          const text = await item.innerText();
          NodeAssert.ok(text.includes(row.title), `${entry.key}: ${row.title} is shown`);
          // The reason, exactly, or none at all.
          const reason = item.locator('[data-slot="hand-off-row-reason"]');
          if (row.reason === null)
            NodeAssert.equal(await reason.count(), 0, `${entry.key}: ${row.title} has no reason`);
          else
            NodeAssert.equal(
              (await reason.innerText()).trim(),
              row.reason,
              `${entry.key}: the reason of ${row.title}`,
            );
          // The next step: a real button with that accessible name, the word Wait, or nothing.
          const buttons = item.getByRole("button");
          if (row.control === null || row.control === "Wait")
            NodeAssert.equal(await buttons.count(), 0, `${row.title}: no control`);
          else {
            NodeAssert.equal(await buttons.count(), 1, `${row.title}: one control`);
            NodeAssert.equal(
              await item.getByRole("button", { name: row.control, exact: true }).count(),
              1,
              `${row.title}: the ${row.control} button`,
            );
          }
          if (row.control === "Wait")
            NodeAssert.equal(
              await item.getByText("Wait", { exact: true }).count(),
              1,
              `${row.title}: Wait`,
            );
        }
        if (entry.key === "track-out") {
          await page.getByText("Complex track is out on every machine").waitFor();
          await page.getByText("3 threads stay on M4. Nothing moves.").waitFor();
          await page.getByText("Next reset: Minis at 8:00 PM").waitFor();
        }
        if (entry.key === "track-out-unknown") {
          await page.getByText("1 thread stays on M4. Nothing moves.").waitFor();
          await page.getByText("Reset unknown").waitFor();
        }
        if (entry.key === "release-refused")
          await page
            .getByText("It is being sent now, so it was not released. Nothing changed.")
            .waitFor();
        if (entry.key === "partial")
          await page.getByRole("alert").getByText("Minis stopped answering").waitFor();
        await page.waitForTimeout(150);
        const path = NodePath.join(output, `handoff-progress-${entry.key}-${theme}-${width}.png`);
        await page.screenshot({ path, fullPage: true });
        // No row's text runs out of the dialog at 390 px.
        const overflow = await page.evaluate(() => {
          const popup = document
            .querySelector('[data-slot="dialog-popup"]')
            .getBoundingClientRect();
          return [...document.querySelectorAll("li[data-row-state] *")]
            .map((node) => node.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.right > popup.right + 1).length;
        });
        NodeAssert.equal(overflow, 0, `${entry.key} at ${width}: nothing past the dialog edge`);
        shots.push(path);
        progressResults.push({ case: entry.key, theme, width, rows: entry.rows.length });
      }
    }
  }
  // Before Hand off: each preflight check that keeps a thread here, with its own words.
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await page.goto(`${origin}/?view=handoff-check&theme=${theme}`);
      await page.getByText("Stays: version").waitFor({ timeout: 10_000 });
      NodeAssert.equal(await page.locator('[data-thread-status="failed"]').count(), 8);
      NodeAssert.equal(await page.locator('[data-thread-status="ready"]').count(), 1);
      for (const check of [
        "checkpoint",
        "ignored-files",
        "grant",
        "provider",
        "model",
        "project-link",
        "lease",
        "version",
      ])
        NodeAssert.equal(await page.locator(`li[data-check="${check}"]`).count(), 1, check);
      // Only the thread that passed goes: Hand off stays enabled for it.
      NodeAssert.equal(
        await page.getByRole("button", { name: "Hand off to Minis" }).isDisabled(),
        false,
      );
      const path = NodePath.join(output, `handoff-check-${theme}-${width}.png`);
      await page.screenshot({ path, fullPage: true });
      shots.push(path);
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "handoff-progress.json"),
    `${JSON.stringify({ cases: progressResults, stays: index.stays, pending: PENDING_CASES }, null, 2)}\n`,
  );
  NodeAssert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  `${JSON.stringify({ headless: true, shots: shots.map((shot) => NodePath.basename(shot)), errors }, null, 2)}\n`,
);
console.log(shots.join("\n"));
