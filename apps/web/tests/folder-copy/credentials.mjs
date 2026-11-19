// Headless captures of "Credentials this project uses" on the copy review (increment 1337):
// light and dark, 1440 and 390 px wide. Fictional rows through the real component.
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/folder-copy/vite.config.ts
// Run from the repository root: node apps/web/tests/folder-copy/credentials.mjs /absolute/report-dir
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const site = NodePath.join(process.cwd(), ".artifacts/folder-copy/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/folder-copy/credentials");
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const shell = () => {
  if (process.env.STUDIO_CHROMIUM_EXECUTABLE) return process.env.STUDIO_CHROMIUM_EXECUTABLE;
  const cache = NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright");
  if (!NodeFS.existsSync(cache)) return undefined;
  for (const dir of NodeFS.readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    const build = NodeFS.readdirSync(NodePath.join(cache, dir)).find((name) =>
      name.startsWith("chrome-headless-shell-"),
    );
    const file = build && NodePath.join(cache, dir, build, "chrome-headless-shell");
    if (file && NodeFS.existsSync(file)) return file;
  }
  return undefined;
};
const server = NodeHttp.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return response.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    const type = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    response.writeHead(200, { "Content-Type": type[NodePath.extname(file)] ?? "text/html" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const executablePath = shell();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const saved = [];
try {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 1600 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${base}?short=1&secrets=1&theme=${theme}`);
      await page.getByRole("button", { name: "Details" }).click();
      await page.getByRole("checkbox", { name: "Let me choose file types first" }).click();
      await page.getByRole("button", { name: "Copy to rackF", exact: true }).click();
      await page.getByRole("button", { name: "Preview on rackF", exact: true }).click();
      const section = page.locator('[data-slot="copy-credentials"]');
      await section.waitFor();
      await page
        .locator('[data-slot="copy-credential-status"]', { hasText: "Not signed in on rackF" })
        .first()
        .waitFor();
      // What the destination lacks is listed; what it has sits under a closed Ready group.
      const rows = await section
        .locator('[data-slot="copy-credential-row"]')
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.credential));
      NodeAssert.deepEqual(rows, [
        "azure",
        "google-cloud",
        "kubernetes",
        "hetzner-cloud",
        "cloudflare",
        "npm",
        "ssh",
      ]);
      NodeAssert.equal(
        await section.locator('[data-slot="copy-credentials-ready"]').evaluate((node) => node.open),
        false,
      );
      NodeAssert.match(await section.textContent(), /Ready on rackF \(1\)/);
      NodeAssert.doesNotMatch(await section.textContent(), /Send file/);
      // Sign in there: the destination's command as its own text, with what stayed behind.
      const kube = section.locator('[data-credential="kubernetes"]');
      await kube.locator('[data-slot="copy-credential-sign-in"]').click();
      NodeAssert.equal(
        await kube.locator('[data-slot="copy-credential-command"] code').first().textContent(),
        "az aks get-credentials --resource-group <group> --name <cluster>",
      );
      NodeAssert.match(await kube.textContent(), /Stays on laptopE/);
      NodeAssert.match(await kube.textContent(), /~\/\.kube\/config/);
      // A missing tool: its install comes first, then the sign-in, then the check.
      const gcloud = section.locator('[data-credential="google-cloud"]');
      NodeAssert.match(await gcloud.textContent(), /gcloud is not installed on rackF/);
      await gcloud.locator('[data-slot="copy-credential-sign-in"]').click();
      NodeAssert.deepEqual(
        await gcloud.locator('[data-slot="copy-credential-command"] code').allTextContents(),
        [
          "curl https://sdk.cloud.google.com | bash",
          "gcloud auth login --no-launch-browser",
          "gcloud auth list",
        ],
      );
      NodeAssert.equal(await gcloud.locator('[data-slot="copy-credential-install"]').count(), 1);
      // A tool the project lists installs through the project and runs from its folder.
      const cloudflare = section.locator('[data-credential="cloudflare"]');
      await cloudflare.locator('[data-slot="copy-credential-sign-in"]').click();
      NodeAssert.deepEqual(
        await cloudflare.locator('[data-slot="copy-credential-command"] code').allTextContents(),
        [
          "cd /Users/you/Projects/site/platform && npm install",
          "cd /Users/you/Projects/site/platform && npx wrangler login",
          "cd /Users/you/Projects/site/platform && npx wrangler whoami",
        ],
      );
      // npm from the app's own folder: where it comes from, and a command that reaches it.
      const npm = section.locator('[data-credential="npm"]');
      await npm.locator('[data-slot="copy-credential-sign-in"]').click();
      NodeAssert.match(
        await npm.textContent(),
        /npm comes with the Node\.js that SpecWithCode installs/,
      );
      NodeAssert.equal(
        await npm.locator('[data-slot="copy-credential-command"] code').first().textContent(),
        'export PATH=/Users/you/.specwithcode/commands:"$PATH" && npm login',
      );
      NodeAssert.match(await section.textContent(), /Checked just now/);
      // A key file: set up a new one there, never sent.
      const ssh = section.locator('[data-credential="ssh"]');
      await ssh.locator('[data-slot="copy-credential-sign-in"]').click();
      NodeAssert.match(
        await ssh.textContent(),
        /Private keys stay on laptopE and are never copied/,
      );
      // The places the project connects to, each with a check that runs as written.
      NodeAssert.deepEqual(
        await ssh
          .locator('[data-slot="copy-ssh-target"] [data-slot="copy-credential-command"] code')
          .allTextContents(),
        [
          'gh ssh-key add ~/.ssh/id_ed25519.pub --title "rackF"',
          "ssh -o BatchMode=yes -T -- git@github.com",
          "ssh -o BatchMode=yes -- root@203.0.113.10 true",
        ],
      );
      NodeAssert.doesNotMatch(await ssh.textContent(), /<host>/);
      NodeAssert.match(await ssh.textContent(), /not verified/);
      // Skip moves a row out of the list; Save says where the names went.
      await section.locator('[data-credential="npm"] [data-slot="copy-credential-skip"]').click();
      NodeAssert.match(await section.textContent(), /Skipped \(1\)/);
      await section.locator('[data-slot="copy-credentials-save"]').click();
      await section.getByText(".specweave/project/credentials.json").waitFor();
      // Nothing in the section is wider than the dialog.
      const overflow = await section.evaluate((node) => node.scrollWidth - node.clientWidth);
      // Which parts stick out, so a failure names what to fix.
      const wide = await section.evaluate((node) => {
        const edge = node.getBoundingClientRect().right;
        return [...node.querySelectorAll("*")]
          .filter((part) => part.getBoundingClientRect().right > edge + 1)
          .slice(0, 6)
          .map((part) => `${part.tagName.toLowerCase()}[${part.dataset.slot ?? part.className}]`);
      });
      NodeAssert.ok(
        overflow <= 1,
        `section overflows by ${overflow}px at ${width}: ${wide.join(", ")}`,
      );
      await section.scrollIntoViewIfNeeded();
      const path = NodePath.join(output, `credentials-${width}-${theme}.png`);
      await section.screenshot({ path, animations: "disabled" });
      saved.push(path);
      NodeAssert.deepEqual(errors, [], `page errors at ${width} ${theme}`);
      await page.close();
    }
  await NodeFSP.writeFile(
    NodePath.join(output, "credentials.json"),
    JSON.stringify(
      {
        headless: true,
        saved: saved.map((file) => NodePath.basename(file)),
        base: "synthetic fixture, no live state",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result: "passed", headless: true, captures: saved.length, output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
