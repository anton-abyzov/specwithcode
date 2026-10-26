// Worker messages in the coordinator at each timeline detail level (`?agent-messages`,
// 1068): the screenshot-shaped receipt folds to its opening, sooner in Concise, and
// Verbose opens it. MEASURE_ONLY=1 records what a build shows, for a before capture.
// Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR;
NodeAssert.ok(output, "Use a new explicit evidence directory");
await NodeFSP.mkdir(output, { recursive: false });
const measureOnly = process.env.MEASURE_ONLY === "1";
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const VIEWS = [
  { name: "1280", viewport: { width: 1280, height: 900 } },
  { name: "360", viewport: { width: 360, height: 780 } },
];
const errors = [];
const results = [];

async function choose(page, name) {
  await page.locator("[data-timeline-detail]").click();
  // The coordinator's own level, not the default for every thread.
  await page
    .getByLabel("This thread")
    .getByRole("menuitemradio", { name: new RegExp(`^${name}`) })
    .click();
  await page.waitForFunction(
    (level) => document.querySelector("[data-timeline-detail]")?.dataset.timelineDetail === level,
    name.toLowerCase(),
  );
}

async function measure(article) {
  return article.evaluate((node) => {
    const fold = node.querySelector("[data-worker-message]");
    const toggle = node.querySelector('button[aria-label*="Show full message"]');
    const relay = node.querySelector("[data-relayed-message]");
    const spill = [node, ...node.querySelectorAll("*")].filter(
      (element) =>
        element.scrollWidth > element.clientWidth + 1 &&
        getComputedStyle(element).overflowX === "visible",
    ).length;
    return {
      height: Math.round(node.getBoundingClientRect().height),
      text: node.innerText,
      workerMessage: fold?.getAttribute("data-worker-message") ?? null,
      toggle: toggle?.getAttribute("aria-label") ?? null,
      sentBy: node.innerText.includes("Sent by"),
      relayed: relay?.getAttribute("data-relayed-message") ?? null,
      header: relay?.querySelector("h3")?.innerText ?? null,
      view: relay?.querySelector("[data-slot=inline-button]")?.innerText ?? null,
      bubble: getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)",
      spill,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

try {
  for (const view of VIEWS) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: view.viewport,
        colorScheme: theme,
        reducedMotion: "reduce",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${view.name}-${theme}: ${error.message}`));
      await page.goto(`${origin}/?agent-messages`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      const texts = await page.evaluate(() => window.agentMessageTexts);
      const conversation = page.getByLabel("Coordinator conversation");
      await conversation.waitFor();
      const worker = (start) =>
        conversation.locator("article.project-message").filter({ hasText: start });
      for (const level of ["Normal", "Verbose", "Concise"]) {
        if (level !== "Normal") await choose(page, level);
        const detail = level.toLowerCase();
        const label = `${detail}-${theme}-${view.name}`;
        const report = worker("Exactspec");
        const merge = worker("Merged #509 and #186.");
        // Read from the top the way a person scrolls, so following the latest message lets go.
        await conversation.hover();
        await page.mouse.wheel(0, -5000);
        await page.waitForTimeout(300);
        await report.evaluate((node) => node.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(300);
        const result = { label, detail, theme, width: view.name, ...(await measure(report)) };
        result.merge = await measure(merge);
        await page.screenshot({ path: NodePath.join(output, `coordinator-${label}.png`) });
        const copy = report.getByRole("button", { name: "Copy original message" });
        if ((await copy.count()) > 0) {
          await copy.click();
          await report.getByRole("button", { name: "Original message copied" }).waitFor();
          result.copied =
            (await page.evaluate(() => navigator.clipboard.readText())) === texts.enospc;
          // The same message stays on the page at the next level: let its button settle back.
          await copy.waitFor();
        }
        results.push(result);
        if (measureOnly) continue;
        // A worker's message is a quiet relayed note, not a bubble, that links to its thread.
        NodeAssert.equal(result.relayed, "thread", `${label}: relayed note`);
        NodeAssert.match(result.header, /^Message from /, label);
        NodeAssert.equal(result.view, "View thread", label);
        NodeAssert.equal(result.bubble, false, `${label}: no bubble`);
        NodeAssert.equal(result.sentBy, false, `${label}: no Sent by line`);
        NodeAssert.equal(result.copied, true, `${label}: exact copy`);
        NodeAssert.equal(result.page, 0, `${label}: no sideways scroll`);
        NodeAssert.equal(result.spill, 0, `${label}: nothing spills out of the message`);
        if (detail === "verbose") {
          NodeAssert.equal(result.workerMessage, "open", `${label}: Verbose opens it`);
          NodeAssert.ok(result.text.includes("pr374-about-correction.md retained."), label);
          continue;
        }
        NodeAssert.equal(result.workerMessage, "folded", `${label}: folded`);
        NodeAssert.match(
          result.toggle,
          /^Message from .+\. Show full message, [\d,]+ more characters$/,
          label,
        );
        NodeAssert.ok(result.text.includes("Exactspec /Users/fixture/Projects/atlas/"), label);
        NodeAssert.ok(!result.text.includes("no space left on device"), `${label}: lead only`);
        NodeAssert.equal(
          result.merge.workerMessage,
          detail === "concise" ? "folded" : null,
          `${label}: Concise folds a mid-length message; Normal shows it whole`,
        );
      }
      await context.close();
    }
  }
  if (!measureOnly) NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "agent-messages-check.json"),
    `${JSON.stringify({ headless: true, measureOnly, results, errors }, null, 2)}\n`,
  );
  await browser.close();
}
console.log(
  JSON.stringify(
    results.map(({ label, height, workerMessage, copied, merge }) => ({
      label,
      height,
      workerMessage,
      copied,
      merge: merge.workerMessage ?? "whole",
      mergeHeight: merge.height,
    })),
  ),
);
