import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
await NodeFSP.mkdir(output, { recursive: true });
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE ?? undefined;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const base = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}/`;
// With threads on two machines (`?rows`) every row names its machine, short and quiet,
// and the machine gives way before the provider and model. One machine names none.
try {
  const results = [];
  for (const [width, scheme] of [
    [1440, "light"],
    [1440, "dark"],
    [1100, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    await page.goto(`${base}?rows`);
    await page.locator(".sws-thread-row").first().waitFor();
    const rows = await page.$$eval(".sws-thread-row", (articles) =>
      articles.map((article) => {
        const machine = article.querySelector(".sws-thread-machine");
        const provider = article.querySelector(".sws-model-provider");
        return {
          id: article.getAttribute("data-thread-id"),
          machine: machine?.querySelector("span[aria-hidden='true']")?.textContent ?? null,
          title: machine?.querySelector(".sr-only")?.textContent ?? null,
          execution: machine?.getAttribute("data-execution") ?? null,
          providerClipped: provider ? provider.scrollWidth > provider.clientWidth + 1 : null,
        };
      }),
    );
    for (const row of rows) {
      NodeAssert.ok(row.machine, `${row.id} names its machine at ${width}px`);
      NodeAssert.ok(row.title, `${row.id} keeps the full machine name on hover`);
      NodeAssert.equal(row.providerClipped, false, `${row.id} keeps its provider whole`);
    }
    // A thread names where it lives and where it runs once they differ.
    const moved = rows.find((row) => row.id === "moved-worker");
    NodeAssert.match(moved?.machine ?? "", / → Minis$/u, "a moved thread names both machines");
    NodeAssert.match(moved?.title ?? "", /^Lives on .+ · runs on Anton's Minis$/u);
    const unknown = rows.find((row) => row.id === "unknown-worker");
    NodeAssert.equal(unknown?.execution, "unknown");
    NodeAssert.match(unknown?.title ?? "", /· Unknown · Anton's Minis last seen /u);
    const boxes = await page.$$eval(".sws-thread-list", (lists) =>
      lists.map((list) => list.getBoundingClientRect().toJSON()),
    );
    const top = Math.min(...boxes.map((box) => box.top)) - 40;
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const { left, width: listWidth } = boxes[0];
    await page.screenshot({
      path: NodePath.join(output, `machine-label-${width}-${scheme}.png`),
      clip: { x: left - 8, y: top, width: listWidth + 16, height: bottom - top + 8 },
    });
    if (width === 1440) {
      await page.locator("[data-thread-id='moved-worker'] .sws-thread-machine").hover();
      await page.locator("[data-slot='tooltip-popup']").waitFor();
      await page.screenshot({
        path: NodePath.join(output, `machine-label-moved-tooltip-${scheme}.png`),
        clip: { x: left - 8, y: top, width: listWidth + 16, height: bottom - top + 48 },
      });
    }
    results.push({ width, scheme, rows });
    await page.close();
  }
  const single = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await single.goto(base);
  await single.locator(".sws-thread-row").first().waitFor();
  NodeAssert.equal(await single.locator(".sws-thread-machine").count(), 0, "one machine, no tags");
  await single.close();
  await NodeFSP.writeFile(
    NodePath.join(output, "machine-label.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(`machine labels ok; evidence in ${output}`);
} finally {
  await browser.close();
}
