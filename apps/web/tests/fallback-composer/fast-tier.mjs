// Headless check of the Fast service tier in the composer's effort control: the bolt
// beside the effort level, its accessible name and tooltip, the bolted menu row, and
// switching Standard and Fast, next to a fallback mark, narrow and wide, both themes.
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/fallback-composer/vite.config.ts
// Run: STUDIO_PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node apps/web/tests/fallback-composer/fast-tier.mjs <evidence-dir>
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/fallback-composer/fast-tier");
await NodeFSP.mkdir(output, { recursive: true });
const root = NodePath.resolve(".artifacts/fallback-composer/site");
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const file = NodePath.resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"),
    );
    NodeAssert.ok(file.startsWith(root + NodePath.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html",
    );
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE,
});
const receipt = { headless: true, checks: [], screenshots: [] };
const check = (name, fn) => {
  fn();
  receipt.checks.push(name);
};
const shot = async (page, name, locator) => {
  const file = NodePath.join(output, `${name}.png`);
  await (locator ?? page).screenshot({ path: file });
  receipt.screenshots.push(file);
};

// The composer also mounts hidden copies to measure fits; only the visible control counts.
const trigger = (page) =>
  page.locator("[data-composer-shortcut='composer.effort']").filter({ visible: true }).first();
const readTrigger = (page) =>
  trigger(page).evaluate((el) => {
    const bolt = el.querySelector("[data-composer-control-speed] svg");
    const fallback = [...document.querySelectorAll("[data-model-state='fallback'] svg")].find(
      (svg) => svg.getBoundingClientRect().width > 0 && svg.checkVisibility(),
    );
    const box = bolt?.getBoundingClientRect();
    return {
      aria: el.getAttribute("aria-label"),
      bolt: bolt
        ? { width: box.width, height: box.height, color: getComputedStyle(bolt).color }
        : null,
      fallbackColor: fallback ? getComputedStyle(fallback).color : null,
      text: el.textContent,
      effortGlyph: !!el.querySelector("[data-composer-control-icon]"),
    };
  });
const composer = (page) => page.locator("[data-fixture-composer]").first();
const readMenu = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("[role='menuitemradio']")];
    const row = (label) => rows.find((r) => r.textContent.trim().startsWith(label));
    const fastRow = row("Fast");
    const standardRow = row("Standard");
    return {
      fastGlyph: !!fastRow?.querySelector("[data-trait-speed-glyph='fast'] svg"),
      fastChecked: fastRow?.getAttribute("aria-checked"),
      fastName: fastRow?.textContent ?? "",
      standardChecked: standardRow?.getAttribute("aria-checked"),
      standardGlyph: !!standardRow?.querySelector("[data-trait-speed-glyph] svg"),
      lowEffortGlyph: !!row("Low")?.querySelector("svg"),
      // Each row's words start at the same x as the others in its group.
      labelX: Object.fromEntries(
        ["Low", "Standard", "Fast"].map((label) => {
          const r = row(label);
          const text = [...(r?.querySelectorAll("span") ?? [])].find(
            (span) => span.childNodes[0]?.nodeValue?.trim() === label,
          );
          return [label, text ? Math.round(text.getBoundingClientRect().left) : null];
        }),
      ),
    };
  });
const menuItem = (page, label) =>
  page.locator("[role='menuitemradio']", { hasText: new RegExp(`^${label}`) }).first();

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [360, 520, 900]) {
      const page = await browser.newPage({
        viewport: { width: Math.max(width, 1024), height: 760 },
        colorScheme: theme,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?case=fallback&tier=fast&theme=${theme}&width=${width}`,
      );
      await page.locator('[data-fixture-ready="true"]').waitFor();
      const tag = `${theme} ${width}px`;
      const wide = (await trigger(page).count()) > 0;

      if (wide) {
        const fast = await readTrigger(page);
        check(`${tag}: Fast draws a bolt beside the effort bars`, () => {
          NodeAssert.ok(fast.bolt, "bolt rendered");
          NodeAssert.ok(fast.effortGlyph, "effort bars still rendered");
          NodeAssert.ok(
            fast.bolt.width >= 11 && fast.bolt.width <= 17,
            `bolt ${fast.bolt.width}px`,
          );
          NodeAssert.doesNotMatch(fast.text, /Fast/, "speed is a bolt, not a word");
        });
        check(`${tag}: control is named with effort and tier`, () =>
          NodeAssert.equal(fast.aria, "Medium effort · Fast service tier"),
        );
        check(`${tag}: bolt is not the fallback amber`, () => {
          NodeAssert.ok(fast.fallbackColor, "fallback mark present beside it");
          NodeAssert.notEqual(fast.bolt.color, fast.fallbackColor);
        });
        await shot(page, `composer-fast-${width}-${theme}`, composer(page));

        await trigger(page).hover();
        const tip = page.locator("[data-slot='tooltip-popup']", { hasText: "service tier" });
        await tip.waitFor({ timeout: 3000 });
        const tipText = (await tip.textContent()) ?? "";
        check(`${tag}: tooltip names the Fast service tier`, () =>
          NodeAssert.equal(tipText.trim(), "Medium effort · Fast service tier"),
        );
        await shot(page, `composer-fast-tooltip-${width}-${theme}`);
      } else {
        await shot(page, `composer-fast-${width}-${theme}`, composer(page));
      }

      // Narrow composers fold reasoning and speed into the More menu.
      const open = wide
        ? () => trigger(page).click()
        : () => page.getByRole("button", { name: "More composer controls" }).click();
      await open();
      await menuItem(page, "Fast").waitFor();
      const menu = await readMenu(page);
      check(`${tag}: menu bolts the Fast row only, checked`, () => {
        NodeAssert.equal(menu.fastGlyph, true);
        NodeAssert.equal(menu.fastChecked, "true");
        NodeAssert.equal(menu.standardGlyph, false);
        NodeAssert.equal(menu.lowEffortGlyph, true);
        NodeAssert.doesNotMatch(menu.fastName, /mode on/, "row named once");
        NodeAssert.equal(menu.labelX.Standard, menu.labelX.Fast, "Standard and Fast line up");
        NodeAssert.equal(menu.labelX.Fast, menu.labelX.Low, "tiers line up with effort rows");
      });
      await page.waitForTimeout(300);
      await shot(page, `menu-fast-${width}-${theme}`);

      await menuItem(page, "Standard").click();
      await page.waitForTimeout(200);
      if (wide) {
        const standard = await readTrigger(page);
        check(`${tag}: Standard drops the bolt and the tier words`, () => {
          NodeAssert.equal(standard.bolt, null);
          NodeAssert.equal(standard.aria, "Medium effort");
        });
        await shot(page, `composer-standard-${width}-${theme}`, composer(page));
      }
      await open();
      await menuItem(page, "Standard").waitFor();
      const afterStandard = await readMenu(page);
      check(`${tag}: Standard is checked after switching`, () => {
        NodeAssert.equal(afterStandard.standardChecked, "true");
        NodeAssert.equal(afterStandard.fastChecked, "false");
      });
      await page.waitForTimeout(300);
      await shot(page, `menu-standard-${width}-${theme}`);
      await menuItem(page, "Fast").click();
      await page.waitForTimeout(200);
      if (wide) {
        await trigger(page).locator("[data-composer-control-speed] svg").waitFor();
        const back = await readTrigger(page);
        check(`${tag}: picking Fast again brings the bolt back`, () =>
          NodeAssert.equal(back.aria, "Medium effort · Fast service tier"),
        );
      } else {
        await open();
        await menuItem(page, "Fast").waitFor();
        const again = await readMenu(page);
        check(`${tag}: picking Fast again checks it`, () =>
          NodeAssert.equal(again.fastChecked, "true"),
        );
        await page.keyboard.press("Escape");
      }
      check(`${tag}: no page errors`, () => NodeAssert.deepEqual(errors, []));
      await page.close();
    }
  }
  // The coordinator composer and the project details pane draw the coordinator's effort
  // inside .sws-model-pick, whose CSS drops generic control icons; the bolt must stay.
  const coordinatorTrigger = (page) =>
    page.locator(".sws-model-pick .sws-effort-trigger").filter({ visible: true }).first();
  const readCoordinator = (page) =>
    coordinatorTrigger(page).evaluate((el) => {
      const bolt = el.querySelector("[data-composer-control-speed] svg");
      const box = bolt?.getBoundingClientRect();
      const meter = el.querySelector("svg[data-effort-glyph]");
      return {
        aria: el.getAttribute("aria-label"),
        bolt: bolt && bolt.checkVisibility() ? { width: box.width, height: box.height } : null,
        boltInDom: !!bolt,
        meter: !!meter && meter.checkVisibility(),
        text: el.textContent,
      };
    });
  for (const surface of ["coordinator", "details"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [360, 520, 900]) {
        const page = await browser.newPage({
          viewport: { width: Math.max(width, 1024), height: 760 },
          colorScheme: theme,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(
          `http://127.0.0.1:${server.address().port}/?surface=${surface}&case=idle&tier=fast&theme=${theme}&width=${width}`,
        );
        await page.locator('[data-fixture-ready="true"]').waitFor();
        const tag = `${surface} ${theme} ${width}px`;
        await coordinatorTrigger(page).waitFor();
        const fast = await readCoordinator(page);
        check(`${tag}: coordinator effort shows the bolt beside the meter`, () => {
          NodeAssert.ok(fast.boltInDom, "bolt rendered");
          NodeAssert.ok(fast.bolt, "bolt visible, not hidden by the coordinator CSS");
          NodeAssert.ok(fast.meter, "effort meter still visible");
          NodeAssert.ok(
            fast.bolt.width >= 11 && fast.bolt.width <= 17,
            `bolt ${fast.bolt.width}px`,
          );
          NodeAssert.doesNotMatch(fast.text, /Fast/, "speed is a bolt, not a word");
          NodeAssert.equal(fast.aria, "Coordinator effort: Medium effort · Fast service tier");
        });
        await shot(page, `${surface}-fast-${width}-${theme}`, composer(page));

        await coordinatorTrigger(page).click();
        await menuItem(page, "Fast").waitFor();
        const menu = await readMenu(page);
        check(`${tag}: coordinator menu bolts the Fast row only, checked`, () => {
          NodeAssert.equal(menu.fastGlyph, true);
          NodeAssert.equal(menu.fastChecked, "true");
          NodeAssert.equal(menu.standardGlyph, false);
          NodeAssert.equal(menu.labelX.Standard, menu.labelX.Fast, "Standard and Fast line up");
        });
        await page.waitForTimeout(300);
        await shot(page, `${surface}-menu-fast-${width}-${theme}`);
        await menuItem(page, "Standard").click();
        await page.waitForTimeout(200);
        const standard = await readCoordinator(page);
        check(`${tag}: Standard drops the coordinator bolt`, () => {
          NodeAssert.equal(standard.boltInDom, false);
          NodeAssert.equal(standard.aria, "Coordinator effort: Medium effort");
        });
        await shot(page, `${surface}-standard-${width}-${theme}`, composer(page));
        check(`${tag}: no page errors`, () => NodeAssert.deepEqual(errors, []));
        await page.close();
      }
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "fast-tier-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(`fast tier ok: ${receipt.checks.length} checks; evidence in ${output}`);
} finally {
  await browser.close();
  server.close();
}
