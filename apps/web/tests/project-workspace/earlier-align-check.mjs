// Run against serve.mjs. "Load earlier messages", the time line, the messages and the
// composer share one centered column in every coordinator layout (`?switch` keeps
// older history on the host). `EARLIER_MEASURE_ONLY=1` records instead of asserting.
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
const output = process.env.UI_EVIDENCE_DIR;
NodeAssert.ok(output, "Set UI_EVIDENCE_DIR to a new evidence directory");
const port = process.env.PROJECT_UI_PORT ?? 5788;
const measureOnly = process.env.EARLIER_MEASURE_ONLY === "1";
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const layouts = [
  ["wide-overview-closed", { width: 1440, height: 900 }, "closed", null],
  ["wide-overview-open", { width: 2000, height: 1080 }, "open", null],
  ["narrow-window", { width: 900, height: 800 }, "closed", null],
  ["thread-open-split", { width: 1600, height: 900 }, "open", "Review the landing page"],
  ["phone", { width: 390, height: 844 }, "closed", null],
];
const results = [];
try {
  for (const [name, viewport, overview, thread] of layouts) {
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${port}/?switch&turns`);
    await page.waitForLoadState("networkidle");
    // The `?switch` fixture puts the workspace in a flex row; the app gives it the row.
    await page.addStyleTag({ content: "nav + div > *{flex:1 1 auto;min-width:0}" });
    const conversation = page.getByLabel("Coordinator conversation");
    await conversation.waitFor();
    const toggle = page.locator(".sws-overview-toggle");
    if ((await toggle.getAttribute("aria-pressed")) !== String(overview === "open"))
      await toggle.click();
    if (thread)
      await page.locator("[data-project-pane='threads']").getByText(thread).first().click();
    await page.addStyleTag({ content: "[data-position]{display:none!important}" });
    await conversation.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(300);
    const measure = await page.evaluate(() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      };
      const conv = document.querySelector("[aria-label='Coordinator conversation']");
      const button = [...conv.querySelectorAll("button")].find((b) =>
        /earlier messages|Loading…/.test(b.textContent ?? ""),
      );
      const article = conv.querySelector(".project-message-assistant");
      const column = article ? rect(article) : null;
      return {
        conversation: rect(conv),
        button: rect(button),
        separator: rect(conv.querySelector(".sws-turn-separator time")),
        column,
        composer: rect(document.querySelector(".sws-composer-card")),
      };
    });
    const center = (r) => (r ? (r.left + r.right) / 2 : null);
    const offsets = {
      button: center(measure.button) - center(measure.column),
      separator: center(measure.separator) - center(measure.column),
      composer: center(measure.composer) - center(measure.column),
    };
    results.push({ name, viewport, overview, thread, ...measure, offsets });
    await page.screenshot({ path: NodePath.join(output, `${name}.png`) });
    if (!measureOnly) {
      NodeAssert.ok(measure.button, `${name}: Load earlier messages is shown`);
      for (const [label, offset] of Object.entries(offsets))
        NodeAssert.ok(Math.abs(offset) <= 2, `${name}: ${label} off center by ${offset}px`);
      NodeAssert.ok(
        measure.button.width < 260,
        `${name}: the button is sized to its label (${measure.button.width}px)`,
      );
    }
    await page.close();
  }
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "earlier-align.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
console.log(
  JSON.stringify(
    results.map((r) => ({ name: r.name, offsets: r.offsets, button: r.button?.width })),
    null,
    1,
  ),
);
