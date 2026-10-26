// Worker messages in the coordinator view (`?payload`): a long one shows its opening and
// the sentence asking for a decision, the whole text one click away, copied exactly.
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
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const errors = [];
const results = [];

// 640 px at device scale 2 lays out like a 1280 px window at 200% zoom.
const VIEWS = [
  { name: "1280", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  { name: "360", viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 },
  { name: "zoom200", viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 },
];

try {
  for (const view of VIEWS) {
    for (const theme of ["light", "dark"]) {
      const label = `${view.name}-${theme}`;
      const context = await browser.newContext({
        viewport: view.viewport,
        deviceScaleFactor: view.deviceScaleFactor,
        colorScheme: theme,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
      await page.goto(`${origin}/?payload`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      const texts = await page.evaluate(() => window.payloadFixtureTexts);
      const conversation = page.getByLabel("Coordinator conversation");
      await conversation.waitFor();
      const worker = (start) =>
        conversation.locator("article.project-message").filter({ hasText: start });
      const dense = worker("Need exactEXISTINGbackend");
      const launch = worker("1040 repository registration");
      const blocked = worker("Publishing is held: the update feed");
      const short = worker("Done. The PR is green");
      // Read from the top the way a person scrolls, so following the latest message lets go.
      await conversation.hover();
      await page.mouse.wheel(0, -5000);
      await page.waitForTimeout(300);
      await dense.scrollIntoViewIfNeeded();
      await dense.screenshot({ path: NodePath.join(output, `dense-folded-${label}.png`) });
      await launch.scrollIntoViewIfNeeded();
      await launch.screenshot({ path: NodePath.join(output, `launch-folded-${label}.png`) });

      // The "Message from …" header is the message's one fold control.
      const denseToggle = dense.locator("[data-relayed-message] h3 button");
      const result = {
        label,
        sentBy: await dense.getByText("Sent by").count(),
        viewThread: await dense.getByRole("button", { name: "View thread" }).count(),
        denseName: await denseToggle.getAttribute("aria-label"),
        denseExpanded: await denseToggle.getAttribute("aria-expanded"),
        denseFoldedText: await dense.innerText(),
        denseFoldedHeight: Math.round((await dense.boundingBox()).height),
        launchFoldedText: await launch.innerText(),
        blockedWhole: (await blocked.innerText()).includes("nothing else in the release changed"),
        blockedHasToggle: await blocked.getByRole("button", { name: /Show full message/ }).count(),
        shortHasToggle: await short.getByRole("button", { name: /Show full message/ }).count(),
      };

      // Keyboard: Enter opens, the whole original shows, Space folds it again.
      await denseToggle.focus();
      await page.keyboard.press("Enter");
      const denseOpenToggle = denseToggle;
      result.openExpanded = await denseOpenToggle.getAttribute("aria-expanded");
      result.denseOpenText = await dense.innerText();
      result.denseOpenHeight = Math.round((await dense.boundingBox()).height);
      await dense.screenshot({ path: NodePath.join(output, `dense-open-${label}.png`) });
      // Selecting the opened body selects the original words.
      result.selection = await dense.evaluate((article) => {
        const body = article.querySelector("[data-relayed-message-body]");
        const range = document.createRange();
        range.selectNodeContents(body);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const text = selection.toString();
        selection.removeAllRanges();
        return text;
      });
      // Copy original writes the stored text, byte for byte.
      const copy = dense.getByRole("button", { name: "Copy original message" });
      await copy.focus();
      await page.keyboard.press("Enter");
      await dense.getByRole("button", { name: "Original message copied" }).waitFor();
      result.copied = await page.evaluate(() => navigator.clipboard.readText());
      await denseOpenToggle.focus();
      await page.keyboard.press("Space");
      result.refolded = await denseToggle.getAttribute("aria-expanded");
      result.focusAfterFold = await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-expanded"),
      );
      // Nothing spills sideways, at 360 px or at 200% zoom.
      result.overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const bubbles = [...document.querySelectorAll("article.project-message")].filter(
          (node) => node.scrollWidth > node.clientWidth + 1,
        ).length;
        return { page: root.scrollWidth - root.clientWidth, bubbles };
      });
      results.push(result);

      NodeAssert.equal(result.sentBy, 0, `${label}: a quiet header replaces Sent by`);
      NodeAssert.equal(result.viewThread, 1, `${label}: links back to its thread`);
      NodeAssert.equal(result.denseExpanded, "false", `${label}: folded by default`);
      NodeAssert.match(
        result.denseName,
        /^Message from .+\. Show full message, [\d,]+ more characters$/,
      );
      NodeAssert.ok(
        result.denseFoldedText.includes(
          "Need exactEXISTINGbackend/canonical ownerbinding, no newworker.",
        ),
        `${label}: verbatim lead`,
      );
      NodeAssert.ok(
        !result.denseFoldedText.includes("message:mcp:"),
        `${label}: routing ID folded`,
      );
      NodeAssert.ok(
        result.launchFoldedText.includes("reportBack:true?"),
        `${label}: the ask shows`,
      );
      NodeAssert.ok(result.blockedWhole, `${label}: a short message with Blockers shows whole`);
      NodeAssert.equal(result.blockedHasToggle, 0);
      NodeAssert.equal(result.shortHasToggle, 0);
      NodeAssert.equal(result.openExpanded, "true", `${label}: Enter opens`);
      NodeAssert.ok(
        result.denseOpenText.includes("Allreleaseholdsunchanged."),
        `${label}: the whole original opens`,
      );
      NodeAssert.ok(result.selection.includes("message:mcp:0f3c9a1e"), `${label}: selectable`);
      NodeAssert.equal(result.copied, texts.dense, `${label}: exact copy`);
      NodeAssert.equal(result.refolded, "false", `${label}: Space folds`);
      NodeAssert.equal(result.focusAfterFold, "false", `${label}: focus stays on the toggle`);
      NodeAssert.ok(result.denseOpenHeight > result.denseFoldedHeight);
      NodeAssert.equal(result.overflow.page, 0, `${label}: no sideways scroll`);
      NodeAssert.equal(result.overflow.bubbles, 0, `${label}: no bubble overflow`);
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "worker-message-check.json"),
    `${JSON.stringify({ results, errors }, null, 2)}\n`,
  );
  await browser.close();
}
console.log(
  JSON.stringify(
    results.map(({ label, denseFoldedHeight, denseOpenHeight, denseName }) => ({
      label,
      denseFoldedHeight,
      denseOpenHeight,
      denseName,
    })),
  ),
);
