// Build with vp build --config apps/web/tests/overview-1249/vite.config.ts first, then run
// from the repository root. Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/overview-1249/site");
const output = NodePath.resolve(
  process.env.OVERVIEW_EVIDENCE ?? ".artifacts/overview-1249/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) return void res.writeHead(403).end();
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    // Read first: a missing file answers 404 instead of failing after the headers.
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": mime });
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
// Every check is recorded and the run fails once at the end, so one run reports every miss.
const check = (name, ok, detail = "") => {
  receipt.checks.push({ name, ok: Boolean(ok), detail });
};
try {
  // 580 is the content beside the sidebar in the desktop app's 840 px minimum window.
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 1024, 768, 580, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("#studio-heading").waitFor();
      const label = `${theme} ${width}`;
      check(`${label}: no page errors`, errors.length === 0, errors.join("; "));
      // 1398 AC-11: the Overview offers the first feature in one card with one action.
      const offer = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("[data-first-feature-offer]")];
        return {
          cards: cards.length,
          title: cards[0]?.querySelector("h2")?.textContent ?? null,
          actions: [...(cards[0]?.querySelectorAll("[data-first-feature-offer-action]") ?? [])].map(
            (action) => action.textContent?.trim(),
          ),
        };
      });
      check(
        `${label}: the first feature card, its title and its one action`,
        offer.cards === 1 &&
          offer.title === "Build a first feature" &&
          offer.actions.length === 1 &&
          offer.actions[0] === "Try a first feature",
        JSON.stringify(offer),
      );
      const overflow = await page.evaluate(() => {
        const scroller = document.querySelector(".studio-scroll");
        const wide = [...document.querySelectorAll(".studio-content *")].filter(
          (element) => element.getBoundingClientRect().right > window.innerWidth + 1,
        );
        return {
          page: document.documentElement.scrollWidth - window.innerWidth,
          scroller: scroller.scrollWidth - scroller.clientWidth,
          wide: wide.slice(0, 3).map((element) => element.className),
        };
      });
      check(
        `${label}: nothing runs off the side`,
        overflow.page <= 0 && overflow.scroller <= 0 && overflow.wide.length === 0,
        JSON.stringify(overflow),
      );
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll(".studio-desk a, .studio-desk button, .studio-desk input")]
          .filter((element) => {
            const name =
              element.getAttribute("aria-label") ??
              (element.labels?.[0]?.textContent || element.textContent || "").trim();
            return !name;
          })
          .map((element) => element.outerHTML.slice(0, 80)),
      );
      check(
        `${label}: every link and button has a name`,
        unnamed.length === 0,
        unnamed.join(" | "),
      );
      // Percy is its own section after Projects and before Machines, out of the project cards.
      const rail = await page.evaluate(() => {
        const entry = document.querySelector('[aria-labelledby="studio-assistant-title"]');
        const projects = document.querySelector('[aria-labelledby="studio-projects-title"]');
        return {
          entryRows: [...(entry?.querySelectorAll(".studio-project .studio-row-title") ?? [])].map(
            (title) => title.textContent,
          ),
          entryPlaced: Boolean(
            entry &&
            projects &&
            projects.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING &&
            entry.compareDocumentPosition(
              document.querySelector('[aria-labelledby="studio-machines-title"]'),
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          projectTitles: [...(projects?.querySelectorAll(".studio-row-title") ?? [])].map(
            (title) => title.textContent,
          ),
          projectCount: projects?.querySelector(".studio-count")?.textContent ?? null,
        };
      });
      check(
        `${label}: Percy has its own section between Projects and Machines`,
        JSON.stringify(rail.entryRows) === '["Percy"]' && rail.entryPlaced,
        JSON.stringify(rail),
      );
      check(
        `${label}: Percy is not a project card or counted`,
        !rail.projectTitles.includes("Percy") && rail.projectCount === "5",
        JSON.stringify(rail),
      );
      // Its "+" starts a new topic aimed at Percy, and its waiting pill names topics.
      const aideRow = page.locator('[aria-labelledby="studio-assistant-title"] .studio-project');
      check(
        `${label}: Percy's pill shows only its topics`,
        (await aideRow
          .getByRole("button", { name: "Show only topics that need you in Percy" })
          .count()) === 1,
      );
      const newTopic = aideRow.getByRole("button", { name: "New topic in Percy", exact: true });
      check(`${label}: Percy row offers a new topic`, (await newTopic.isEnabled()) === true);
      // Clicked once, where no keyboard check follows on the same page.
      if (theme === "dark" && width === 1440) {
        await newTopic.click();
        const started = await page.evaluate(() => window.__newThreads ?? []);
        check(
          `${label}: a new topic is a draft aimed at Percy`,
          JSON.stringify(started) ===
            JSON.stringify([
              {
                projectRef: { environmentId: "m4", projectId: "aide-m4" },
                options: { environmentSelection: "manual" },
              },
            ]) && (await page.locator("#studio-project").count()) === 0,
          JSON.stringify(started),
        );
      }
      // Machines by nickname and color, chips in words, an unreachable machine explained.
      const names = await page.evaluate(() => ({
        text: document.querySelector(".studio-content").textContent,
        marks: [...document.querySelectorAll(".studio-session-item .studio-machine-mark")].map(
          (mark) => [
            mark.textContent,
            mark.getAttribute("data-machine-color"),
            mark.getAttribute("data-hint"),
          ],
        ),
        chips: [
          ...document.querySelectorAll(
            '[aria-labelledby="studio-working-title"] .studio-session-item',
          ),
        ].map((row) => {
          const pill = row.querySelector(".studio-pill");
          return [pill?.textContent ?? null, pill?.getAttribute("data-hint") ?? null];
        }),
        machines: [...document.querySelectorAll(".studio-machine")].map(
          (row) => row.querySelector(".studio-row-main").textContent,
        ),
      }));
      check(
        `${label}: no host label or command line is printed`,
        !/MacBook M4MAX|M1Max|ministorm|\/Users\/anton/.test(names.text),
        names.text.match(/MacBook M4MAX|M1Max|ministorm|\/Users\/anton/)?.[0] ?? "",
      );
      check(
        `${label}: chat rows name the machine in its color, host label on hover`,
        names.marks.some(
          ([name, color, title]) =>
            name === "linux-mini" && color === "blue" && title === "ministorm",
        ) && names.marks.every(([, color]) => Boolean(color)),
        JSON.stringify(names.marks.slice(0, 4)),
      );
      check(
        `${label}: Working chips say the step in words`,
        JSON.stringify(names.chips.map(([text]) => text?.replace(/ · .*/, "") ?? null)) ===
          JSON.stringify([null, "Running a command", "Waiting on a subagent", "Running a step"]) &&
          names.chips[1][1].startsWith("cd /Users/anton"),
        JSON.stringify(names.chips),
      );
      check(
        `${label}: machines say state, version and work`,
        names.machines.some((row) =>
          /^m4 · this machineOnline · 2 working · 3 projects1\.0\.304 · update available$/.test(
            row,
          ),
        ) &&
          names.machines.some((row) => /^m1Online · .* projects1\.0\.306 · current$/.test(row)) &&
          names.machines.includes("MacBook ProNot answeringChats and projects not counted"),
        JSON.stringify(names.machines),
      );
      const file = NodePath.join(output, `overview-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);
      if (theme === "light" && width === 1440) {
        // J walks the rows; the first lands on the most urgent chat.
        await page.keyboard.press("j");
        const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
        check("J focuses the first Needs you row", focused.includes("Fix Sadiya Datadog"), focused);
        await page.screenshot({ path: NodePath.join(output, "overview-keyboard-focus.png") });
        await page
          .locator(".studio-rail")
          .screenshot({ path: NodePath.join(output, "overview-rail-aide.png") });
        // A machine narrows every list to it.
        await page.locator(".studio-machine button", { hasText: /^m1/ }).click();
        const scope = await page.locator(".studio-scope").textContent();
        check("machine filter names the machine", scope.includes("on m1"), scope);
        const rows = await page.locator(".studio-attention-item").count();
        check("machine filter keeps only its chats", rows === 3, String(rows));
        await page.screenshot({
          path: NodePath.join(output, "overview-machine-filter.png"),
          fullPage: true,
        });
      }
      await page.close();
    }
  }
  // The rail with Percy's own section, at 1280x900 in both themes.
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator("#studio-assistant-title").waitFor();
    const file = NodePath.join(output, `overview-rail-aide-${theme}-1280.png`);
    await page.screenshot({ path: file });
    receipt.screenshots.push(file);
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  await page.goto(`${origin}/?theme=light&data=empty`);
  await page.locator("#studio-heading").waitFor();
  check(
    "empty workspace says nothing needs you",
    (await page.locator("h1").textContent()) === "Nothing needs you",
  );
  await page.screenshot({
    path: NodePath.join(output, "overview-empty-light-1024.png"),
    fullPage: true,
  });
  await page.close();
} finally {
  await browser.close();
  server.close();
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
const failed = receipt.checks.filter((entry) => !entry.ok);
for (const entry of failed) console.error(`FAIL ${entry.name} ${entry.detail}`);
NodeAssert.equal(failed.length, 0, `${failed.length} of ${receipt.checks.length} checks failed`);
console.log(`${receipt.checks.length} checks passed; evidence in ${output}`);
