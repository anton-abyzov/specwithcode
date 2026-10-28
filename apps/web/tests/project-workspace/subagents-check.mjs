/* `?subagents&routed`: a worker's subagents never show as threads. The worker's row rolls
   their work into its status, its header carries one chip with a popover, and a popover
   row peeks at the subagent's transcript read-only. A `?thread=` naming a subagent lands
   on its worker with that peek open. Always headless; evidence goes to files. */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-subagents-ui";
await NodeFSP.mkdir(output, { recursive: true });
const port = Number(process.env.PROJECT_UI_PORT ?? 5788);
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE ?? undefined;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const report = [];
try {
  for (const scheme of ["dark", "light"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      colorScheme: scheme,
    });
    page.setDefaultTimeout(180_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const shot = (name) =>
      page.screenshot({ path: NodePath.join(output, `${scheme}-${name}.png`) });
    await page.goto(`http://127.0.0.1:${port}/?subagents&routed`);
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      scheme === "dark",
    );
    const list = page.getByLabel("Project threads");
    await list.locator(".sws-thread-open", { hasText: "Warn before restart" }).waitFor();
    const titles = await list.locator(".sws-thread-open strong").allInnerTexts();
    for (const hidden of [
      "Bulk thread slash command",
      "REA Claude desktop artifacts",
      "Grep the app bundle",
    ])
      NodeAssert.ok(!titles.includes(hidden), `${hidden} is not listed as a thread`);
    const row = list.locator(".sws-thread-open", { hasText: "Warn before restart" });
    NodeAssert.match(await row.innerText(), /2 subagents/);
    // Working subagents keep their thread in the Working group, not Idle.
    NodeAssert.match(await list.innerText(), /Working\s*1\b/);
    await shot("1-threads");

    await row.click();
    const chip = page.getByRole("button", { name: /3 subagents, 2 working/ });
    await chip.waitFor();
    await shot("2-worker");
    await chip.click();
    const popover = page.getByRole("list", { name: "Subagents" });
    await popover.waitFor();
    const rows = await popover.locator(".sws-subagent-title").allInnerTexts();
    NodeAssert.deepEqual(rows, [
      "REA Claude desktop artifacts",
      "Grep the app bundle",
      "Bulk thread slash command",
    ]);
    NodeAssert.match(await popover.innerText(), /postMessage bridge/);
    await page.waitForTimeout(200);
    await shot("3-popover");

    await popover.getByRole("button", { name: /REA Claude desktop artifacts/ }).click();
    const peek = page.getByRole("dialog", { name: "Subagent REA Claude desktop artifacts" });
    await peek.waitFor();
    NodeAssert.equal(await peek.locator("[data-transcript-only]").count(), 1);
    NodeAssert.equal(await peek.getByLabel("Worker reply").count(), 0, "the peek has no composer");
    NodeAssert.match(await peek.innerText(), /Subagent of Warn before restart/);
    NodeAssert.match(
      await peek.innerText(),
      /Read-only. To change this work, reply in Warn before restart/,
    );
    NodeAssert.ok(
      new URL(page.url()).searchParams.get("thread") === "warn",
      "the worker stays open",
    );
    await page.waitForTimeout(250);
    await shot("4-peek");
    await page.keyboard.press("Escape");
    await peek.waitFor({ state: "detached" });
    NodeAssert.ok(await chip.isVisible(), "Esc returns to the worker");

    // A link straight to a nested subagent opens its worker with the peek.
    await page.goto(`http://127.0.0.1:${port}/?subagents&routed&thread=grep`);
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      scheme === "dark",
    );
    await page.getByRole("dialog", { name: "Subagent Grep the app bundle" }).waitFor();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("thread") === "warn");
    await page.waitForTimeout(250);
    await shot("5-deep-link");
    NodeAssert.deepEqual(errors, []);
    report.push({ scheme, listed: titles, popover: rows, deepLink: "warn + peek grep" });
    await page.close();
  }
  await NodeFSP.writeFile(NodePath.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`subagents-check passed; evidence in ${output}`);
} finally {
  await browser.close();
}
