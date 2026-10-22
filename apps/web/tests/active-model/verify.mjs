// Build first: vp build --config apps/web/tests/active-model/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/active-model/verify.mjs [/absolute/evidence-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/active-model/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/active-model/evidence");
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
const receipt = { headless: true, checks: [], screenshots: [] };
const check = (name, fn) => {
  fn();
  receipt.checks.push(name);
};
try {
  for (const theme of ["light", "dark"]) {
    for (const scenario of [
      "fallback",
      "stale",
      "running",
      "same",
      "manual",
      "running-manual",
      "running-manual-active",
    ]) {
      const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
      await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
      await page.waitForSelector("body[data-fixture-ready]");
      await page.waitForSelector("[data-chat-provider-model-picker-label]");
      const chip = (
        await page.locator("[data-chat-provider-model-picker-label]").innerText()
      ).trim();
      const tag = page.locator(
        `form [data-model-state="${scenario === "fallback" || scenario === "stale" ? "fallback" : scenario === "manual" ? "next" : "preferred"}"]`,
      );
      const tagCount = await tag.count();
      const read =
        tagCount === 0
          ? null
          : {
              kind: await tag.getAttribute("data-model-state"),
              text: (await tag.innerText()).trim(),
              tip: await tag.getAttribute("aria-label"),
            };
      if (scenario === "fallback" || scenario === "stale")
        check(`${theme} fallback: chip names Gemini, tag says Fallback instead of Opus`, () => {
          NodeAssert.match(chip, /Gemini.* · Default/);
          NodeAssert.equal(read?.kind, "fallback");
          NodeAssert.equal(read?.text, "Fallback for Opus 5.5");
          NodeAssert.match(read?.tip ?? "", /instead of your pick, Claude Code · Opus 5\.5/);
        });
      if (scenario.startsWith("running"))
        check(`${theme} running: chip names active execution, tag names the preference`, () => {
          NodeAssert.match(chip, /Gemini.* · Default/);
          NodeAssert.equal(read?.kind, "preferred");
          NodeAssert.match(read?.text ?? "", /^Preferred: .*Opus 5\.5/);
        });
      if (scenario === "same")
        check(`${theme} same: no tag when the chip is what runs`, () => {
          NodeAssert.match(chip, /Opus 5\.5/);
          NodeAssert.equal(read, null);
        });
      if (scenario === "manual")
        check(`${theme} manual choice remains visible as next`, () => {
          NodeAssert.match(chip, /Opus 5\.5/);
          NodeAssert.match(read?.text ?? "", /^Next: Gemini.*Default/);
        });
      if (scenario === "running-manual-active")
        NodeAssert.equal(await page.locator("form [data-model-state=next]").count(), 0);
      if (scenario === "running-manual") {
        NodeAssert.equal(await page.locator("form [data-model-state=next]").count(), 1);
        NodeAssert.match(
          await page.locator("form [data-model-state=next]").innerText(),
          /Opus 5\.5/,
        );
      }
      const list = page.locator("[data-list-model]");
      const listModel = (await list.locator(".sws-model").innerText()).replace(/\s+/g, " ").trim();
      check(`${theme} ${scenario}: list and composer agree`, () =>
        NodeAssert.equal(chip.replace(/\s+/g, " "), listModel),
      );
      if (read && scenario !== "manual") {
        const listState = (await list.locator("[data-model-state]").innerText()).trim();
        check(`${theme} ${scenario}: list and composer preference agree`, () =>
          NodeAssert.equal(read.text, listState),
        );
      }
      const file = NodePath.join(output, `composer-${scenario}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);
      await page.close();
    }
  }
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`active model ok: ${receipt.checks.length} checks; evidence in ${output}`);
} finally {
  await browser.close();
  server.close();
}
