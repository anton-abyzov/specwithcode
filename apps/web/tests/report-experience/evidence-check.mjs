// Evidence links in an HTML report (`?evidence`), opened in the focused reader: labeled chips,
// full path on hover and focus, copy, opening in the reply's own thread, and refusal of hostile
// requests. Always headless. Run against the report fixture (port 5843, or REPORT_FIXTURE_PORT).
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
const origin = `http://127.0.0.1:${process.env.REPORT_FIXTURE_PORT ?? 5843}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const ROOT = "/Users/fixture/work/atlas/evidence";
const errors = [];
const results = [];

// 640 px at device scale 2 lays out like a 1280 px window at 200% zoom.
const VIEWS = [
  { name: "1280", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  { name: "360", viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 },
  { name: "zoom200", viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 },
];

async function openReader(page, query) {
  await page.goto(`${origin}/?${query}`);
  await page.getByRole("button", { name: /Open report/ }).click();
  await page.waitForFunction(() => window.fixtureState().overlay !== null);
  const frame = page.frameLocator("iframe");
  await frame.locator("a.studio-evidence").first().waitFor();
  return frame;
}

const linked = (page) => page.evaluate(() => window.fixtureState().linked);
async function backToReport(page) {
  await page.getByRole("button", { name: /^Back to/ }).click();
  await page.waitForFunction(() => window.fixtureState().linked === null);
  // The app opens at most one evidence file per 400 ms; a person is slower than that.
  await page.waitForTimeout(450);
}

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
      const frame = await openReader(page, `theme=${theme}&evidence=1`);
      const result = { label };

      // Only explicit anchors with local paths become chips; code, fragments and web links stay.
      result.chips = await frame.locator("a.studio-evidence").count();
      result.plainDecorated = await frame.locator("#plain.studio-evidence").count();
      result.codeLinked = await frame.locator("#code a, a:has(#code)").count();
      result.fragmentDecorated = await frame.locator("#fragment.studio-evidence").count();
      result.externalDecorated = await frame.locator("#external.studio-evidence").count();
      result.uncDecorated = await frame.locator("#unc.studio-evidence").count();
      result.bareLabel = (await frame.locator("#bare").textContent()).trim();
      result.kinds = await frame
        .locator("a.studio-evidence")
        .evaluateAll((links) => links.map((a) => `${a.id}:${a.dataset.kind}`));

      // Hover reveals the full path; it stays inside the page.
      await frame.locator("#shot").hover();
      const tip = frame.locator("#shot ~ .studio-evidence-path");
      await tip.waitFor({ state: "visible" });
      result.hoverPath = await tip.textContent();
      result.tipInside = await tip.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.left >= 0 && box.right <= document.documentElement.clientWidth + 0.5;
      });
      await page.screenshot({ path: NodePath.join(output, `reader-hover-${label}.png`) });
      // Accessible names: the label, the path as its description, a named copy button.
      result.shotDescription = await frame.locator("#shot").evaluate((a) =>
        a
          .getAttribute("aria-describedby")
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent)
          .join(" "),
      );
      result.copyName = await frame
        .locator("#shot ~ .studio-evidence-copy")
        .getAttribute("aria-label");

      // A click opens the file in the reader, in the reply's own thread.
      await frame.locator("#shot").click();
      await page.waitForFunction(() => window.fixtureState().linked !== null);
      result.openShot = await linked(page);
      await page.screenshot({ path: NodePath.join(output, `reader-opened-${label}.png`) });
      await backToReport(page);

      // Keyboard: focus the log chip and press Enter; its line comes along.
      await frame.locator("#log").focus();
      result.focusTipVisible = await frame.locator("#log ~ .studio-evidence-path").isVisible();
      await page.screenshot({ path: NodePath.join(output, `reader-focus-${label}.png`) });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.fixtureState().linked !== null);
      result.openLog = await linked(page);
      await backToReport(page);

      // A file: URL and a home path open too; the page's rewritten link opens its real target.
      for (const id of ["clip", "home", "mutating"]) {
        await frame.locator(`#${id}`).click();
        await page.waitForFunction(() => window.fixtureState().linked !== null);
        result[`open-${id}`] = await linked(page);
        await backToReport(page);
      }
      result.mutatingLabel = (await frame.locator("#mutating").textContent()).trim();
      result.mutatingTip = await frame.locator("#mutating ~ .studio-evidence-path").textContent();

      // A link a page published before evidence links still opens the file, not a browser tab.
      await frame.locator("#plain").click();
      await page.waitForFunction(() => window.fixtureState().linked !== null);
      result.openPlain = await linked(page);
      await backToReport(page);

      // Copy puts exactly the path on the clipboard.
      await frame.locator("#shot ~ .studio-evidence-copy").click();
      await frame.locator('#shot ~ .studio-evidence-copy[data-evidence-state="copied"]').waitFor();
      result.copied = await page.evaluate(() => navigator.clipboard.readText());
      result.overflow = await frame
        .locator("html")
        .evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      results.push(result);

      NodeAssert.equal(result.chips, 6, `${label}: six evidence chips`);
      NodeAssert.equal(result.plainDecorated, 0);
      NodeAssert.equal(result.codeLinked, 0, `${label}: code is never linked`);
      NodeAssert.equal(result.fragmentDecorated, 0);
      NodeAssert.equal(result.externalDecorated, 0);
      NodeAssert.equal(result.uncDecorated, 0, `${label}: a network path is never a chip`);
      NodeAssert.equal(result.bareLabel, "report.md", `${label}: a bare path shows its name`);
      NodeAssert.ok(result.kinds.includes("shot:image") && result.kinds.includes("log:log"));
      NodeAssert.equal(result.hoverPath, `${ROOT}/login-dark.png`);
      NodeAssert.ok(result.tipInside, `${label}: the path stays inside the page`);
      NodeAssert.equal(result.shotDescription, `${ROOT}/login-dark.png`);
      NodeAssert.equal(result.copyName, `Copy path ${ROOT}/login-dark.png`);
      NodeAssert.deepEqual(result.openShot, {
        path: `${ROOT}/login-dark.png`,
        line: null,
        environmentId: "fixture",
        threadId: "fixture-thread",
      });
      NodeAssert.ok(result.focusTipVisible, `${label}: focus reveals the path`);
      NodeAssert.equal(result.openLog.path, `${ROOT}/release-check.log`);
      NodeAssert.equal(result.openLog.line, 12);
      NodeAssert.equal(result["open-clip"].path, `${ROOT}/sign-in flow.mp4`);
      NodeAssert.equal(result["open-home"].path, "/Users/fixture/evidence/notes.txt");
      NodeAssert.equal(result["open-mutating"].path, `${ROOT}/swapped.png`);
      NodeAssert.equal(result.mutatingLabel, "Safe screenshot");
      NodeAssert.equal(
        result.mutatingTip,
        `${ROOT}/swapped.png`,
        `${label}: reveal shows the real target`,
      );
      NodeAssert.equal(result.openPlain.path, `${ROOT}/plain.txt`);
      NodeAssert.equal(result.copied, `${ROOT}/login-dark.png`);
      NodeAssert.equal(result.overflow, 0, `${label}: no sideways scroll in the report`);
      await context.close();
    }
  }

  // Hostile requests: none without a click, refusals after one, and the thread never changes.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`hostile: ${error.message}`));
    const frame = await openReader(page, "theme=dark&evidence=1&hostile=1");
    await page.waitForTimeout(600);
    const atLoad = await page.evaluate(() => ({
      linked: window.fixtureState().linked,
      replies: window.fixtureReplies ?? null,
    }));
    await frame.locator("#hostile").click();
    await page.waitForFunction(() => (window.fixtureReplies ?? []).length >= 5);
    // The flood arrives after the accepted open moved focus to the file: refused or ignored.
    await page.waitForTimeout(800);
    const replies = await page.evaluate(() => window.fixtureReplies);
    const byId = Object.fromEntries(replies.map((reply) => [reply.id, reply]));
    const hostile = { atLoad, replies, opened: await linked(page) };
    results.push({ label: "hostile", ...hostile });
    await page.screenshot({ path: NodePath.join(output, "hostile-dark.png") });
    NodeAssert.deepEqual(
      atLoad,
      { linked: null, replies: null },
      "nothing opens or answers at load",
    );
    for (const id of ["traversal", "encoded", "control", "url"])
      NodeAssert.equal(byId[id]?.error, "Invalid path", `${id} refused`);
    NodeAssert.equal(byId.forged?.ok, true);
    NodeAssert.deepEqual(hostile.opened, {
      path: `${ROOT}/forged-target.png`,
      line: null,
      environmentId: "fixture",
      threadId: "fixture-thread",
    });
    const flood = replies.filter((reply) => String(reply.id).startsWith("flood-"));
    NodeAssert.ok(
      flood.every((reply) => !reply.ok),
      "no flood request opens a file",
    );
    await context.close();
  }

  // A connection that cannot read files refuses, and the chip says so.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const frame = await openReader(page, "theme=light&evidence=1&no-read=1");
    await frame.locator("#shot").click();
    await frame.locator('#shot[data-evidence-state="denied"]').waitFor();
    const denied = {
      opened: await linked(page),
      replies: await page.evaluate(() => window.fixtureReplies),
    };
    results.push({ label: "no-read", ...denied });
    await page.screenshot({ path: NodePath.join(output, "no-read-light.png") });
    NodeAssert.equal(denied.opened, null);
    NodeAssert.equal(denied.replies.at(-1).error, "Policy violation");
    await context.close();
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "evidence-check.json"),
    `${JSON.stringify({ results, errors }, null, 2)}\n`,
  );
  await browser.close();
}
console.log(`evidence-check: ${results.length} runs passed`);
