// Headless screenshots of the sign-in card and view (1488). Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/sign-in-view/vite.config.ts
//   node apps/web/tests/sign-in-view/verify.mjs /absolute/owned/report-dir [/absolute/frame.jpg]
// The optional JPEG is shown as the remote page (a real Chrome capture); it is read, never copied.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(".artifacts/sign-in-view/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/sign-in-view/evidence");
const framePath = process.argv[3];
await NodeFSP.mkdir(output, { recursive: true });
const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
};
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/frame.jpg") {
      if (!framePath) return void res.writeHead(404).end();
      return void res
        .writeHead(200, { "Content-Type": "image/jpeg" })
        .end(await NodeFSP.readFile(framePath));
    }
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    res
      .writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" })
      .end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const problems = [];
for (const [kind, theme, width] of [
  ["card", "light", 720],
  ["card", "dark", 720],
  ["view", "light", 1280],
  ["view", "dark", 1280],
  ["passkey", "light", 1280],
  ["view", "light", 390],
]) {
  const page = await browser.newPage({ viewport: { width, height: 860 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/?case=${kind}&theme=${theme}`);
  const facts = {};
  if (kind === "card") {
    await page.waitForSelector('[data-access-decision="sign-in"]');
    facts.button = await page.textContent('[data-access-decision="sign-in"]');
  } else {
    await page.waitForSelector("[data-sign-in-surface] img", { timeout: 15_000 });
    await page.waitForTimeout(400);
    facts.origin = await page.textContent("[data-sign-in-origin]");
    facts.passkey = (await page.$("[data-sign-in-passkey]")) !== null;
    // Type into the view: characters go sealed, Enter goes by name.
    await page.click("[data-sign-in-surface] img", { position: { x: 40, y: 40 } });
    await page.keyboard.type("hunter2");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    facts.sent = await page.evaluate(() =>
      globalThis.__signInSent.map(({ input }) =>
        input.type === "text" ? { type: "text", sealedChars: input.sealed.length } : input,
      ),
    );
    if (!facts.sent.some((input) => input.type === "text"))
      problems.push(`${kind}/${theme}/${width}: no sealed text`);
    if (JSON.stringify(facts.sent).includes("hunter2"))
      problems.push(`${kind}: typed text left unsealed`);
    if (kind === "passkey" && !facts.passkey) problems.push("passkey notice missing");
  }
  facts.sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  if (facts.sideways) problems.push(`${kind}/${theme}/${width}: sideways scroll`);
  if (errors.length) problems.push(`${kind}/${theme}/${width}: ${errors.join("; ")}`);
  await page.screenshot({ path: NodePath.join(output, `sign-in-${kind}-${theme}-${width}.png`) });
  console.log(kind, theme, width, JSON.stringify(facts));
  await page.close();
}
await browser.close();
server.close();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok: screenshots in ${output}`);
