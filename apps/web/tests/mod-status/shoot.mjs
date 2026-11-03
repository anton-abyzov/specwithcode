// Headless check and screenshots of the mod status icons: node shoot.mjs <site dir> <out dir>
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const [site, output] = process.argv.slice(2).map((path) => NodePath.resolve(path));
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  try {
    const mime =
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html";
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": mime }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROME,
});
const failures = [];
const expect = (ok, message) => {
  if (!ok) failures.push(message);
};
const overflow = (page, locator) =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.right > window.innerWidth || box.left < 0 || node.scrollWidth > node.clientWidth + 1;
  });

for (const theme of ["light", "dark"]) {
  for (const width of [256, 200]) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 420 },
      deviceScaleFactor: 2,
    });
    const tag = `${theme}-${width}`;
    await page.goto(`${origin}/?state=live&theme=${theme}&width=${width}`);
    const status = page.getByLabel("Mod status");
    const blocked = status.getByRole("button", { name: "8 Blocked" });
    const verify = status.getByRole("button", { name: "6 To verify" });
    await blocked.waitFor();
    await verify.waitFor();
    expect((await status.getByRole("button").count()) === 2, `${tag}: one icon per stat`);
    expect((await status.innerText()).replace(/\s+/g, " ").trim() === "8 6", `${tag}: no words`);
    expect((await page.locator("[data-mod-stat-glyph=ready]").count()) === 0, `${tag}: zero icon`);
    const statusBox = await status.boundingBox();
    expect(statusBox.width <= width, `${tag}: status wider than the sidebar`);
    expect(!(await overflow(page, blocked)), `${tag}: icon overflows`);
    await page.screenshot({ path: NodePath.join(output, `icons-${tag}.png`) });

    await blocked.hover();
    await page.getByText("Tasks in open increments marked blocked").waitFor();
    await page.getByText("From the increment-standup mod").waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: NodePath.join(output, `tooltip-${tag}.png`) });

    await verify.click();
    await page.getByRole("dialog", { name: "List 3" }).waitFor();
    expect(
      JSON.stringify(await page.evaluate(() => window.pressed)) === '["ready-to-close:3"]',
      `${tag}: press reached the wrong stat`,
    );
    await page.close();
  }
  const page = await browser.newPage({
    viewport: { width: 900, height: 420 },
    deviceScaleFactor: 2,
  });
  await page.goto(`${origin}/?state=zero&theme=${theme}`);
  await page.waitForTimeout(300);
  expect((await page.getByLabel("Mod status").count()) === 0, `${theme}: zero stays quiet`);

  await page.goto(`${origin}/?state=text&theme=${theme}`);
  await page.getByLabel("Mod status").getByText("Focus 25 min").waitFor();
  await page.screenshot({ path: NodePath.join(output, `with-text-pill-${theme}.png`) });
  // The counts reach zero and return while the sidebar stays mounted.
  const textIcon = page.getByRole("button", { name: "8 Blocked" });
  await textIcon.waitFor();
  await page.evaluate(() => {
    window.setCounts(false);
    window.clearVerify();
  });
  await textIcon.waitFor({ state: "detached" });
  await page.evaluate(() => window.setCounts(true));
  await textIcon.waitFor();

  await page.goto(`${origin}/?state=large&theme=${theme}&width=200`);
  const large = page.getByRole("button", { name: "999+ Blocked" });
  await large.waitFor();
  expect((await large.innerText()).includes("999+"), `${theme}: large counts cap`);
  await page.screenshot({ path: NodePath.join(output, `large-${theme}.png`) });
  await page.close();
}
await browser.close();
server.close();
console.log(failures.length ? failures.join("\n") : "mod status: all cases pass");
process.exit(failures.length ? 1 : 0);
