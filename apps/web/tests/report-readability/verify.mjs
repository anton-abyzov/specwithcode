// Build first: vp build --config apps/web/tests/report-readability/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node verify.mjs [evidence-dir] [--local <file.md>] [--measure-only]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);

const args = process.argv.slice(2);
const localIndex = args.indexOf("--local");
const localFile = localIndex >= 0 ? args[localIndex + 1] : null;
const measureOnly = args.includes("--measure-only");
const outputArg = args.find((arg, index) => !arg.startsWith("--") && index !== localIndex + 1);
const root = NodePath.resolve(".artifacts/report-readability/site");
const output = NodePath.resolve(outputArg ?? ".artifacts/report-readability/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const extraDocs = localFile ? { [localFile]: await NodeFSP.readFile(localFile, "utf8") } : {};

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

// The fixture's files (hostFiles.ts), each opened from its chip in the message.
const FOLDER = "/Users/example/Downloads/release-evidence";
const DOCS = {
  statements: `${FOLDER}/release-result.md`,
  wrapped: `${FOLDER}/notes.md`,
  structured: `${FOLDER}/structured.md`,
  longTokens: `${FOLDER}/long-values.md`,
  ...(localFile ? { local: localFile } : {}),
};
const errors = [];
const receipt = [];

/** What a reader sees of the document body: its blocks, line breaks, tokens and overflow. */
const measure = (page) =>
  page.locator('[data-report-reader-body="true"]').evaluate((body) => {
    const prose = body.querySelector("[data-markdown-body] .chat-markdown");
    const blocks = prose ? [...prose.children].map((node) => node.tagName.toLowerCase()) : [];
    const page = body.querySelector(".report-document-page");
    const overflowing = [...body.querySelectorAll(".report-document-page *")].filter(
      (node) => node.getBoundingClientRect().right > page.getBoundingClientRect().right + 1,
    );
    return {
      blocks,
      paragraphs: prose ? prose.querySelectorAll(":scope > p").length : 0,
      lineBreaks: prose ? prose.querySelectorAll("br").length : 0,
      codeTokens: prose ? prose.querySelectorAll(":not(pre) > code").length : 0,
      fileLinks: prose ? prose.querySelectorAll("a").length : 0,
      text: prose?.innerText ?? "",
      overflowing: overflowing.map((node) => node.tagName.toLowerCase()),
    };
  });

try {
  for (const theme of ["dark", "light"]) {
    for (const width of [1100, 390]) {
      const label = `${theme}-${width}`;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript((docs) => {
        window.__EXTRA_DOCS__ = docs;
      }, extraDocs);
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${label}: ${String(error)}`));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}`);
      for (const [doc, path] of Object.entries(DOCS)) {
        await page.locator(`main a[href="${path}"]`).first().click();
        await page.locator('[data-report-reader-body="true"] [data-markdown-body]').waitFor();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        const shot = NodePath.join(output, `${label}-${doc}.png`);
        await page.screenshot({ path: shot });
        const metrics = await measure(page);
        receipt.push({ label, doc, shot, ...metrics });
        await page.keyboard.press("Escape");
        await page.locator('[data-report-reader-body="true"]').waitFor({ state: "detached" });
      }
      await context.close();
    }
  }
  if (!measureOnly) {
    const row = (label, doc) => receipt.find((entry) => entry.label === label && entry.doc === doc);
    for (const label of ["dark-1100", "dark-390", "light-1100", "light-390"]) {
      const statements = row(label, "statements");
      // Six statements, one block each, every digit and hash exactly as written.
      NodeAssert.equal(statements.paragraphs, 6, `${label}: one paragraph per statement`);
      NodeAssert.match(statements.text, /merged at 4be1f0c9d2a7e65b31c8f09a7d4e2b6c58a1f3e0;/u);
      // Commit, digest and both paths, each shown in full.
      NodeAssert.equal(statements.codeTokens, 4, `${label}: digests and paths set as code`);
      NodeAssert.match(
        statements.text,
        /\/Users\/example\/Downloads\/release-evidence\/report\.html/u,
      );
      // Hard-wrapped prose stays one paragraph; short label lines keep their lines.
      const wrapped = row(label, "wrapped");
      NodeAssert.equal(wrapped.paragraphs, 2, `${label}: wrapped prose stays joined`);
      NodeAssert.equal(wrapped.lineBreaks, 2, `${label}: label lines keep their breaks`);
      // A well-formed report renders as it did.
      const structured = row(label, "structured");
      NodeAssert.equal(structured.lineBreaks, 0, `${label}: no breaks added to a clean report`);
      for (const entry of receipt.filter((item) => item.label === label)) {
        NodeAssert.deepEqual(entry.overflowing, [], `${label} ${entry.doc}: nothing overflows`);
      }
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify({ at: new Date().toISOString(), measureOnly, errors, receipt }, null, 2)}\n`,
  );
  await browser.close();
  server.close();
}
console.log(`report-readability: ${receipt.length} documents rendered; evidence in ${output}`);
