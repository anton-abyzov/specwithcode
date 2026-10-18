// Build first: vp build --config apps/web/tests/usage-identity/vite.config.ts
// Then: STUDIO_PLAYWRIGHT_MODULE=/abs/path/playwright-core/index.mjs node apps/web/tests/usage-identity/verify.mjs
// Always headless. Screenshots and receipt.json go to USAGE_IDENTITY_OUTPUT or
// .artifacts/usage-identity/evidence/.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/usage-identity/site");
const output = NodePath.resolve(
  process.env.USAGE_IDENTITY_OUTPUT ?? ".artifacts/usage-identity/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) return void res.writeHead(403).end();
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(await NodeFSP.readFile(file));
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
const receipt = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      for (const setup of ["ready", "one"]) {
        const label = `${setup}-${theme}-${width}`;
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${origin}/?theme=${theme}&setup=${setup}`);
        await page.getByText("Quota reports do not confirm", { exact: false }).first().waitFor();
        const chips = await page
          .getByRole("button", { name: /^Set up chat providers on / })
          .allInnerTexts();
        if (setup === "ready") NodeAssert.deepEqual(chips, [], `${label}: chips ${chips}`);
        else
          NodeAssert.deepEqual(
            chips,
            ["Set up on Anton's MacBook Pro"],
            `${label}: chips ${chips}`,
          );
        const segments = await page
          .locator("button[aria-label*=' on Anton']")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
        NodeAssert.ok(
          segments.some((name) =>
            name.startsWith("anton.team-account@example.com on Anton's MacBook M4MAX (149)"),
          ),
          `${label}: no M4 segment in ${segments.join(" | ")}`,
        );
        // Every ready account reports identity, so no bar falls back to the bare instance name.
        if (setup === "ready") {
          NodeAssert.ok(
            !segments.some((name) => /^Claude[ :]/.test(name)),
            `${label}: bare instance label`,
          );
        }
        if (width === 1440) {
          await page.getByText("anton.team-account@example.com", { exact: true }).first().waitFor();
          await page.getByText("Anton's MacBook M4MAX (149)", { exact: true }).first().waitFor();
        }
        NodeAssert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${label}: horizontal page overflow`,
        );
        await page.screenshot({
          path: NodePath.join(output, `limits-${label}.png`),
          fullPage: true,
        });
        receipt.push({ label, chips, segments: segments.length });
      }
    }
  }
  // Details on hover: the full email, plan and machine.
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/?theme=${theme}`);
    const segment = page.locator("button[aria-label^='anton.team-account@example.com on']").first();
    // The pointer may already sit where the segment renders; leave first so hover fires.
    await page.mouse.move(0, 0);
    await segment.hover();
    const popup = page.locator("[data-slot='popover-popup'], [role='dialog']").first();
    await popup.waitFor();
    const text = await popup.innerText();
    NodeAssert.match(text, /Account\s+anton\.team-account@example\.com/);
    NodeAssert.match(text, /Machine\s+Anton's MacBook M4MAX \(149\)/);
    await page.screenshot({ path: NodePath.join(output, `details-${theme}.png`) });
    receipt.push({ label: `details-${theme}`, text });
  }
  // A machine the app cannot reach keeps its last read, marked as such; a
  // window whose reset passed counts as open, and a signed-out home gets a line.
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/?theme=${theme}&setup=offline`);
    await page.getByText("Quota reports do not confirm", { exact: false }).first().waitFor();
    const segments = await page
      .locator("button[aria-label^='anton.personal@example.com on']")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    NodeAssert.ok(segments.length > 0, `${theme}: no offline segment`);
    for (const name of segments) {
      NodeAssert.match(name, /on Anton's MacBook Pro · offline: /, `${theme}: ${name}`);
    }
    NodeAssert.ok(
      segments.some((name) => /: 100% left, reset$/.test(name)),
      `${theme}: no reopened window in ${segments.join(" | ")}`,
    );
    await page
      .getByText("Claude marketing: Not signed in, so no limits to show.", { exact: false })
      .first()
      .waitFor();
    await page.screenshot({ path: NodePath.join(output, `offline-${theme}.png`), fullPage: true });
    await page.mouse.move(0, 0);
    await page.locator("button[aria-label$=': 100% left, reset']").first().hover();
    const popup = page.locator("[data-slot='popover-popup'], [role='dialog']").first();
    await popup.waitFor();
    const text = await popup.innerText();
    NodeAssert.match(text, /reset since the last read/);
    NodeAssert.match(text, /Read\s+5h 0m ago · machine offline/);
    // Let the popover finish fading in so the evidence is legible.
    await popup.evaluate((node) =>
      Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    await page.screenshot({ path: NodePath.join(output, `offline-details-${theme}.png`) });
    receipt.push({ label: `offline-${theme}`, segments, text });
  }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify({ headless: true, checks: receipt }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ passed: receipt.length, output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
