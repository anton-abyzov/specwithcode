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
      await page.waitForSelector("form [data-picker-model]");
      // The chip: its model part, its accessible name, and the state suffix beside it.
      const readChip = async () => {
        const trigger = page.locator("form [data-chat-provider-model-picker]");
        const tag = page.locator("form .sws-model-state");
        return {
          model: (await page.locator("form [data-picker-model]").innerText()).trim(),
          name: (await trigger.getAttribute("aria-label")) ?? "",
          state: (await tag.count()) === 0 ? null : await tag.getAttribute("data-model-state"),
          // The words of the suffix where the chip has room; a fallback is its glyph alone.
          text: await page.evaluate(
            () => document.querySelector("form .sws-model-state-full")?.textContent?.trim() ?? null,
          ),
        };
      };
      const chip = await readChip();
      const list = page.locator("[data-list-model]");
      const listName = (await list.locator(".sws-model").innerText()).replace(/\s+/g, " ").trim();
      if (scenario === "fallback")
        check(`${theme} fallback: chip names Gemini as a fallback for Opus`, () => {
          NodeAssert.equal(chip.model, "Default");
          NodeAssert.match(
            chip.name,
            /^Model: Gemini · Default, fallback for Claude Code · Opus 5\.5/,
          );
          NodeAssert.equal(chip.state, "fallback");
          NodeAssert.match(listName, /Gemini/);
        });
      if (scenario === "stale" || scenario === "manual") {
        // Nothing runs, so the explicit pick is the chip's model: no "next:" beside the old one.
        const pick = scenario === "stale" ? "Claude Code · Opus 5.5" : "Gemini · Default";
        check(`${theme} ${scenario}: an idle thread's chip names the explicit pick`, () => {
          NodeAssert.equal(chip.model, scenario === "stale" ? "Opus 5.5" : "Default");
          NodeAssert.ok(chip.name.startsWith(`Model: ${pick},`), chip.name);
          NodeAssert.doesNotMatch(chip.name, /next message|fallback for|saved model/);
          NodeAssert.equal(chip.state, null);
        });
      }
      if (scenario === "running" || scenario === "running-manual-active")
        check(`${theme} ${scenario}: chip names the running model, then the saved one`, () => {
          NodeAssert.equal(chip.model, "Default");
          NodeAssert.equal(chip.state, "preferred");
          NodeAssert.match(chip.text ?? "", /^then .*Opus 5\.5/);
        });
      if (scenario === "same")
        check(`${theme} same: no suffix when the chip is what runs`, () => {
          NodeAssert.equal(chip.model, "Opus 5.5");
          NodeAssert.equal(chip.state, null);
        });
      if (scenario === "running-manual") {
        check(
          `${theme} running-manual: a pick during a turn reads next beside the running model`,
          () => {
            NodeAssert.equal(chip.model, "Default");
            NodeAssert.equal(chip.state, "next");
            NodeAssert.equal(chip.text, "next: Opus 5.5");
            NodeAssert.match(
              chip.name,
              /^Model: Gemini · Default, next message uses Claude Code · Opus 5\.5/,
            );
          },
        );
        const before = NodePath.join(output, `composer-${scenario}-${theme}.png`);
        await page.screenshot({ path: before, fullPage: true });
        receipt.screenshots.push(before);
        // Stop the turn: the chip names the pick at once.
        await page.evaluate(() => window.stopFixtureTurn());
        await page.waitForFunction(
          () =>
            document.querySelector("form [data-picker-model]")?.textContent?.trim() === "Opus 5.5",
        );
        const stoppedChip = await readChip();
        check(
          `${theme} stopped: the chip names the pick, with no next beside the old model`,
          () => {
            NodeAssert.equal(stoppedChip.model, "Opus 5.5");
            NodeAssert.ok(
              stoppedChip.name.startsWith("Model: Claude Code · Opus 5.5,"),
              stoppedChip.name,
            );
            NodeAssert.doesNotMatch(stoppedChip.name, /next message|Gemini/);
            NodeAssert.equal(stoppedChip.state, null);
          },
        );
        const after = NodePath.join(output, `composer-stopped-${theme}.png`);
        await page.screenshot({ path: after, fullPage: true });
        receipt.screenshots.push(after);
        await page.close();
        continue;
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
