// Headless check and screenshots of the account menu: node shoot.mjs <site dir> <out dir>
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
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
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
const SIGN_IN = "Sign in to SpecWithCode Connect";
const cases = {
  local: { button: "Ada's MacBook Pro", has: [], hasNot: [SIGN_IN, "Sign in here", "Sign out"] },
  unlinked: {
    button: "Not signed in",
    has: ["Not signed in", SIGN_IN],
    hasNot: ["Sign out", "Manage account"],
  },
  linked: {
    button: "Not signed in",
    has: ["Linked to Connect", "Sign in here"],
    hasNot: ["Sign out", SIGN_IN],
  },
  signedIn: {
    button: "Ada Lovelace",
    has: ["ada@example.com", "Manage account", "Sign out"],
    hasNot: [SIGN_IN, "Sign in here"],
  },
};
const failures = [];
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 620 },
    deviceScaleFactor: 2,
  });
  for (const [state, want] of Object.entries(cases)) {
    await page.goto(`${origin}/?state=${state}&theme=${theme}`);
    await page.getByRole("button", { name: `Account: ${want.button}` }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    await page.waitForTimeout(250);
    const text = await menu.innerText();
    for (const expected of ["Settings", "Add a device or machine", ...want.has]) {
      if (!text.includes(expected)) failures.push(`${state}/${theme}: missing "${expected}"`);
    }
    for (const unexpected of [...want.hasNot, "Sign in on another device", "gmail"]) {
      if (text.includes(unexpected)) failures.push(`${state}/${theme}: has "${unexpected}"`);
    }
    await page.screenshot({ path: NodePath.join(output, `${state}-${theme}.png`) });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(failures.length ? failures.join("\n") : "account menu: all states pass");
process.exit(failures.length ? 1 : 0);
