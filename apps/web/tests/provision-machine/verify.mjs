import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const home = NodeOS.homedir();
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    NodePath.join(
      home,
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const site = NodePath.resolve(".artifacts/provision-machine/site");
const output = NodePath.resolve(process.argv[2] || ".artifacts/provision-machine/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader("content-type", types[NodePath.extname(file)] || "application/octet-stream");
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_TEST_CHROMIUM ||
    NodePath.join(
      home,
      "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
});
const receipt = {
  headless: true,
  scope: "Real Provision sheet; simulated machine RPCs",
  cases: [],
};
try {
  for (const [width, height, theme] of [
    [1280, 960, "light"],
    [390, 844, "light"],
    [1280, 960, "dark"],
    [390, 844, "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.getByRole("button", { name: "Provision", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByText("18.19.1 → 22.20.0").waitFor();
    NodeAssert.equal(await page.locator('[data-slot="provision-item"]').count(), 6);
    await page.screenshot({ path: NodePath.join(output, `${width}-${theme}-preview.png`) });
    await page.getByRole("button", { name: "Provision Ministorm", exact: true }).click();
    await page.getByText("SHA-256 ok", { exact: false }).waitFor();
    await page.screenshot({ path: NodePath.join(output, `${width}-${theme}-running.png`) });
    await page.evaluate(() => window.provision.finish());
    await page.getByText("Waiting for root: linger.", { exact: false }).waitFor();
    await page.getByText("sudo sh '/home/anton/.specwithcode/provision/root-steps.sh'").waitFor();
    await page.getByText("Allow workers in Settings > Connections").waitFor();
    await page.screenshot({ path: NodePath.join(output, `${width}-${theme}-readback.png`) });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    const calls = await page.evaluate(() => window.calls.map((c) => [c.command, c.request.input]));
    NodeAssert.deepEqual(calls, [
      ["preview", {}],
      ["run", { resume: false }],
      ["run", { resume: true }],
    ]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    NodeAssert.equal(overflow, false);
    NodeAssert.deepEqual(errors, []);
    receipt.cases.push({ width, height, theme, passed: true });
    await page.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
