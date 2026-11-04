import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/google-send-approval/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/google-send-approval/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${name === "/" ? "/index.html" : name}`);
    if (!file.startsWith(root + NodePath.sep)) return void res.writeHead(403).end();
    const data = await NodeFSP.readFile(file);
    res.writeHead(200, {
      "Content-Type": file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    res.end(data);
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
let page;
const errors = [],
  blocked = [],
  checks = [];
try {
  page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${origin}/?theme=${theme}`);
      const disclosure = page.getByText(/Pick what SpecWithCode may read/);
      await disclosure.waitFor();
      NodeAssert.match(await disclosure.innerText(), /only after you choose Send/);
      NodeAssert.match(await disclosure.innerText(), /original draft stays in Gmail/);
      NodeAssert.equal(await page.getByText("nothing is ever sent", { exact: false }).count(), 0);
      const question = page.locator("[data-question-details]");
      await question.waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector("[data-question-details]")
            ?.innerText?.includes("from: reviewer@example.invalid") &&
          document
            .querySelector("[data-question-details]")
            ?.innerText?.includes("END OF APPROVED MESSAGE"),
        undefined,
        { timeout: 10_000 },
      );
      const full = await question.innerText();
      for (const text of [
        "from: reviewer@example.invalid",
        "to: colleague@example.invalid",
        "cc: teammate@example.invalid",
        "bcc: audit@example.invalid",
        "END OF APPROVED MESSAGE",
      ])
        NodeAssert.ok(full.includes(text), `${width}/${theme} shows ${text}`);
      NodeAssert.equal(await question.locator("a").count(), 0, "MIME body Markdown stays literal");
      await page.locator('[data-fixture="approval"]').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: NodePath.join(output, `${width}-${theme}-approval-top.png`),
        fullPage: true,
      });
      const tailVisible = await question.evaluate((element) => {
        const code = element.querySelector("code");
        if (!code) return false;
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && !text.textContent.includes("END OF APPROVED MESSAGE"))
          text = walker.nextNode();
        if (!text) return false;
        let node = element.parentElement;
        while (node && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement;
        if (!node) return false;
        node.scrollTop = node.scrollHeight;
        code.scrollIntoView({ block: "end" });
        const range = document.createRange();
        range.setStart(text, Math.max(0, text.textContent.length - 24));
        range.setEnd(text, text.textContent.length);
        const rect = range.getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        return (
          rect.top >= Math.max(bounds.top, 0) - 1 &&
          rect.bottom <= Math.min(bounds.bottom, innerHeight) + 1
        );
      });
      NodeAssert.ok(tailVisible, `${width}/${theme} final line reachable by scrolling`);
      NodeAssert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        "no page horizontal overflow",
      );
      await page.screenshot({
        path: NodePath.join(output, `${width}-${theme}-approval-tail.png`),
        fullPage: true,
      });
      await disclosure.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: NodePath.join(output, `${width}-${theme}-disclosure.png`),
        fullPage: true,
      });
      checks.push(
        `${width} ${theme}: accurate disclosure; all recipients/full tail; literal MIME; no overflow`,
      );
    }
  NodeAssert.deepEqual(errors, []);
  NodeAssert.deepEqual(blocked, [], "no external requests");
  await NodeFSP.writeFile(
    NodePath.join(output, "result.json"),
    JSON.stringify({ checks, errors, blocked, headless: true, mockAccountsOnly: true }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, blocked }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: NodePath.join(output, "failure.png"), fullPage: true });
    await NodeFSP.writeFile(
      NodePath.join(output, "failure.txt"),
      JSON.stringify({ errors, blocked, body: await page.locator("body").innerText() }, null, 2),
    );
  }
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
