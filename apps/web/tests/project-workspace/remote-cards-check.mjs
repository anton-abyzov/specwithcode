// Run against serve.mjs. Workers the coordinator started on another machine sit under
// the reply of the turn that started them (`?turns&remote`), never in a stack under the
// newest message. REMOTE_MEASURE_ONLY=1 records the order instead of asserting, for a
// before capture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR ?? process.env.PROJECT_UI_OUTPUT;
NodeAssert.ok(output, "Set UI_EVIDENCE_DIR to an evidence directory");
const port = process.env.PROJECT_UI_PORT ?? 5788;
const measureOnly = process.env.REMOTE_MEASURE_ONLY === "1";
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const receipt = {};
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${port}/?turns&remote`);
    await page.waitForLoadState("networkidle");
    await page.locator("[data-remote-worker]").first().waitFor({ state: "attached" });
    await page.waitForTimeout(500);
    // Document order of the messages and cards the conversation shows.
    // Only the conversation: the Threads pane lists the same workers on its own.
    const order = await page.evaluate(() => {
      let scope = document.querySelector('[data-follow-anchor="t1"]');
      while (scope && !scope.querySelector('[data-follow-anchor="t4"]'))
        scope = scope.parentElement;
      return [
        ...(scope ?? document).querySelectorAll("[data-remote-worker], [data-follow-anchor]"),
      ].map((el) => el.getAttribute("data-remote-worker") ?? el.getAttribute("data-follow-anchor"));
    });
    await page
      .locator('[data-follow-anchor="t2"]')
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    receipt[name] = order;
    await page.screenshot({
      path: NodePath.join(output, `remote-cards-${name}.png`),
      fullPage: true,
    });
    if (!measureOnly) {
      const at = (id) => order.indexOf(id);
      NodeAssert.ok(at("t2") >= 0 && at("t3") >= 0, `messages present: ${order.join(", ")}`);
      for (const card of ["rwt:os", "rwt:proof"]) {
        NodeAssert.ok(
          at(card) > at("t2") && at(card) < at("t3"),
          `${card} under its turn: ${order}`,
        );
      }
      NodeAssert.ok(at("rwt:os") < at("rwt:proof"), "launch order kept");
      NodeAssert.ok(at("rwt:live") > at("t4"), `live worker after the current reply: ${order}`);
    }
    await page.close();
  }
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "remote-cards.json"),
    JSON.stringify(receipt, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(receipt));
