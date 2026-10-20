// The Project knowledge card on the Memory tab: what threads receive, how full the
// index is, a search as a thread would run it, and Rebuild index, at 1440 px and 390 px.
// A host whose config has not arrived shows nothing to act on; an older host asks for an update.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
const port = Number(process.env.PROJECT_UI_PORT ?? 5788);
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});

async function openCard(mode, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/${mode === null ? "" : `?knowledge=${mode}`}`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Project settings", { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Memory", exact: true }).click();
  const card = dialog.locator("section", {
    has: page.getByRole("heading", { name: "Project knowledge", exact: true }),
  });
  await card.waitFor();
  return { page, card, errors };
}

// The card stays inside the window and nothing in it spills past its edges. Text kept for
// screen readers only (sr-only, clipped to nothing) paints nothing, so it cannot spill.
async function assertFits(page, card, width) {
  const box = await card.boundingBox();
  NodeAssert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, `card fits ${width} px`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  NodeAssert.ok(overflow <= 0, `no sideways scroll at ${width} px`);
  const spilled = await card.evaluate((section) => {
    const edge = section.getBoundingClientRect();
    return [...section.querySelectorAll("*")]
      .filter((node) => {
        if (node.closest(".sr-only")) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && (rect.left < edge.left - 0.5 || rect.right > edge.right + 0.5);
      })
      .map((node) => `${node.tagName} ${node.textContent.slice(0, 40)}`);
  });
  NodeAssert.deepEqual(spilled, [], `nothing spills out of the card at ${width} px`);
}

// Brings `target` to the top of the settings pane that scrolls it. Only that pane moves:
// scrollIntoView would also scroll the dialog's own clipped box and shift the whole dialog.
async function scrollPaneTo(target) {
  await target.evaluate((node) => {
    let pane = node.parentElement;
    while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
    for (let outer = pane?.parentElement; outer; outer = outer.parentElement) outer.scrollTop = 0;
    if (pane) pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  });
}

// The dialog as a person sees it: the card's top, then its search results.
async function shoot(page, card, name) {
  const dialog = page.getByRole("dialog");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      theme === "dark",
    );
    await scrollPaneTo(card);
    await dialog.screenshot({ path: NodePath.join(output, `${name}-${theme}.png`) });
    await scrollPaneTo(card.getByRole("search"));
    await dialog.screenshot({ path: NodePath.join(output, `${name}-${theme}-search.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

try {
  // The host's config has not arrived: no meter, no buttons, and no claim about the host yet.
  {
    const { page, card, errors } = await openCard(null, { width: 1440, height: 1000 });
    NodeAssert.equal(await card.getByRole("meter").count(), 0);
    NodeAssert.equal(await card.getByRole("button").count(), 0);
    NodeAssert.doesNotMatch(await card.innerText(), /Update SpecWithCode/);
    NodeAssert.deepEqual(errors, []);
    await page.close();
  }

  // A host built before project knowledge: the card names the machine and asks for an update.
  {
    const { page, card, errors } = await openCard("old", { width: 1440, height: 1000 });
    await card
      .getByText("Update SpecWithCode on Development Mac to see this project's knowledge.", {
        exact: true,
      })
      .waitFor();
    NodeAssert.equal(await card.getByRole("meter").count(), 0);
    NodeAssert.equal(await card.getByRole("button").count(), 0);
    NodeAssert.equal(await card.getByRole("search").count(), 0);
    NodeAssert.deepEqual(errors, []);
    await page.close();
  }

  // Threads still receive memory and hub artifacts in full.
  {
    const { page, card, errors } = await openCard("", { width: 1440, height: 1000 });
    const text = await card.innerText();
    NodeAssert.match(text, /Memory sent in full/);
    NodeAssert.match(text, /so Claude and Codex worker threads receive them in full\./);
    NodeAssert.match(text, /Indexed 4m ago\./);
    NodeAssert.match(text, /214 documents, about 493K tokens\. The index is 2% full\./);
    NodeAssert.match(text, /about 3.2K tokens of the 8K threads receive in full/);
    NodeAssert.match(text, /1 file left out: 1 over 2 MB\./);
    const meter = card.getByRole("meter", { name: "Index capacity" });
    NodeAssert.equal(await meter.getAttribute("data-tone"), "ok");
    NodeAssert.deepEqual(
      await card
        .getByRole("list", { name: "Knowledge sources" })
        .getByRole("listitem")
        .allTextContents(),
      [
        "Project memory2 documents · about 2.1K tokens",
        "Hub artifacts3 documents · about 1.1K tokens",
        "Increments186 documents · about 437K tokens",
        "Docs23 documents · about 53K tokens",
      ],
    );
    await card
      .getByRole("searchbox", { name: "Search project knowledge" })
      .fill("storage decision");
    await card.getByRole("button", { name: "Search", exact: true }).click();
    const results = card.getByRole("list", { name: "Search results" });
    await results.waitFor();
    const hits = await results.getByRole("listitem").allInnerTexts();
    NodeAssert.equal(hits.length, 3);
    NodeAssert.match(hits[0], /Project knowledge with automatic search mode/);
    NodeAssert.match(
      hits[0],
      /0927-project-knowledge-retrieval\/spec\.md · Decisions > D-02 Storage/,
    );
    NodeAssert.match(hits[0], /Oct 18, 2026/);
    NodeAssert.match(await card.innerText(), /More passages matched\. Use more specific words\./);
    NodeAssert.equal(
      await card.locator(".sr-only[role='status']").textContent(),
      "3 passages found.",
    );
    NodeAssert.equal(await card.locator("[aria-live]").count(), 0);
    // Rebuild index shows the rebuild at once and stays off until the host answers again.
    const rebuild = card.getByRole("button", { name: "Rebuild index" });
    await rebuild.click();
    await card.locator(".project-knowledge-mode").getByText("Indexing…", { exact: true }).waitFor();
    NodeAssert.ok(await rebuild.isDisabled(), "Rebuild index is off while the index builds");
    NodeAssert.doesNotMatch(await card.innerText(), /Indexed 4m ago/);
    const calls = await page.evaluate(() =>
      window.__projectCalls.map((call) => ({
        command: String(call.command),
        input: call.args?.input,
      })),
    );
    NodeAssert.deepEqual(
      calls.filter((call) => call.command.startsWith("knowledge")),
      [
        { command: "knowledgeSearch", input: { projectId: "project", query: "storage decision" } },
        { command: "knowledgeReindex", input: { projectId: "project" } },
      ],
    );
    await assertFits(page, card, 1440);
    await shoot(page, card, "knowledge-inline-1440");
    NodeAssert.deepEqual(errors, []);
    await page.close();
  }

  // Past that, threads search: the bar warns at 80% and the card says when full sends return.
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const { page, card, errors } = await openCard("search", viewport);
    const text = await card.innerText();
    NodeAssert.match(text, /Search mode/);
    NodeAssert.match(
      text,
      /Worker threads search all project knowledge and read the passages they need\. The coordinator receives a short catalog only\./,
    );
    NodeAssert.doesNotMatch(text, /more than threads can receive in full/);
    // Memory and hub artifacts here (31.4K characters) are past the 24K allowance.
    NodeAssert.match(
      text,
      /Memory files and hub artifacts come to about 10K tokens, past the 8K threads receive in full\. Below 6\.4K they are sent in full again\./,
    );
    NodeAssert.match(text, /The index is 82% full\./);
    NodeAssert.match(text, /5 files left out: 4 over 2 MB, 1 unreadable or protected\./);
    NodeAssert.equal(await card.getByRole("meter").getAttribute("data-tone"), "warn");
    await card.getByRole("searchbox", { name: "Search project knowledge" }).fill("nothing here");
    await card.getByRole("button", { name: "Search", exact: true }).click();
    await card.getByText("Nothing in this project's knowledge matches.").waitFor();
    NodeAssert.doesNotMatch(await card.innerText(), /More passages matched/);
    NodeAssert.equal(
      await card.locator(".sr-only[role='status']").textContent(),
      "Nothing matches.",
    );
    await assertFits(page, card, viewport.width);
    await shoot(page, card, `knowledge-search-${viewport.width}`);
    NodeAssert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`knowledge check passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
