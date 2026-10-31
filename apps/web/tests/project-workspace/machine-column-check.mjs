// Run against serve.mjs. In a project on several machines (`?rows`) every row's
// machine sits in one aligned column beside the age, the sort menu narrows the
// list to one machine with a dismissible "On <machine>" pill, and a narrow pane
// keeps only the icon and the name's first letters. MACHINE_MEASURE_ONLY=1 records what a
// build shows instead of asserting, for a before capture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR ?? process.env.PROJECT_UI_OUTPUT;
NodeAssert.ok(output, "Set UI_EVIDENCE_DIR to an evidence directory");
const base = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}/`;
const measureOnly = process.env.MACHINE_MEASURE_ONLY === "1";
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const receipt = {};
const check = (ok, message) => {
  if (!measureOnly) NodeAssert.ok(ok, message);
  else if (!ok) (receipt.failures ??= []).push(message);
};
const listShot = async (page, name) => {
  const box = await page.locator(".sws-threads-body").boundingBox();
  await page.screenshot({ path: NodePath.join(output, `${name}.png`), clip: box });
};
const machineLefts = (page) =>
  page.$$eval(".sws-thread-row .sws-thread-machine", (chips) =>
    chips.map((chip) => Math.round(chip.getBoundingClientRect().left)),
  );
try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
    });
    await page.goto(`${base}?rows`);
    await page.locator(".sws-thread-row").first().waitFor();
    const lefts = await machineLefts(page);
    receipt[`${scheme}-lefts`] = lefts;
    check(lefts.length > 1 && new Set(lefts).size === 1, `machines line up: ${lefts}`);
    await listShot(page, `machine-column-${scheme}`);
    if (scheme === "light") {
      // Pointer actions hang this fixture page (its sort menu did before this change too),
      // so the filter is chosen the way a reload restores it: from local storage. The
      // menu itself is covered by ThreadsPane unit tests.
      const rows = await page.$$eval(".sws-thread-row", (articles) =>
        articles.map((a) => ({
          env: a.getAttribute("data-thread-environment"),
          machine: a.querySelector(".sws-thread-machine")?.getAttribute("data-machine-id"),
        })),
      );
      const home = rows[0].env;
      const other = rows.find((row) => row.machine && row.machine !== home)?.machine;
      check(other !== undefined, "the fixture has a thread on another machine");
      await page.evaluate(
        ([home, other]) =>
          localStorage.setItem(
            "studio:project-threads-machine:v1",
            JSON.stringify({ [`${home}:project`]: other }),
          ),
        [home, other],
      );
      await page.reload();
      await page.locator(".sws-thread-row").first().waitFor();
      const pill = page.locator("[data-machine-filter-pill]");
      check((await pill.count()) === 1, "a chosen machine shows its pill");
      const after = await page.locator(".sws-thread-row").count();
      receipt.filtered = { before: rows.length, after, home, other };
      check(
        after > 0 && after < rows.length,
        `the filter narrows the list: ${rows.length} → ${after}`,
      );
      await listShot(page, "machine-filter-on");
      if ((await pill.count()) === 1) {
        // A pointer click hangs this fixture page; the DOM click is the same button press.
        await page.evaluate(() =>
          document.querySelector("[data-machine-filter-pill] button").click(),
        );
        check(
          (await page.locator(".sws-thread-row").count()) === rows.length,
          "Show all brings every thread back",
        );
      }
    }
    await page.close();
  }
  // A pane narrower than 360 px keeps the icon and two letters, whatever the window.
  const narrow = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await narrow.goto(`${base}?rows`);
  await narrow.locator(".sws-thread-row").first().waitFor();
  await narrow.evaluate(() => {
    const body = document.querySelector(".sws-threads-body");
    body.style.width = "330px";
    body.style.flex = "none";
  });
  await narrow.waitForTimeout(200);
  const widths = await narrow.$$eval(".sws-thread-row .sws-thread-machine", (chips) =>
    chips.map((chip) => Math.round(chip.getBoundingClientRect().width)),
  );
  receipt.narrowWidths = widths;
  check(
    widths.every((width) => width <= 48),
    `a narrow pane keeps the column small: ${widths}`,
  );
  await listShot(narrow, "machine-column-narrow");
  await narrow.close();
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "machine-column.json"),
    JSON.stringify(receipt, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(receipt));
