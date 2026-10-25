// Headless checks and captures for 1053 AC-06. Build first:
//   npx vp build -c apps/web/tests/subagent-handoff-continuity/vite.config.ts
// then: node apps/web/tests/subagent-handoff-continuity/verify.mjs <evidence dir>
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const assert = NodeAssert.default;
const { readFile, mkdir, writeFile } = NodeFSP;
const { resolve, extname, join } = NodePath;
const { homedir } = NodeOS;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const site = resolve(".artifacts/subagent-handoff-continuity/site");
const output = resolve(process.argv[2] || ".artifacts/subagent-handoff-continuity/evidence");
await mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
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
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_TEST_CHROMIUM ||
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
});

// Every screenshot row: list word, popover/peek labels, and the native header bar.
const expected = {
  seo: { group: "Idle", word: "Idle", peeks: ["Done", "Failed", "Failed", "Failed"], bars: 4 },
  cms: { group: "Idle", word: "Idle", peeks: ["Done"], bars: 1 },
  console: { group: "Idle", word: "Idle", peeks: ["Done"], bars: 1 },
  club: { group: "Idle", word: "Idle", peeks: ["Done", "Done"], bars: 2 },
  premierliga: {
    group: "Idle",
    word: "Idle",
    peeks: ["Interrupted, rerun pending"],
    bars: 1,
  },
  stopped: { group: "Idle", word: "Idle", peeks: ["Stopped"], bars: 0 },
  remote: { group: "Idle", word: "Idle", peeks: ["Unknown (machine unreachable)"], bars: 0 },
  "remote-native": {
    group: "Idle",
    word: "Idle",
    peeks: ["Unknown (machine unreachable)"],
    bars: 1,
    bar: /Unknown \(machine unreachable\)/,
  },
  // r5 F3: a working parent counts only its child that still works, open or not.
  "working-parent": {
    group: "Working",
    word: "Working · 1 subagent",
    peeks: ["Done", "Working"],
    bars: 2,
    workingBars: 1,
  },
  live: { group: "Working", word: "Working · 1 subagent", peeks: ["Working"], bars: 0 },
};

const checks = {
  headless: true,
  scope:
    "Production threadSubagents verdict, shellModel groups and status words, SubagentsChip and ProviderSubagentBar over simulated shells and records; provider catalogue mocked; no live server",
  cases: [],
};
try {
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [390, 844],
      [1280, 900],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
      await page.locator("[data-fixture]").waitFor();
      const rows = {};
      for (const [id, want] of Object.entries(expected)) {
        const row = page.locator(`[data-row="${id}"]`);
        const group = await row.evaluate((element) =>
          element.closest("[data-group]")?.getAttribute("data-group"),
        );
        assert.equal(group, want.group, `${id} group`);
        assert.equal((await row.locator("[data-row-word]").textContent())?.trim(), want.word);
        const peeks = (await row.locator("[data-peek-label]").allTextContents()).map((text) =>
          text.trim(),
        );
        assert.deepEqual(peeks, want.peeks, `${id} peeks`);
        const bars = (await row.locator("[data-bar]").allTextContents()).map((text) => text.trim());
        assert.equal(bars.length, want.bars, `${id} bars`);
        // The header bar agrees with the list: nothing settled reads Working.
        assert.equal(
          bars.filter((bar) => /Working/.test(bar)).length,
          want.workingBars ?? 0,
          `${id} working bars ${bars}`,
        );
        if (want.bar) for (const bar of bars) assert.match(bar, want.bar, `${id} bar ${bar}`);
        // Selection does not change the count: an unopened row agrees with the open one.
        assert.equal(
          await row.getAttribute("data-unopened-count"),
          await row.getAttribute("data-count"),
          `${id} unopened count`,
        );
        const pulsing = await row.locator('[data-chip] [data-running="true"]').count();
        assert.equal(pulsing, want.word.startsWith("Working") ? 1 : 0, `${id} chip pulse`);
        rows[id] = { word: want.word, peeks, bars };
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
        "no horizontal overflow",
      );
      // Every status word is painted inside the viewport, not clipped away.
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll("[data-row-word], [data-peek-label], [data-bar]")]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width === 0 ||
              rect.right > innerWidth + 1 ||
              element.scrollWidth > element.clientWidth + 1
            );
          })
          .map((element) => element.textContent),
      );
      assert.deepEqual(clipped, [], "clipped status text");
      const shot = join(output, `${theme}-${width}.png`);
      await page.screenshot({ path: shot, fullPage: true, animations: "disabled" });
      // The popover lists the same words as the peeks.
      await page.locator('[data-chip="seo"] button').click();
      const popover = page.getByRole("list", { name: "Subagents" });
      await popover.waitFor();
      const popoverText = await popover.textContent();
      for (const label of expected.seo.peeks) assert.match(popoverText, new RegExp(label));
      assert.doesNotMatch(popoverText, /Working/);
      const popoverShot = join(output, `popover-${theme}-${width}.png`);
      await page.screenshot({ path: popoverShot, animations: "disabled" });
      assert.deepEqual(errors, []);
      checks.cases.push({ theme, width, screenshot: shot, popover: popoverShot, rows });
      await page.close();
    }
  }
  await writeFile(join(output, "checks.json"), JSON.stringify(checks, null, 2));
  console.log(`PASS ${checks.cases.length} cases -> ${output}`);
} finally {
  await browser.close();
  server.close();
}
