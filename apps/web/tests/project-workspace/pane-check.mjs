import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
await NodeFSP.mkdir(output, { recursive: true });
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE ?? undefined;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
// Arriving at a thread never shows its right panel ("Open a surface" or a tab), from
// any entry point and whatever was saved; it opens only when asked for.
const STORAGE_KEY = "studio:right-panel-state:v2";
const diff = { id: "diff", kind: "diff" };
const saved = (version, byThreadKey) =>
  JSON.stringify({ state: { byThreadKey, threadPanelVisibilityByThreadKey: {} }, version });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const steps = [];
  const panel = page.getByLabel("Thread right panel", { exact: true });
  const panelText = async () => ((await panel.count()) === 0 ? null : await panel.innerText());
  const onThread = (id) =>
    page.getByText(`Native thread fixture · ${id}`, { exact: true }).waitFor();
  const expectClosed = async (step, id) => {
    await onThread(id);
    // Let a late effect or a store load run before reading the panel.
    await page.waitForTimeout(150);
    NodeAssert.equal(await panelText(), null, `${step}: the right panel stays closed on ${id}`);
    steps.push({ step, thread: id, panel: "closed" });
    await page.screenshot({ path: NodePath.join(output, `pane-${steps.length}-${id}.png`) });
  };
  const expectPanel = async (step, text) => {
    await panel.waitFor();
    NodeAssert.equal(await panelText(), text, `${step}: the panel shows ${text}`);
    steps.push({ step, panel: text });
  };
  // The Threads list, reached from an open thread by its "Threads ›" breadcrumb.
  const threadsRow = async (title) => {
    const back = page.getByLabel("Back to project threads");
    if (await back.isVisible()) await back.click();
    return page.getByLabel("Project threads").locator(".sws-thread-open", { hasText: title });
  };
  const conversation = page.getByLabel("Coordinator conversation");

  // Panels an earlier version saved open: an empty launcher and a Changes tab.
  await page.goto("http://127.0.0.1:5788/?routed");
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [
      STORAGE_KEY,
      saved(14, {
        "host:idle": { isOpen: true, activeSurfaceId: null, surfaces: [] },
        "host:review": { isOpen: true, activeSurfaceId: "diff", surfaces: [diff] },
        "host:skills": { isOpen: true, activeSurfaceId: null, surfaces: [] },
      }),
    ],
  );

  // A link or reload straight onto the thread.
  await page.goto("http://127.0.0.1:5788/?routed&thread=idle");
  await page.waitForLoadState("networkidle");
  await expectClosed("URL load of a thread saved with an open launcher", "idle");
  const migrated = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY));
  NodeAssert.equal(migrated.version, 15, "saved panels are migrated once");
  NodeAssert.deepEqual(
    migrated.state.byThreadKey,
    { "host:review": { isOpen: false, activeSurfaceId: "diff", surfaces: [diff] } },
    "migration saves panels closed and drops empty launchers",
  );

  // The Threads list.
  await (await threadsRow("Review the landing page")).click();
  await expectClosed("Threads list row, thread saved with a Changes tab", "review");
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expectPanel("one toggle brings the remembered tab back", "Tab diff");

  // Leave with the panel open, then come back through each other entry point.
  await (await threadsRow("Polish onboarding")).click();
  await expectClosed("Threads list row after leaving a thread with its panel open", "idle");
  await conversation
    .getByRole("button", { name: /^Open thread Review the landing page, / })
    .click();
  await expectClosed("coordinator chip back to the thread left open", "review");
  await conversation.getByRole("button", { name: "View thread Consolidate the skills" }).click();
  await expectClosed("View thread card", "skills");

  // An explicit toggle shows the launcher; it does not come back after a reload.
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expectPanel("toggle on a thread with no tabs shows the launcher", "Open a surface");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expectClosed("reload with the launcher open", "skills");

  // Back and forward.
  await page.getByRole("button", { name: "Open changes" }).click();
  await expectPanel("opening a surface shows it", "Tab diff");
  await page.goBack();
  await expectClosed("Back", "review");
  await page.goForward();
  await expectClosed("Forward to the thread left with Changes open", "skills");

  // Closing the thread pane and opening the thread again from the Threads list.
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expectPanel("toggle again", "Tab diff");
  await page.getByLabel("Close thread pane").click();
  await page.locator(".sws-overview-toggle").click();
  await (await threadsRow("Consolidate the skills")).click();
  await expectClosed("Threads list row after closing the thread pane", "skills");

  // A browser whose session ends takes the panel with it instead of leaving the launcher.
  await (await threadsRow("Record the tutorials")).click();
  // The fixture gives this worker a real delegated-task ID, `%3A` included (mocks.tsx).
  await expectClosed(
    "Threads list row, fresh thread",
    "thread:delegated-task:command%3Amcp%3Afixture-0001%3Adelegate-task%3Arecord-tutorials",
  );
  await page.getByRole("button", { name: "Open browser" }).click();
  await expectPanel("opening a browser", "Tab preview");
  await page.getByRole("button", { name: "End browser session" }).click();
  await page.waitForTimeout(150);
  NodeAssert.equal(await panelText(), null, "an ended browser session closes its empty panel");
  steps.push({ step: "browser session ends", panel: "closed" });

  // Data already at the current version never restores an open panel either.
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [
      STORAGE_KEY,
      saved(15, { "host:review": { isOpen: true, activeSurfaceId: "diff", surfaces: [diff] } }),
    ],
  );
  await page.goto("http://127.0.0.1:5788/?routed&thread=review");
  await page.waitForLoadState("networkidle");
  await expectClosed("URL load of current-version data saved open", "review");

  // The narrow layout, where the native panel would be a sheet over the thread.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expectClosed("narrow layout reload", "review");

  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(NodePath.join(output, "pane-check.json"), JSON.stringify(steps, null, 2));
  console.log(`right pane check passed (${steps.length} steps); evidence in ${output}`);
} finally {
  await browser.close();
}
