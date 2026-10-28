// Headless screenshots of the handoff mode badges, dialogs and settings (0967 AC-12).
// Build first: vp build --config apps/web/tests/handoff-mode/vite.config.ts
// Usage: node apps/web/tests/handoff-mode/verify.mjs /absolute/report-dir
// Playwright comes from STUDIO_PLAYWRIGHT_MODULE (an installed playwright-core entry).
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/handoff-mode/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/handoff-mode/evidence");
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
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
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
const errors = [];
const shots = [];
const cases = [
  ["badges", "M3 is offline"],
  ["thread-check", "Minis: no .env.local"],
  ["thread-done", "continues on Minis."],
  ["thread-switch", "Switch and continue"],
  ["machine", "Minis: no .env.local"],
  ["machine-done", "Open on Minis"],
  // 0969 AC-10: the switcher's "Move M4's running threads…" scopes the dialog to one project.
  ["migrate", "atlas's coordinator stays on M4."],
  ["resume", "Resume all threads on this Mac?"],
  // 1121: one machine default; projects are set on their own page.
  ["settings", "Keep threads ready to move"],
  ["settings-overrides", "Old app (archived): Off"],
  ["project", "Keep this project's threads ready to move"],
];
try {
  const page = await browser.newPage({ reducedMotion: "reduce", deviceScaleFactor: 2 });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const [view, text] of cases) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: 900, height: 720 });
      await page.goto(`${origin}/?view=${view}&theme=${theme}`);
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(150);
      const path = NodePath.join(output, `${view}-${theme}.png`);
      await page.screenshot({ path });
      shots.push(path);
    }
  }
  // A failed check keeps the thread here: Move stays disabled until the checks pass.
  await page.goto(`${origin}/?view=thread-check`);
  NodeAssert.equal(await page.getByRole("button", { name: "Move to Minis" }).isDisabled(), true);
  await page.goto(`${origin}/?view=thread-ready`);
  NodeAssert.equal(await page.getByRole("button", { name: "Move to Minis" }).isDisabled(), false);
  // No per-project list, no automated or archived groups, no inert auto-continue row.
  await page.goto(`${origin}/?view=settings`);
  await page.getByText("Keep threads ready to move").first().waitFor();
  for (const gone of ["Show automated", "Show archived", "Continue automatically"])
    NodeAssert.equal(await page.getByText(gone).count(), 0, gone);
  NodeAssert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  `${JSON.stringify({ headless: true, shots: shots.map((shot) => NodePath.basename(shot)), errors }, null, 2)}\n`,
);
console.log(shots.join("\n"));
