// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/model-search/vite.config.ts
// Then: node apps/web/tests/model-search/shoot.mjs /absolute/out-dir [query]
// Headless screenshots of a picker search. Serves the fixture only; fictional data.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const { mkdir, readFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(resolve("apps/server/package.json"))(
  "playwright-core",
);

const root = resolve(".artifacts/model-search/site");
const output = resolve(process.argv[2] ?? ".artifacts/model-search/evidence");
const query = process.argv[3] ?? "opus";
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const [theme, width] of [
    ["light", 900],
    ["dark", 900],
    ["light", 390],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => console.error(String(error)));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator("[data-chat-provider-model-picker]").click();
    await page.locator("[data-model-picker-content]").waitFor();
    await page.waitForTimeout(300);
    const suffix = width === 900 ? theme : `${theme}-${width}`;
    await page
      .locator("[data-model-picker-content]")
      .screenshot({ path: join(output, `providers-${suffix}.png`) });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
      console.error(`page scrolls sideways at ${width}`);
      process.exitCode = 1;
    }
    await page.getByPlaceholder("Search models or providers").fill(query);
    await page.waitForTimeout(300);
    const picker = page.locator("[data-model-picker-content]");
    await picker.screenshot({ path: join(output, `search-${query}-${suffix}.png`) });
    console.log((await picker.innerText()).replace(/\n+/g, " | "));
    // Open the older versions and show them.
    await page.locator("[data-model-search-older]").first().click();
    await page.waitForTimeout(300);
    const box = await picker.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 520);
    await page.waitForTimeout(300);
    await picker.screenshot({ path: join(output, `search-${query}-older-${suffix}.png`) });
    await page.close();
  }
  // Enter on the top heading picks the latest model's best provider, not the toggle.
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(origin);
  await page.locator("[data-chat-provider-model-picker]").click();
  await page.getByPlaceholder("Search models or providers").fill(query);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  const picked = await page.getByTestId("selection").textContent();
  console.log(`Enter picked ${picked}`);
  if (query === "opus" && picked !== "claudeAgent:claude-opus-5-5") process.exitCode = 1;
  // Star the Opus family from search, then Favorites lists every version, newest on top,
  // and picking that newest version makes new chats follow the family.
  for (const [theme, width] of [
    ["light", 900],
    ["light", 390],
  ]) {
    const fav = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    await fav.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await fav.goto(`${origin}/?theme=${theme}`);
    await fav.locator("[data-chat-provider-model-picker]").click();
    await fav.getByPlaceholder("Search models or providers").fill("opus");
    await fav.waitForTimeout(300);
    await fav.locator('[data-model-search-family-star="opus"]').first().click();
    await fav.getByPlaceholder("Search models or providers").fill("");
    await fav.locator('[data-model-picker-provider="favorites"] button').click();
    await fav.waitForTimeout(300);
    const picker = fav.locator("[data-model-picker-content]");
    await picker.screenshot({ path: join(output, `favorites-family-${theme}-${width}.png`) });
    const text = (await picker.innerText()).replace(/\n+/g, " | ");
    console.log(`favorites ${width}: ${text.slice(0, 240)}`);
    if (!/Claude Opus 5\.5/.test(text) || !/3 older/.test(text)) process.exitCode = 1;
    await fav.locator("[data-model-row-plan]", { hasText: "Claude Max" }).first().click();
    const follow = await fav.getByTestId("follow").textContent();
    console.log(`follow ${width}: ${follow}`);
    if (follow !== '{"claudeAgent":"opus"}') process.exitCode = 1;
    await fav.close();
  }
} finally {
  await browser.close();
  server.close();
}
