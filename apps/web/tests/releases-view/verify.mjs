// Headless check of the Releases view on the fixture run records: the stage graph and both machine
// tables render, nothing overflows the page, at desktop and phone widths, light and dark; and
// Speed by version over synthetic timings, and with none.
// Screenshots go to argv[2] (default .artifacts/releases-view).
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createServer } from "vite";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const out = NodePath.resolve(
  process.argv[2] ?? NodePath.join(here, "../../../../.artifacts/releases-view"),
);
NodeFS.mkdirSync(out, { recursive: true });

const server = await createServer({
  configFile: NodePath.join(here, "vite.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  channel: process.env.STUDIO_PLAYWRIGHT_CHANNEL || "chrome",
});
const failures = [];
try {
  for (const [name, query, width, theme] of [
    ["held", "", 1280, "light"],
    ["held", "", 1280, "dark"],
    ["live", "&live=1", 1280, "light"],
    ["released", "&run=f00dfeed0189", 1280, "light"],
    ["held", "", 390, "light"],
    ["held", "", 390, "dark"],
    ["real", "&real=1", 1440, "light"],
    ["real", "&real=1", 1280, "light"],
    ["real", "&real=1", 1024, "light"],
    ["real", "&real=1", 390, "light"],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?theme=${theme}${query}`, { timeout: 240_000 });
    await page.locator("[data-releases-view]").waitFor({ timeout: 60_000 });
    const facts = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stages: [...document.querySelectorAll("[data-stage]")].map((node) => [
        node.getAttribute("data-stage"),
        node.getAttribute("data-state"),
      ]),
      hosts: [...document.querySelectorAll("[data-host]")].map((node) => [
        node.getAttribute("data-host"),
        node.getAttribute("data-state"),
      ]),
      groups: [...document.querySelectorAll("[data-host-group]")].map((node) =>
        node.getAttribute("data-host-group"),
      ),
      title: document.querySelector("[data-releases-view] h3")?.textContent ?? "",
      summary: document.querySelector("[data-run-summary]")?.textContent ?? "",
      text: document.querySelector("[data-releases-view]")?.textContent ?? "",
      // A stage card cut off by the graph's own box, or a graph wider than its box.
      clipped: (() => {
        const graph = document.querySelector("[data-release-graph]");
        if (!graph) return ["no graph"];
        const box = graph.getBoundingClientRect();
        const cut = [...graph.querySelectorAll("[data-stage]")]
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.right > box.right + 0.5 || rect.left < box.left - 0.5;
          })
          .map((node) => node.getAttribute("data-stage"));
        if (graph.scrollWidth > graph.clientWidth)
          cut.push(`graph scrolls ${graph.scrollWidth - graph.clientWidth}px`);
        return cut;
      })(),
    }));
    const label = `${name} ${width}px ${theme}`;
    if (errors.length > 0) failures.push(`${label}: page errors: ${errors.join("; ")}`);
    if (facts.overflow > 0) failures.push(`${label}: page overflows by ${facts.overflow}px`);
    if (facts.stages.length !== 19)
      failures.push(`${label}: ${facts.stages.length} stages, want 19`);
    if (facts.clipped.length > 0)
      failures.push(`${label}: stages cut off: ${facts.clipped.join(", ")}`);
    if (facts.groups.join(",") !== "canary,fleet")
      failures.push(`${label}: groups ${facts.groups}`);
    const state = Object.fromEntries(facts.stages);
    const hosts = Object.fromEntries(facts.hosts);
    if (
      name === "held" &&
      (state.fleet !== "failed" || hosts.m3 !== "not-updated" || hosts.m4 !== "verified")
    )
      failures.push(`${label}: fleet ${state.fleet}, m3 ${hosts.m3}, m4 ${hosts.m4}`);
    if (name === "live" && (state.fleet !== "running" || hosts.m3 !== "acked"))
      failures.push(`${label}: fleet ${state.fleet}, m3 ${hosts.m3}`);
    if (name === "released" && (!facts.title.includes("1.0.189") || state.finalize !== "passed"))
      failures.push(`${label}: ${facts.title}, finalize ${state.finalize}`);
    if (
      name === "real" &&
      (state["test.web"] !== "absent" ||
        state["verify.release"] !== "absent" ||
        state.resolve !== "passed" ||
        !facts.summary.includes("0 waiting, 8 not in this run") ||
        !facts.text.includes("M4 rollout") ||
        facts.text.includes("Publish candidate") ||
        facts.text.includes("27m 44s"))
    )
      failures.push(`${label}: ${facts.summary} test.web ${state["test.web"]}`);
    const file = NodePath.join(out, `releases-${name}-${width}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    console.log(`${label}: ${facts.stages.length} stages, ${facts.hosts.length} hosts -> ${file}`);
    await page.close();
  }
  // Speed by version: synthetic timings of seven versions and five installs here, and a machine
  // with none. Every version row has a total, the regressions are marked, nothing overflows.
  for (const [name, query, width, theme] of [
    ["speed", "&speed=1", 1280, "light"],
    ["speed", "&speed=1", 1280, "dark"],
    ["speed", "&speed=1", 390, "light"],
    ["speed", "&speed=1", 390, "dark"],
    ["speed-empty", "&speed=empty", 390, "light"],
    ["speed-empty", "&speed=empty", 390, "dark"],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?theme=${theme}${query}`, { timeout: 240_000 });
    await page.locator("[data-release-speed]").waitFor({ timeout: 60_000 });
    // Open every version so the captures show each stage's and phase's change.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll("[data-release-speed] details"))
        node.open = true;
    });
    const facts = await page.evaluate(() => {
      const speed = document.querySelector("[data-release-speed]");
      const box = speed.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        versions: [...speed.querySelectorAll("[data-speed-version]")].map((node) =>
          node.getAttribute("data-speed-version"),
        ),
        totals: [...speed.querySelectorAll("[data-speed-total]")].map((node) => node.textContent),
        slower: [...speed.querySelectorAll('[data-speed-part][data-verdict="slower"]')].map(
          (node) => node.getAttribute("data-speed-part"),
        ),
        faster: [...speed.querySelectorAll('[data-speed-part][data-verdict="faster"]')].map(
          (node) => node.getAttribute("data-speed-part"),
        ),
        empty: speed.querySelector("[data-speed-empty]") !== null,
        cut: [...speed.querySelectorAll("*:not(.sr-only)")].filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5);
        }).length,
      };
    });
    const label = `${name} ${width}px ${theme}`;
    if (errors.length > 0) failures.push(`${label}: page errors: ${errors.join("; ")}`);
    if (facts.overflow > 0) failures.push(`${label}: page overflows by ${facts.overflow}px`);
    if (facts.cut > 0) failures.push(`${label}: ${facts.cut} elements outside the section`);
    if (name === "speed") {
      // Six release versions (1.0.196 to 1.0.191) and five installs (1.0.195 to 1.0.191).
      if (facts.versions.length !== 11) failures.push(`${label}: versions ${facts.versions}`);
      if (facts.totals.some((total) => !/\d+(h|m|s)/.test(total)))
        failures.push(`${label}: totals ${facts.totals}`);
      for (const part of ["test.server", "canary", "readiness"])
        if (!facts.slower.includes(part)) failures.push(`${label}: ${part} not marked slower`);
      if (!facts.faster.includes("build.mac")) failures.push(`${label}: build.mac not faster`);
    }
    if (name === "speed-empty" && !facts.empty) failures.push(`${label}: no empty state`);
    const file = NodePath.join(out, `releases-${name}-${width}-${theme}.png`);
    const section = page.locator("[data-release-speed]");
    await section.screenshot({ path: file, animations: "disabled" });
    console.log(`${label}: ${facts.versions.length} rows, slower ${facts.slower} -> ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: ${out}`);
