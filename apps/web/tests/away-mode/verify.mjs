// Headless screenshots of the Away dialog (1267): a plan with a missing grant and
// Request access, a Leave in progress, and the wake card.
// Build first: vp build --config apps/web/tests/away-mode/vite.config.ts
// Usage: node apps/web/tests/away-mode/verify.mjs /absolute/report-dir
// Playwright comes from STUDIO_PLAYWRIGHT_MODULE (an installed playwright-core entry).
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/away-mode/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/away-mode/evidence");
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
  ["plan", "Request access"],
  ["running", "Away on Ministorm"],
  ["wake", "Your work is on Ministorm"],
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
      await page.setViewportSize({ width: 900, height: 860 });
      await page.goto(`${origin}/?view=${view}&theme=${theme}`);
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(150);
      const path = NodePath.join(output, `${view}-${theme}.png`);
      await page.screenshot({ path });
      shots.push(path);
    }
  }
  // A missing grant: Request access is offered, and Leave waits for it.
  await page.goto(`${origin}/?view=plan`);
  await page.getByText("Needed first (1)").waitFor();
  NodeAssert.equal(await page.getByRole("button", { name: "Request access" }).isEnabled(), true);
  // The sender's own text is never shown as an instruction to the target here.
  NodeAssert.ok(await page.getByText("Ministorm: no .env.local").count());
  // While leaving, Bring back waits for the run to finish.
  await page.goto(`${origin}/?view=running`);
  await page.getByText("Away on Ministorm").waitFor();
  // Items Leave has not reached yet wait; they have not stayed.
  await page.getByText("Waiting (2)").waitFor();
  await page.getByText("Stayed here (1)").waitFor();
  NodeAssert.equal(await page.getByRole("button", { name: "Bring back" }).isDisabled(), true);
  // The wake card offers one-click Bring back and Later.
  await page.goto(`${origin}/?view=wake`);
  await page.getByTestId("away-wake-card").waitFor();
  NodeAssert.equal(await page.getByRole("button", { name: "Bring back" }).isEnabled(), true);
  NodeAssert.equal(await page.getByRole("button", { name: "Later" }).count(), 1);
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
