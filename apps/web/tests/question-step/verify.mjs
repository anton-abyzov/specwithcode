// Build with vp build --config apps/web/tests/question-step/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/question-step/site");
const output = NodePath.resolve(".artifacts/question-step/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
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
const receipt = { headless: true, checks: [], screenshots: [] };
const shot = async (page, name) => {
  const file = NodePath.join(output, `${name}.png`);
  await page.locator('[data-fixture="step"]').screenshot({ path: file });
  receipt.screenshots.push(file);
};
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [340, 720]) {
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      const footer = page.locator("[data-question-step]");
      const next = page.locator("[data-question-step-next]");
      const selection = page.locator("[data-question-step-selection]");
      await footer.waitFor();
      const label = `${theme}@${width}`;

      // The step sits in view under a scrolled option list, inside the card.
      const card = await page.locator('[data-slot="composer-banner"]').boundingBox();
      const box = await footer.boundingBox();
      NodeAssert.ok(
        box && card && box.y + box.height <= card.y + card.height,
        `${label} inside card`,
      );
      NodeAssert.ok(box.y + box.height <= 760, `${label} footer visible without scrolling`);
      NodeAssert.equal(await next.isDisabled(), true, `${label} disabled until a pick`);
      NodeAssert.equal(await selection.textContent(), "None selected yet");
      NodeAssert.equal(await page.locator("[data-question-step-back]").count(), 0);
      await shot(page, `${label}-1-empty`);

      // Click and letter keys toggle; the count follows.
      await page.locator('[data-question-option="A"]').click();
      await page.locator("body").press("c");
      await page.locator("body").press("i");
      NodeAssert.equal(await selection.textContent(), "3 selected", `${label} count`);
      NodeAssert.equal(await next.isDisabled(), false);
      NodeAssert.equal(await next.getAttribute("data-question-step-next"), "next");
      NodeAssert.match(await next.textContent(), /^Next/);
      await shot(page, `${label}-2-selected`);

      // Next advances; Back returns with the picks kept.
      await next.click();
      await page.getByText("Which Shorts should go out?").waitFor();
      NodeAssert.equal(await page.getByText("2/4").count(), 1, `${label} 2/4`);
      await page.locator("[data-question-step-back]").click();
      await page.getByText("Which TikTok and Instagram posts should go out?").waitFor();
      NodeAssert.equal(await selection.textContent(), "3 selected", `${label} picks kept`);

      // Cmd/Ctrl+Enter takes the step from the keyboard.
      const mod = "ControlOrMeta";
      // The option normally retains focus after selection. It must not consume
      // the shortcut as another toggle before the document handler can advance.
      await page.locator('[data-question-option="A"]').focus();
      await page.keyboard.press(`${mod}+Enter`);
      await page.getByText("Which Shorts should go out?").waitFor();
      await page.locator("[data-question-step-back]").click();
      NodeAssert.equal(
        await selection.textContent(),
        "3 selected",
        `${label} shortcut keeps picks`,
      );
      await page.locator("body").press(`${mod}+Enter`);
      await page.getByText("Which Shorts should go out?").waitFor();
      // Not while typing in a field: the composer owns Enter there.
      await page.locator('[data-question-option="A"]').click();
      await page.locator("#composer").focus();
      await page.keyboard.press(`${mod}+Enter`);
      NodeAssert.equal(await page.getByText("2/4").count(), 1, `${label} composer keeps focus`);
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.locator("body").press(`${mod}+Enter`);
      await page.getByText("Which LinkedIn posts should go out?").waitFor();
      await page.locator('[data-question-option="B"]').click();
      await next.click();
      await page.getByText("Which X posts should go out?").waitFor();

      // The last question submits every answer.
      NodeAssert.equal(await next.getAttribute("data-question-step-next"), "submit");
      NodeAssert.match(await next.textContent(), /^Submit answers/);
      NodeAssert.equal(await next.isDisabled(), true);
      await page.locator('[data-question-option="A"]').click();
      await page.locator('[data-question-option="B"]').click();
      await shot(page, `${label}-3-submit`);
      await next.click();
      const result = JSON.parse(await page.locator("[data-fixture-result]").textContent());
      NodeAssert.deepEqual(Object.keys(result), ["q1", "q2", "q3", "q4"]);
      NodeAssert.equal(result.q1.length, 3);
      NodeAssert.equal(result.q4.length, 2);
      NodeAssert.deepEqual(errors, []);
      receipt.checks.push(`${label}: in-card step, count, Next, Back, ${mod}+Enter, Submit`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
