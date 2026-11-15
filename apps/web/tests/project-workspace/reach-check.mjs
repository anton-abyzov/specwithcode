// Machine reach states: the Threads pane and the chat banner for Build Mac in each state.
// Start serve.mjs first (see README.md). Always headless.
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

const STATES = {
  reconnecting: { words: "Reconnecting to Build Mac…", down: false },
  "not-answering": { words: "Build Mac isn't answering", down: true, row: "Not answering" },
  offline: { words: "Build Mac is offline", down: true, row: "Host offline" },
  "cant-reach": { words: "Can't reach Build Mac", down: true, row: "Can't reach host" },
  "catching-up": { words: "Catching up with Build Mac…", down: false },
};
const groupOf = (page, title) =>
  page.evaluate((title) => {
    for (const section of document.querySelectorAll(".sws-thread-group, section")) {
      const heading = section.querySelector("h3")?.textContent ?? "";
      if ([...section.querySelectorAll(".sws-thread-row")].some((r) => r.textContent.includes(title)))
        return heading.replace(/\d.*$/, "").trim();
    }
    return null;
  }, title);
const results = [];
try {
  for (const [state, expected] of Object.entries(STATES)) {
    for (const scheme of state === "not-answering" ? ["light", "dark"] : ["light"]) {
      const suffix = scheme === "dark" ? "-dark" : "";
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${base}?rows&remote&reach=${state}`);
      await page.locator(".sws-thread-row").first().waitFor();
      const pane = page.locator("aside.project-thread-pane");
      const notice = page.locator("[data-reach-state]");
      await notice.waitFor();
      const noticeText = await notice.innerText();
      NodeAssert.ok(noticeText.includes(expected.words), `${state}: ${noticeText}`);
      const ask = await groupOf(page, "Approve the schema migration");
      const run = await groupOf(page, "Profile the importer");
      const rowText = await page
        .locator(".sws-thread-row", { hasText: "Profile the importer" })
        .innerText();
      if (expected.down) {
        NodeAssert.equal(ask, "Offline", `${state}: ask group ${ask}`);
        NodeAssert.equal(run, "Offline", `${state}: run group ${run}`);
        NodeAssert.ok(rowText.includes(expected.row), `${state}: row ${rowText}`);
        NodeAssert.ok(noticeText.includes("Last answered 4m ago"), `${state}: ${noticeText}`);
        NodeAssert.equal(
          noticeText.includes("DNS or firewall"),
          state === "cant-reach",
          `${state}: hint ${noticeText}`,
        );
      } else {
        NodeAssert.equal(ask, "Needs you", `${state}: ask group ${ask}`);
        NodeAssert.equal(run, "Working", `${state}: run group ${run}`);
        const paneText = await page.locator("body").innerText();
        NodeAssert.ok(!/offline/i.test(paneText.replace(/Offline group/g, "")), `${state}: says offline`);
        NodeAssert.ok(!rowText.includes("Host offline") && !rowText.includes("Not answering"));
      }
      // The pane down to its last row; the empty space below it says nothing.
      const last = await page.locator(".sws-thread-row").last().boundingBox();
      const paneBox = await pane.boundingBox();
      await page.screenshot({
        path: NodePath.join(output, `threads-${state}${suffix}.png`),
        clip: { ...paneBox, height: Math.min(paneBox.height, last.y + last.height + 24 - paneBox.y) },
      });
      await page.close();
      results.push({ state, scheme, notice: noticeText, ask, run, row: rowText.split("\n").join(" · ") });
    }
    if (state === "catching-up") continue; // ChatView shows no machine banner while connected.
    const page = await browser.newPage({ viewport: { width: 1000, height: 420 } });
    await page.goto(`${base}?banner=${state}`);
    const banner = page.locator("[data-reach-banner]");
    await banner.waitFor();
    const text = await banner.innerText();
    NodeAssert.ok(text.includes(expected.words), `banner ${state}: ${text}`);
    if (expected.down) {
      NodeAssert.ok(text.includes("Last answered 4m ago · Retrying by itself"), `banner ${state}: ${text}`);
      NodeAssert.equal(text.includes("DNS or firewall"), state === "cant-reach", `banner ${state}: ${text}`);
    } else {
      NodeAssert.ok(!/offline|Retrying/i.test(text), `banner ${state}: ${text}`);
    }
    await page.locator("main > div").screenshot({ path: NodePath.join(output, `chat-banner-${state}.png`) });
    await page.close();
    results.push({ state, banner: text.split("\n").join(" · ") });
  }
  await NodeFSP.writeFile(NodePath.join(output, "reach-check.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
