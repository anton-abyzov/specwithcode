// A message typed in a worker goes to that worker, not the coordinator, and older
// follow-ups the coordinator only passed back to their own worker are left out of
// its conversation (`?followups`). One it moved elsewhere still shows, with its reply.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output =
  process.env.UI_EVIDENCE_DIR ?? process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
const port = Number(process.env.PROJECT_UI_PORT ?? 5788);
await NodeFSP.mkdir(output, { recursive: true });
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE ?? undefined;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const results = [];
try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      colorScheme: scheme,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?followups`);
    await page.waitForLoadState("networkidle");
    const conversation = page.getByLabel("Coordinator conversation");
    await conversation.getByText("Also rebuild the project memory index.").waitFor();
    const text = await conversation.innerText();
    NodeAssert.ok(
      !text.includes("marquee promo?"),
      "a follow-up sent back to its worker is left out",
    );
    NodeAssert.ok(!text.includes("I passed your"), "and so is the coordinator's reply to it");
    NodeAssert.ok(
      text.includes("Moved to"),
      "a follow-up moved elsewhere keeps its one-line reply",
    );
    await page.screenshot({ path: NodePath.join(output, `followups-coordinator-${scheme}.png`) });

    await page.goto(`http://127.0.0.1:${port}/?followups&routed&thread=review`);
    await page.waitForLoadState("networkidle");
    await page.getByText("Native thread fixture · review", { exact: true }).waitFor();
    const reply = page.getByLabel("Worker reply");
    await reply.fill("marquee promo?");
    const before = await page.evaluate(() => window.__projectCalls.length);
    await page.getByRole("button", { name: "Send worker reply" }).click();
    await page.waitForTimeout(300);
    const sends = await page.evaluate(
      (from) => window.__projectCalls.slice(from).filter((c) => c.command === "send"),
      before,
    );
    NodeAssert.deepEqual(sends, [], "a worker reply never starts a coordinator turn");
    const notice = await page.locator("body").innerText();
    NodeAssert.ok(!notice.includes("Sent to the coordinator"), "no coordinator notice");
    NodeAssert.ok(!notice.includes("via coordinator"), "no via-coordinator marker");
    await page.screenshot({ path: NodePath.join(output, `followups-worker-${scheme}.png`) });
    NodeAssert.deepEqual(errors, []);
    results.push({ scheme, hiddenSameWorker: true, movedShown: true, coordinatorSends: 0 });
    await page.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "followups.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
