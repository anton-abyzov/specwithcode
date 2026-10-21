// Headless only: PWDEBUG=0, no HTML report, screenshots written to files.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = createRequire(import.meta.url)(
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  ),
);
const site = resolve(".artifacts/increment-traceability/site");
const output = resolve(process.argv[2] || ".artifacts/increment-traceability/evidence");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const shells = join(homedir(), "Library/Caches/ms-playwright");
const shell = (await readdir(shells))
  .filter((name) => name.startsWith("chromium_headless_shell"))
  .toSorted()
  .at(-1);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_TEST_CHROMIUM ||
    join(shells, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
});
const origin = `http://127.0.0.1:${server.address().port}`;
const receipt = {
  headless: true,
  scope: "Real components, synthetic data, stubbed RPC; no live project or database",
  cases: [],
};
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 760, height: 1200 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto(`${origin}/?view=card&theme=${theme}`);
    await page.getByRole("button", { name: /Acceptance criteria/ }).click();
    const summary = await page.locator("[data-plan-criteria-summary]").innerText();
    const rows = await page.locator("[data-plan-criteria] li").allInnerTexts();
    assert.match(rows.join("\n"), /AC-02[\s\S]*T-01, T-02/);
    assert.match(rows.join("\n"), /AC-06[\s\S]*(No task|uncovered|Not covered)/i);
    await page.screenshot({ path: join(output, `card-${theme}.png`), fullPage: true });
    receipt.cases.push({ theme, view: "card", summary, rows: rows.length });

    await page.goto(`${origin}/?view=picker&theme=${theme}`);
    const more = page.locator("[data-link-increment-more]");
    assert.match(await more.innerText(), /Showing 50 of 3000/);
    await page.screenshot({ path: join(output, `picker-${theme}.png`) });
    await more.getByRole("button", { name: "Load more" }).click();
    assert.match(await more.innerText(), /Showing 100 of 3000/);
    await page.locator("[data-link-increment-status] button", { hasText: /^active/ }).click();
    const active = await page.locator("[data-link-increment-options] li").count();
    await page.getByPlaceholder("Search increments by number or title").fill("traceability");
    await page.waitForTimeout(400);
    const found = await page.locator("[data-link-increment-options] li").allInnerTexts();
    assert.deepEqual(
      found.map((text) => text.trim().split("\n")[0]),
      ["2962 AC traceability"],
    );
    await page.screenshot({ path: join(output, `picker-search-${theme}.png`) });
    receipt.cases.push({ theme, view: "picker", activeListed: active, search: found });

    for (const kind of ["umbrella", "nested", "outside"]) {
      await page.goto(`${origin}/?view=folder-${kind}&theme=${theme}`);
      await page.getByLabel("New project folder").fill("/target");
      await page.getByRole("button", { name: "Check" }).click();
      const layout = await page.locator("[data-folder-layout]").innerText();
      const planning = await page.locator("[data-folder-planning]").count();
      const apply = page.getByRole("button", { name: "Change folder" });
      if (kind === "outside") {
        assert.equal(planning, 1);
        assert.equal(await apply.isDisabled(), true);
        await page.getByLabel("Plan cards should read the new folder's increments").check();
        assert.equal(await apply.isDisabled(), false);
        await page.getByLabel("Plan cards should read the new folder's increments").uncheck();
      } else assert.equal(planning, 0);
      await page.screenshot({ path: join(output, `folder-${kind}-${theme}.png`), fullPage: true });
      receipt.cases.push({
        theme,
        view: `folder-${kind}`,
        layout,
        planningWarning: planning === 1,
      });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
