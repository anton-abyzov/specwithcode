// Build first: vp build --config apps/web/tests/composer-foot/vite.config.ts
// Usage: node apps/web/tests/composer-foot/verify.mjs [/absolute/evidence-dir] [--before]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// --before only shoots: the old composer fails these checks on purpose.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const args = process.argv.slice(2);
const before = args.includes("--before");
const label = before ? "before" : "after";
const output = path.resolve(
  args.find((a) => !a.startsWith("--")) ?? ".artifacts/composer-foot/evidence",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/composer-foot/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});

/** What a person sees on each composer's bottom line, measured in the page. */
function measure() {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const cut = (el) => el.scrollWidth > el.clientWidth + 1;
  const words = (el) =>
    [...el.querySelectorAll("*")]
      .filter((node) => node.childNodes.length && [...node.childNodes].some((c) => c.nodeType === 3))
      .filter((node) => visible(node) && !node.closest(".sr-only"))
      .map((node) =>
        [...node.childNodes]
          .filter((c) => c.nodeType === 3)
          .map((c) => c.textContent)
          .join("")
          .trim(),
      )
      .filter(Boolean)
      .join(" ");
  const edge = (pane) => {
    if (!pane) return null;
    const after = getComputedStyle(pane, "::after");
    return {
      color: pane.getAttribute("data-machine-color"),
      background: after.backgroundColor,
      width: after.width,
      content: after.content,
    };
  };
  const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
  const out = { thread: null, coordinator: null };
  const threadPane = document.querySelector('[data-project-pane="threads"]');
  if (threadPane) {
    const chip = threadPane.querySelector("[data-thread-machine-chip]");
    const footer = threadPane.querySelector('[data-chat-composer-footer="true"]');
    const picker = threadPane.querySelector("[data-chat-provider-model-picker]");
    const modelText = [...(picker?.querySelectorAll("*") ?? [])].find(
      (node) => node.childElementCount === 0 && /Opus/.test(node.textContent ?? "") && visible(node),
    );
    const main = threadPane.querySelector("[data-chat-composer-main-surface]");
    const host = threadPane.querySelector('[data-slot="composer-host"]');
    const outline = (el) => {
      const style = getComputedStyle(el, "::after");
      return style.display === "none" ? null : { border: style.borderTopColor, shadow: style.boxShadow };
    };
    out.thread = {
      chipWords: chip ? words(chip) : null,
      chipCompact: chip?.hasAttribute("data-machine-compact") ?? false,
      chipShortShows: visible(chip?.querySelector("[data-machine-short]")),
      chipNameShows: visible(chip?.querySelector("[data-thread-machine-name]")),
      chipNameCut: chip ? cut(chip.querySelector("[data-thread-machine-name]")) : null,
      chipLabel: chip?.getAttribute("aria-label") ?? null,
      chipTop: top(chip),
      modelTop: top(picker),
      model: modelText?.textContent ?? null,
      modelCut: modelText ? cut(modelText) : null,
      voiceWords: threadPane.querySelector("[data-composer-voice-menu]")?.textContent ?? null,
      voiceLabel: threadPane.querySelector("[data-composer-voice-menu]")?.getAttribute("aria-label") ?? null,
      skillsWords: threadPane.querySelector("[data-testid=composer-skills-trigger]")?.textContent ?? null,
      skillsLabel:
        threadPane.querySelector("[data-testid=composer-skills-trigger]")?.getAttribute("aria-label") ??
        null,
      footerOverflow: footer ? footer.scrollWidth - footer.clientWidth : null,
      footerWords: footer ? words(footer) : null,
      outline: [host, main].map((el) => (el ? outline(el) : null)).find(Boolean) ?? null,
      edge: edge(threadPane),
    };
  }
  const coordinatorPane = document.querySelector('[data-project-pane="coordinator"]');
  if (coordinatorPane) {
    const foot = coordinatorPane.querySelector(".sws-composer-foot");
    const chip = coordinatorPane.querySelector("[data-coordinator-machine]");
    const model = coordinatorPane.querySelector("[data-coordinator-composer-controls] button");
    const state = coordinatorPane.querySelector(".sws-state");
    const chipName = chip?.querySelector(".sws-host-name");
    const modelText = [...(model?.querySelectorAll("*") ?? [])].find(
      (node) => node.childElementCount === 0 && /Opus/.test(node.textContent ?? "") && visible(node),
    );
    out.coordinator = {
      chipWords: chip ? words(chip) : null,
      chipCut: chipName ? cut(chipName) : null,
      chipLabel: chip?.getAttribute("aria-label") ?? null,
      chipTop: top(chip),
      modelTop: top(model),
      modelWords: model ? words(model) : null,
      modelCut: modelText ? cut(modelText) : null,
      stateWords: state ? words(state) : null,
      voiceWords: coordinatorPane.querySelector("[data-composer-voice-menu]")?.textContent ?? null,
      footOverflow: foot ? foot.scrollWidth - foot.clientWidth : null,
      footWords: foot ? words(foot) : null,
      edge: edge(coordinatorPane),
    };
  }
  return out;
}

const SCENES = [
  { name: "window", width: 1440, height: 760 },
  { name: "window", width: 1100, height: 720 },
  { name: "window", width: 860, height: 720 },
  { name: "thread", width: 600, height: 520 },
  { name: "thread", width: 390, height: 520 },
  { name: "coordinator", width: 600, height: 520 },
  { name: "coordinator", width: 390, height: 520 },
];
const results = [];
const errors = [];
try {
  for (const theme of ["dark", "light"]) {
    for (const scene of SCENES) {
      for (const banner of scene.name === "coordinator" ? [false] : [false, true]) {
        const page = await browser.newPage({
          viewport: { width: scene.width, height: scene.height },
          deviceScaleFactor: 2,
          colorScheme: theme,
        });
        page.on("pageerror", (error) => errors.push(`${scene.name}: ${error.message}`));
        await page.goto(
          `${origin}/?scene=${scene.name}&theme=${theme}${banner ? "&banner=1" : ""}`,
        );
        await page.locator('[data-project-pane]').first().waitFor();
        await page.waitForTimeout(400);
        const facts = await page.evaluate(measure);
        const tag = `${label}-${scene.name}-${scene.width}-${theme}${banner ? "-banner" : ""}`;
        await page.screenshot({ path: path.join(output, `${tag}.png`) });
        results.push({ tag, ...facts });
        if (!before) check(tag, facts, scene);
        await page.close();
      }
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
} finally {
  await fs.writeFile(path.join(output, `${label}.json`), JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
}
console.log(`composer-foot ${label}: ${results.length} scenarios, screenshots in ${output}`);

function check(tag, facts, scene) {
  const { thread, coordinator } = facts;
  if (thread) {
    // AC-02: "Runs on <machine>" reads in full at every width.
    assert.equal(thread.chipWords, "Runs on linux-mini", `${tag}: chip says ${thread.chipWords}`);
    assert.ok(!thread.chipCompact && thread.chipNameShows, `${tag}: the machine name is hidden`);
    assert.equal(thread.chipNameCut, false, `${tag}: the machine name is cut`);
    assert.match(thread.chipLabel ?? "", /Runs on linux-mini/, `${tag}: chip label`);
    // AC-03: the model's name reads in full, right beside the machine.
    assert.equal(thread.model, "Opus 5.5", `${tag}: model shows ${thread.model}`);
    assert.equal(thread.modelCut, false, `${tag}: the model name is cut`);
    assert.ok(
      Math.abs(thread.chipTop - thread.modelTop) <= 6,
      `${tag}: machine at ${thread.chipTop}, model at ${thread.modelTop}`,
    );
    // AC-04: voice and skills are icons; their names keep the words. A phone-width
    // window uses the compact composer, which has no footer, voice or skills button.
    if (thread.footerWords !== null) {
      assert.equal(thread.voiceWords, "", `${tag}: voice says ${thread.voiceWords}`);
      assert.equal(thread.voiceLabel, "Voice");
      assert.equal(thread.skillsWords, "", `${tag}: skills says ${thread.skillsWords}`);
      assert.match(thread.skillsLabel ?? "", /^Skills: \d+ total$/);
      assert.ok(thread.footerOverflow <= 1, `${tag}: the footer scrolls by ${thread.footerOverflow}px`);
    } else {
      assert.equal(thread.voiceWords, null, `${tag}: compact composer shows voice`);
    }
    // AC-07: the message box keeps the machine's border, banner or not.
    assert.ok(thread.outline, `${tag}: no outline drawn`);
    assert.match(thread.outline.shadow, /inset/, `${tag}: the machine edge is gone (${thread.outline.shadow})`);
    // AC-06: the pane wears its machine on its leading edge.
    assert.equal(thread.edge.color, "blue");
    assert.equal(thread.edge.width, "2px");
  }
  if (coordinator) {
    assert.equal(coordinator.chipWords, "Runs on m4", `${tag}: coordinator chip says ${coordinator.chipWords}`);
    assert.equal(coordinator.chipCut, false, `${tag}: the coordinator's machine name is cut`);
    assert.equal(coordinator.voiceWords, "", `${tag}: voice says ${coordinator.voiceWords}`);
    // AC-05: the run state is a dot unless it needs the person.
    assert.equal(coordinator.stateWords, "", `${tag}: state says ${coordinator.stateWords}`);
    // The machine and the model share the first row.
    assert.ok(
      Math.abs(coordinator.chipTop - coordinator.modelTop) <= 6,
      `${tag}: machine at ${coordinator.chipTop}, model at ${coordinator.modelTop}`,
    );
    assert.match(coordinator.modelWords ?? "", /Opus 5\.5/, `${tag}: model says ${coordinator.modelWords}`);
    assert.equal(coordinator.modelCut, false, `${tag}: the coordinator's model name is cut`);
    assert.ok(coordinator.footOverflow <= 1, `${tag}: the foot scrolls by ${coordinator.footOverflow}px`);
    assert.equal(coordinator.edge.color, "rose");
    assert.equal(coordinator.edge.width, "2px");
  }
  if (thread && coordinator) {
    assert.notEqual(thread.edge.background, coordinator.edge.background, `${tag}: one color for two machines`);
  }
}
