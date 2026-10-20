// Build first: vp build --config apps/web/tests/report-links/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/report-links/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/report-links/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
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
const AUDIT = "/Users/you/.specwithcode/audits/2026-10-20";
const errors = [];
const receipt = [];

const linkedPane = (page) => page.locator('[data-viewer-linked="file"]');
/** Screenshots without a hover tooltip left from the last click. */
const settle = async (page) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
};
const back = async (page) => {
  await page.keyboard.press("Escape");
  await linkedPane(page).waitFor({ state: "detached", timeout: 5000 });
};

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1000, 390]) {
      const label = `${theme}-${width}`;
      const shot = (name) => NodePath.join(output, `${label}-${name}.png`);
      const row = { label, shots: {} };
      const context = await browser.newContext({ viewport: { width, height: 760 } });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${label}: ${String(error)}`));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator('[data-report-reader-body="true"]').waitFor();

      // 1. The shorthand shows one chip per file, each named by its real file.
      const group = page.locator('[data-file-link-group="true"]').first();
      await group.locator("a", { hasText: "findings-E.md" }).waitFor();
      const chips = await group.locator("a").allInnerTexts();
      NodeAssert.deepEqual(
        chips.map((text) => text.trim()),
        ["findings-B.md", "findings-C.md", "findings-D.md", "findings-E.md"],
        `${label}: four real files`,
      );
      NodeAssert.deepEqual(
        await group
          .locator("a")
          .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
        ["B", "C", "D", "E"].map((batch) => `${AUDIT}/findings-${batch}.md`),
      );
      NodeAssert.equal(
        await page.locator("a", { hasText: "{B,C,D,E}" }).count(),
        0,
        `${label}: no chip for the shorthand`,
      );
      await settle(page);
      await page.screenshot({ path: shot("report") });
      row.shots.report = shot("report");

      // 2. Each chip opens its own file in front of the report.
      await group.locator("a", { hasText: "findings-C.md" }).click();
      await linkedPane(page).getByText("Batch C findings").waitFor();
      await settle(page);
      await page.screenshot({ path: shot("findings-C") });
      row.shots.findingsC = shot("findings-C");
      await back(page);

      // 3. A file the shorthand names but the host lacks is marked, and says where it looked.
      const missingGroup = page.locator('[data-file-link-group="true"]').nth(1);
      await missingGroup.locator("a", { hasText: "findings-F.md" }).click();
      const missingMember = page.locator(`[data-missing-file="${AUDIT}/findings-F.md"]`);
      await missingMember.waitFor();
      NodeAssert.match(await missingMember.innerText(), /findings-F\.md was not found\./);
      NodeAssert.equal(
        await missingMember.locator("[data-similar-files] button").count(),
        5,
        `${label}: the real findings files are offered`,
      );
      await settle(page);
      await page.screenshot({ path: shot("findings-F-missing") });
      row.shots.missingMember = shot("findings-F-missing");
      await back(page);

      // 4. The link 1.0.60 opened: a plain not-found answer with the real files to open.
      await page.locator('[data-open-literal="true"]').click();
      const notice = page.locator("[data-missing-file]");
      await notice.waitFor();
      const noticeText = await notice.innerText();
      NodeAssert.match(noticeText, /findings-\{B,C,D,E\}\.md was not found\./);
      NodeAssert.doesNotMatch(noticeText, /Failed to read workspace file/);
      const similar = await notice.locator("[data-similar-files] button").allInnerTexts();
      NodeAssert.deepEqual(similar, [
        "findings-A.md",
        "findings-B.md",
        "findings-C.md",
        "findings-D.md",
        "findings-E.md",
      ]);
      await settle(page);
      await page.screenshot({ path: shot("old-link-not-found") });
      row.shots.oldLink = shot("old-link-not-found");
      await notice.locator("button", { hasText: "findings-B.md" }).click();
      await linkedPane(page).getByText("Batch B findings").waitFor();
      await settle(page);
      await page.screenshot({ path: shot("old-link-opens-B") });
      row.shots.oldLinkOpensB = shot("old-link-opens-B");

      receipt.push({ ...row, chips, similar, pass: true });
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify({ at: new Date().toISOString(), errors, receipt }, null, 2)}\n`,
  );
  await browser.close();
  server.close();
}
console.log(`report-links: ${receipt.length}/4 variants pass; evidence in ${output}`);
