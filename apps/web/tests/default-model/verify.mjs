// Headless check of Settings › General › New threads › Model: switching the default from
// Claude (Extra High, Fast mode, Ultracode) to GitHub Copilot keeps the effort, names what
// Copilot lacks in a toast and on the row, and Codex takes Claude's Fast mode as its Fast tier.
// Build from apps/web: node ../../node_modules/vite-plus/bin/vp build --config tests/default-model/vite.config.ts
// Run from the worktree root with PLAYWRIGHT_MODULE and PLAYWRIGHT_EXECUTABLE_PATH set:
//   node apps/web/tests/default-model/verify.mjs <outdir>
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const assert = NodeAssert.default;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const site = NodePath.resolve(".artifacts/default-model/site");
const output = NodePath.resolve(process.argv[2] || ".artifacts/default-model/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader("content-type", types[NodePath.extname(file)] || "application/octet-stream");
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const base = `http://127.0.0.1:${server.address().port}/`;
const receipt = { headless: true, checks: [], screenshots: [] };
const check = (name, fn) => {
  fn();
  receipt.checks.push(name);
};
const shot = async (name) => {
  const file = NodePath.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  receipt.screenshots.push(file);
};
const open = async (start, theme = "light") => {
  await page.goto(`${base}?start=${start}&theme=${theme}`);
  await page.waitForFunction(() => document.getElementById("root").childElementCount > 0);
  await page.evaluate(() => document.fonts.ready);
};
const saved = () => page.evaluate(() => window.fixtureState.settings.defaultModelSelection);
const unsupported = () =>
  page.evaluate(
    () => document.querySelector("[data-default-model-unsupported]")?.textContent ?? null,
  );
const pick = async (provider, model) => {
  await page
    .locator("#default-model button", { hasText: /Opus|GPT/ })
    .first()
    .click();
  await page.getByRole("button", { name: provider, exact: true }).click();
  await page
    .getByRole("option", { name: new RegExp(model) })
    .first()
    .click();
  await page.waitForTimeout(300);
};

for (const theme of ["light", "dark"]) {
  await open("claude", theme);
  const claudeLine = await unsupported();
  check(`${theme}: Claude offers every common option, so nothing is named`, () =>
    assert.equal(claudeLine, null),
  );
  await shot(`${theme}-claude`);

  await pick("GitHub Copilot", "Claude Opus 5.5");
  const copilot = await saved();
  check(`${theme}: Copilot keeps Extra High as its xhigh effort and nothing else`, () =>
    assert.deepEqual(copilot, {
      instanceId: "acpRegistry_copilot",
      model: "claude-opus-5.5",
      options: [{ id: "reasoning_effort", value: "xhigh" }],
    }),
  );
  const toast = await page
    .locator("[data-slot='toast-description'], [role='status']")
    .allInnerTexts();
  check(`${theme}: a toast names Ultracode and Fast mode`, () =>
    assert.ok(
      toast.some((text) =>
        text.includes(
          "Claude Opus 5.5 on GitHub Copilot has no Ultracode or Fast mode, so they were left off.",
        ),
      ),
      JSON.stringify(toast),
    ),
  );
  const copilotLine = await unsupported();
  check(`${theme}: the row names what Copilot lacks`, () =>
    assert.equal(copilotLine, "Claude Opus 5.5 on GitHub Copilot has no Fast mode or Ultracode."),
  );
  await shot(`${theme}-copilot`);
}

await open("claude");
await pick("Codex", "GPT-5.5");
const codex = await saved();
check("Codex takes Claude's Fast mode as its Fast service tier", () =>
  assert.deepEqual(codex, {
    instanceId: "codex",
    model: "gpt-5.5",
    options: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "priority" },
    ],
  }),
);
const codexLine = await unsupported();
check("the row names what Codex lacks", () =>
  assert.equal(codexLine, "GPT-5.5 on Codex has no Ultracode."),
);
await shot("light-codex");

check("no page errors", () => assert.deepEqual(errors, []));
await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
await browser.close();
server.close();
