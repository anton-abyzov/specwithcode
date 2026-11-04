// Headless check of the Releases view on the fixture run records: the stage graph and both machine
// tables render, nothing overflows the page, at desktop and phone widths, light and dark.
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
    }));
    const label = `${name} ${width}px ${theme}`;
    if (errors.length > 0) failures.push(`${label}: page errors: ${errors.join("; ")}`);
    if (facts.overflow > 0) failures.push(`${label}: page overflows by ${facts.overflow}px`);
    if (facts.stages.length !== 19)
      failures.push(`${label}: ${facts.stages.length} stages, want 19`);
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
    const file = NodePath.join(out, `releases-${name}-${width}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    console.log(`${label}: ${facts.stages.length} stages, ${facts.hosts.length} hosts -> ${file}`);
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
