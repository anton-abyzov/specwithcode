// Messages another agent sent, on a thread page, at each timeline detail level.
// Build first: vp build --config apps/web/tests/agent-messages/vite.config.ts
// UI_EVIDENCE_DIR must be a new directory. MEASURE_ONLY=1 records what a build shows
// without asserting, for a before capture; AGENT_MESSAGES_SITE serves another build.
// Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR;
NodeAssert.ok(output, "Use a new explicit evidence directory");
await NodeFSP.mkdir(output, { recursive: false });
const measureOnly = process.env.MEASURE_ONLY === "1";
const root = NodePath.resolve(process.env.AGENT_MESSAGES_SITE ?? ".artifacts/agent-messages/site");
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
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});

const VIEWS = [
  { name: "1280", viewport: { width: 1280, height: 900 } },
  { name: "360", viewport: { width: 360, height: 780 } },
];
const errors = [];
const results = [];

// The list renders the end of the thread first; scroll up until the message is there.
async function reveal(page, id) {
  const row = page.locator(`[data-message-id="${id}"]`);
  for (let step = 0; step < 40 && (await row.count()) === 0; step += 1) {
    await page.mouse.move(20, 200);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(80);
  }
  await row.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  return row;
}

async function measure(page, row) {
  return row.evaluate((node) => {
    // A relayed note on this build; the bubble on a build from before it.
    const relay = node.querySelector("[data-relayed-message]");
    const bubble = relay ?? node.querySelector(".bg-message");
    const fold = node.querySelector("[data-worker-message]");
    const clamp = node.querySelector("[data-user-message-collapsible]");
    const spill = [bubble, ...bubble.querySelectorAll("*")].filter(
      (element) =>
        element.scrollWidth > element.clientWidth + 1 &&
        getComputedStyle(element).overflowX === "visible",
    ).length;
    const toggle = [...node.querySelectorAll("button")].find((button) =>
      /Show (full message|more)/.test(button.getAttribute("aria-label") ?? button.innerText),
    );
    return {
      height: Math.round(bubble.getBoundingClientRect().height),
      bubbleWidth: Math.round(bubble.getBoundingClientRect().width),
      text: bubble.innerText,
      workerMessage: fold?.getAttribute("data-worker-message") ?? null,
      clamped: clamp?.getAttribute("data-user-message-collapsed") ?? null,
      toggle: toggle ? (toggle.getAttribute("aria-label") ?? toggle.innerText) : null,
      sentBy: node.innerText.includes("Sent by another agent"),
      relayed: relay?.getAttribute("data-relayed-message") ?? null,
      header: relay?.querySelector("h3")?.innerText ?? null,
      view:
        relay?.querySelector("[data-relayed-message-footer] [data-slot=inline-button]")
          ?.innerText ?? null,
      time: relay?.querySelector("time")?.innerText ?? null,
      background: getComputedStyle(bubble).backgroundColor,
      spill,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

try {
  for (const detail of ["concise", "normal", "verbose"]) {
    for (const view of VIEWS) {
      for (const theme of ["light", "dark"]) {
        const label = `${detail}-${theme}-${view.name}`;
        const context = await browser.newContext({
          viewport: view.viewport,
          colorScheme: theme,
          reducedMotion: "reduce",
          permissions: ["clipboard-read", "clipboard-write"],
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
        await page.route("**/*", (route) =>
          route.request().url().startsWith(origin) ? route.continue() : route.abort(),
        );
        await page.goto(`${origin}/?theme=${theme}&detail=${detail}`);
        await page.locator("main").waitFor();
        const texts = await page.evaluate(() => window.agentMessageTexts);
        const row = await reveal(page, "enospc");
        const result = { label, detail, theme, width: view.name, ...(await measure(page, row)) };
        await page.screenshot({ path: NodePath.join(output, `thread-${label}.png`) });
        const handover = await reveal(page, "handover");
        result.handover = await measure(page, handover);
        result.merge = await measure(page, await reveal(page, "merge"));
        await reveal(page, "enospc");

        const copy = row.getByRole("button", { name: "Copy original message" });
        if ((await copy.count()) > 0) {
          await copy.click();
          await row.getByRole("button", { name: "Original message copied" }).waitFor();
          result.copied =
            (await page.evaluate(() => navigator.clipboard.readText())) === texts.enospc;
        }
        const open = row.getByRole("button", { name: /Show full message/ });
        if (detail !== "verbose" && (await open.count()) > 0) {
          await open.click();
          await page.waitForTimeout(200);
          const opened = await measure(page, row);
          result.openHeight = opened.height;
          result.openWhole = opened.text.includes("pr374-about-correction.md retained.");
          if (detail === "concise")
            await page.screenshot({ path: NodePath.join(output, `thread-${label}-open.png`) });
        }
        results.push(result);
        await context.close();

        if (measureOnly) continue;
        // Each relayed message is a quiet note naming its sender, with a link back and a time.
        NodeAssert.equal(result.relayed, "thread", `${label}: from another thread`);
        NodeAssert.equal(result.header, "Message from another thread", label);
        NodeAssert.equal(result.view, "View thread", label);
        NodeAssert.ok(result.time, `${label}: time`);
        NodeAssert.equal(result.background, "rgba(0, 0, 0, 0)", `${label}: no bubble`);
        NodeAssert.equal(result.handover.relayed, "coordinator", label);
        NodeAssert.equal(result.handover.header, "Message from coordinator", label);
        NodeAssert.equal(result.handover.view, "View coordinator", label);
        NodeAssert.equal(result.merge.relayed, "agent", label);
        NodeAssert.equal(result.merge.view, null, `${label}: no thread to link`);
        NodeAssert.equal(result.clamped, null, `${label}: not the person's clamp`);
        NodeAssert.equal(result.copied, true, `${label}: exact copy`);
        NodeAssert.equal(result.page, 0, `${label}: no sideways scroll`);
        NodeAssert.equal(result.spill, 0, `${label}: nothing spills out of the bubble`);
        if (detail === "verbose") {
          NodeAssert.equal(result.workerMessage, "open", `${label}: Verbose opens it`);
          NodeAssert.ok(result.text.includes("pr374-about-correction.md retained."), label);
          NodeAssert.equal(result.handover.workerMessage, "open", `${label}: handover open`);
          NodeAssert.equal(result.merge.workerMessage, null, `${label}: a mid-length one is whole`);
          continue;
        }
        NodeAssert.equal(result.workerMessage, "folded", `${label}: folded`);
        NodeAssert.match(
          result.toggle,
          /^Message from another thread\. Show full message, [\d,]+ more characters$/,
          label,
        );
        NodeAssert.ok(result.text.includes("Exactspec /Users/fixture/Projects/atlas/"), label);
        NodeAssert.ok(!result.text.includes("no space left on device"), `${label}: lead only`);
        NodeAssert.ok(result.openWhole, `${label}: Show full message opens the original`);
        NodeAssert.ok(result.openHeight > result.height, `${label}: opening grows`);
        NodeAssert.equal(result.handover.workerMessage, "folded", `${label}: handover folded`);
        // Concise folds sooner: a mid-length message folds there and shows whole in Normal.
        NodeAssert.equal(
          result.merge.workerMessage,
          detail === "concise" ? "folded" : null,
          `${label}: mid-length message`,
        );
        NodeAssert.ok(result.merge.text.includes("Merged #509 and #186."), label);
      }
    }
  }
  // `?new`: the "New" divider sits above the first message since the last visit.
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: VIEWS[0].viewport,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`new-${theme}: ${error.message}`));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}&detail=normal&new`);
    await page.locator("main").waitFor();
    const row = page.locator('[data-message-id="reminder"]');
    await row.waitFor();
    await page.waitForTimeout(300);
    const dividers = await page.locator("[data-new-messages-divider]").count();
    const above = await row.locator("[data-new-messages-divider]").count();
    results.push({ label: `new-${theme}`, dividers, above });
    await page.screenshot({ path: NodePath.join(output, `thread-new-${theme}-1280.png`) });
    await context.close();
    if (measureOnly) continue;
    NodeAssert.equal(dividers, 1, `new-${theme}: one divider`);
    NodeAssert.equal(above, 1, `new-${theme}: above the coordinator's reminder`);
  }
  // Concise is never taller than Normal, and the three messages together are shorter.
  if (!measureOnly) {
    for (const view of VIEWS)
      for (const theme of ["light", "dark"]) {
        const find = (detail) =>
          results.find((r) => r.detail === detail && r.width === view.name && r.theme === theme);
        const total = (r) => r.height + r.handover.height + r.merge.height;
        NodeAssert.ok(find("concise").height <= find("normal").height, `${view.name}-${theme}`);
        NodeAssert.ok(total(find("concise")) < total(find("normal")), `${view.name}-${theme}`);
      }
    NodeAssert.deepEqual(errors, [], "no page errors");
  }
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "agent-messages-check.json"),
    `${JSON.stringify({ headless: true, measureOnly, site: root, results, errors }, null, 2)}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(
  JSON.stringify(
    results.map(
      ({ label, height, openHeight, workerMessage, clamped, copied, merge, dividers }) => ({
        label,
        height,
        openHeight,
        workerMessage,
        clamped,
        copied,
        merge: merge ? (merge.workerMessage ?? merge.clamped ?? "whole") : undefined,
        dividers,
      }),
    ),
  ),
);
