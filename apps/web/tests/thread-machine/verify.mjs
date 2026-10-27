// Headless captures of the thread machine chips: light and dark, wide and
// phone width, reachable and unreachable. Build first with
// `node node_modules/vite-plus/bin/vp build --config apps/web/tests/thread-machine/vite.config.ts`.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const site = NodePath.join(root, ".artifacts/thread-machine/site");
const output = NodePath.resolve(
  process.argv[2] ?? NodePath.join(root, ".artifacts/thread-machine/evidence"),
);
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${site}${NodePath.sep}`)) return res.writeHead(403).end();
  try {
    const mime =
      { ".js": "text/javascript", ".css": "text/css" }[NodePath.extname(file)] ?? "text/html";
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const [name, width] of [
      ["wide", 1280],
      ["phone", 390],
    ]) {
      for (const state of ["ok", "unreachable"]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        await page.goto(`${base}?theme=${theme}${state === "unreachable" ? "&unreachable" : ""}`);
        const chip = page.locator("[data-thread-machine-chip]");
        const meta = page.locator('[data-thread-meta="machine"]');
        await meta.waitFor();
        if (!(await meta.innerText()).includes("linuxbox"))
          failures.push(`${theme}/${name}/${state}: meta row lacks the name`);
        const label = await chip.getAttribute("aria-label");
        if (!label?.includes("linuxbox"))
          failures.push(`${theme}/${name}/${state}: composer chip lacks the name`);
        const shown = await chip.innerText();
        if (name === "wide" && !shown.includes("linuxbox"))
          failures.push(`${theme}/${name}/${state}: wide composer hides the name`);
        await page.screenshot({ path: NodePath.join(output, `${theme}-${name}-${state}.png`) });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok, captures in ${output}`);
