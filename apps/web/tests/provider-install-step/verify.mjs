// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-install-step/vite.config.ts
// Then: node apps/web/tests/provider-install-step/verify.mjs /absolute/report-dir
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");

const root = NodePath.resolve(".artifacts/provider-install-step/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/provider-install-step/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const MUSE = "curl -fsSL https://dev.meta.ai/install.sh | bash";
const CLAUDE_WINDOWS = "irm https://claude.ai/install.ps1 | iex";
const GROK = "curl -fsSL https://x.ai/cli/install.sh | bash";
const WAITING = "Waiting for the install. This page updates by itself.";
const OLDER = "After it installs, choose Check again.";
const RUN = "Run in terminal";
const CHECK = "Check again";

const checks = [];
const errors = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
};

// What each case must and must not say. `headline` is the status row's own headline, read from
// the row alone; `has` and `not` read the case's card, never the fixture's title above it.
// `command` is the exact install command shown.
const MUSE_SIGN_IN = "Muse Code is not signed in. Run `muse login` in a terminal on this machine.";
const EXPECT = {
  "a-waiting": {
    headline: "Not installed",
    has: ["Install Muse Code on office-mac with this command:", WAITING],
    not: [OLDER, "Installed, but it does not start"],
    command: MUSE,
    run: true,
    checkAgain: true,
  },
  "b-broken": {
    headline: "Installed, but it does not start",
    has: [
      "Muse Code could not start: its installed binary is missing. Run the Muse Code installer again.",
      "/Users/dev/.local/bin/muse",
      WAITING,
    ],
    // The machine's words already give the next step; the install step does not repeat it.
    not: ["Not installed", "with this command:", "Run its installer again:", OLDER],
    command: MUSE,
    run: true,
    checkAgain: true,
  },
  "c-windows": {
    headline: "Not installed",
    has: ["Install Claude Code on office-pc with this command:", WAITING],
    not: ["curl ", OLDER],
    command: CLAUDE_WINDOWS,
    run: true,
    checkAgain: true,
  },
  "d-no-command-guide": {
    headline: "Not installed",
    has: ["Install Cursor Agent on office-mac from its own site.", WAITING],
    not: ["with this command:", OLDER],
    command: null,
    run: false,
    checkAgain: true,
    guide: "https://docs.example.com/agent/install",
  },
  "d-no-command": {
    headline: "Not installed",
    has: ["Install Cursor Agent on office-mac from its own site.", WAITING],
    not: ["with this command:", "Open its install guide", OLDER],
    command: null,
    run: false,
    checkAgain: true,
  },
  "e-registry": {
    headline: "Not installed",
    has: ["Install / update agent"],
    not: ["with this command:", "from its own site.", WAITING, OLDER],
    command: null,
    run: false,
    checkAgain: true,
    installStep: false,
  },
  "f-older-server": {
    headline: "Not installed",
    has: [
      "Grok CLI (`grok`) is not installed or not on PATH.",
      "Install Grok on office-mac with this command:",
      OLDER,
    ],
    not: [WAITING],
    command: GROK,
    run: true,
    checkAgain: true,
  },
  "g-ready": {
    headline: "Signed in",
    has: ["Plan: Pro.", "v0.9.1"],
    not: ["Not installed", WAITING, OLDER, "with this command:"],
    command: null,
    run: false,
    checkAgain: false,
    installStep: false,
  },
  "h-read-only": {
    headline: "Not installed",
    has: ["Install Muse Code on office-mac with this command:", WAITING],
    not: [OLDER],
    command: MUSE,
    run: false,
    checkAgain: true,
  },
  "i-plan": {
    headline: "Signed in",
    has: ["Plan: Muse Code Max Usage.", "v0.9.1"],
    not: ["Not installed", "with this command:", WAITING],
    command: null,
    run: false,
    checkAgain: false,
    installStep: false,
  },
  "j-signed-out": {
    headline: "Not signed in",
    has: ["Sign in with Meta", "Show command"],
    // The sign-in command is there once, folded under its button; the machine's words would say it again.
    not: [MUSE_SIGN_IN, "Not installed", "with this command:", WAITING],
    once: ["muse login"],
    command: null,
    run: false,
    checkAgain: false,
    installStep: false,
  },
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );

  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const tag = `${width} ${theme}`;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-case]").first().waitFor();

      const body = await page.locator("body").innerText();
      check(`${tag}: no "refresh Providers" advice anywhere`, !/refresh providers?\b/i.test(body));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      check(`${tag}: no horizontal page overflow`, overflow <= 0, { overflow });

      for (const [id, expect] of Object.entries(EXPECT)) {
        // The card under the fixture's title: the status row and what the app puts under it.
        const section = page.locator(`[data-case="${id}"] [data-case-row]`);
        const text = await section.innerText();
        const headline = (
          await section.locator('[data-agent-status-row] [role="status"]').first().innerText()
        ).trim();
        check(`${tag} ${id}: headline is "${expect.headline}"`, headline === expect.headline, {
          headline,
        });
        // Counted in the markup, so a command folded under "Show command" counts too.
        const markup = (await section.textContent()) ?? "";
        for (const phrase of expect.once ?? [])
          check(`${tag} ${id}: has "${phrase}" once`, markup.split(phrase).length - 1 === 1);
        for (const phrase of expect.has)
          check(`${tag} ${id}: shows "${phrase}"`, text.includes(phrase));
        for (const phrase of expect.not)
          check(`${tag} ${id}: does not show "${phrase}"`, !text.includes(phrase));
        const run = section.getByRole("button", { name: RUN, exact: true });
        check(
          `${tag} ${id}: ${expect.run ? "has" : "has no"} ${RUN}`,
          (await run.count()) === (expect.run ? 1 : 0),
        );
        const again = section.getByRole("button", { name: CHECK, exact: true });
        check(
          `${tag} ${id}: ${expect.checkAgain ? "has" : "has no"} ${CHECK}`,
          (await again.count()) === (expect.checkAgain ? 1 : 0),
        );
        const step = section.locator("[data-agent-install-step]");
        if (expect.installStep === false)
          check(`${tag} ${id}: no install step`, (await step.count()) === 0);
        const codes = await step.locator("code").allInnerTexts();
        if (expect.command) {
          check(
            `${tag} ${id}: install command is exactly ${expect.command}`,
            codes[0] === expect.command,
            {
              codes,
            },
          );
          // A long command scrolls inside its box rather than being cut off or widening the page.
          const box = await step
            .locator("code")
            .first()
            .evaluate((code) => {
              const rect = code.getBoundingClientRect();
              return {
                overflowX: getComputedStyle(code).overflowX,
                right: rect.right,
                fits: code.scrollWidth <= code.clientWidth,
              };
            });
          check(
            `${tag} ${id}: command box stays on screen and scrolls if needed`,
            box.right <= width && (box.fits || box.overflowX === "auto"),
            box,
          );
          const copy = step.getByRole("button", { name: "Copy command", exact: true });
          check(`${tag} ${id}: command has a Copy button`, (await copy.count()) === 1);
        } else {
          check(`${tag} ${id}: shows no install command`, codes.length === 0, { codes });
        }
        if (expect.guide) {
          const link = section.getByRole("link", { name: "Open its install guide" });
          check(
            `${tag} ${id}: install guide links to the provider's page`,
            (await link.getAttribute("href")) === expect.guide,
          );
        }
        if (expect.run) {
          const height = (await run.boundingBox())?.height ?? 0;
          check(`${tag} ${id}: ${RUN} sits on one line`, height > 0 && height <= 40, { height });
        }
      }

      await page.screenshot({
        path: NodePath.join(output, `install-step-${width}-${theme}.png`),
        fullPage: true,
      });

      if (width === 1280 && theme === "light") {
        // Copy, Run in terminal and Check again on the waiting row.
        const section = page.locator('[data-case="a-waiting"]');
        await section.getByRole("button", { name: "Copy command", exact: true }).click();
        const copied = section.getByRole("button", { name: "Copied", exact: true });
        await copied.waitFor().catch(() => undefined);
        check("a-waiting: Copy turns into Copied", (await copied.count()) === 1);
        check(
          "a-waiting: clipboard holds the exact command",
          (await page.evaluate(() => navigator.clipboard.readText())) === MUSE,
        );
        await section.getByRole("button", { name: RUN, exact: true }).click();
        await section.getByRole("button", { name: CHECK, exact: true }).click();
        await page.waitForFunction(() =>
          window.fixtureCalls.some((call) => call.kind === "refreshProviders"),
        );
        const calls = await page.evaluate(() => window.fixtureCalls);
        const opened = calls.find((call) => call.kind === "openSetupTerminal")?.input;
        check(
          "a-waiting: Run in terminal opens the setup terminal with the install command",
          opened?.purpose === "install" && opened?.command === MUSE && opened?.agent === "muse",
          opened,
        );
        const refresh = calls.find((call) => call.kind === "refreshProviders")?.input;
        check(
          "a-waiting: Check again asks this machine for a fresh check",
          refresh?.environmentId === "office-mac" &&
            refresh?.input?.instanceId === "muse" &&
            refresh?.input?.fresh === true,
          refresh,
        );
      }
    }
  }
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("verifier ran to the end", false, String(error?.stack ?? error));
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter((item) => !item.pass);
await NodeFSP.writeFile(
  NodePath.join(output, "results.json"),
  JSON.stringify(
    {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      checks,
      errors,
    },
    null,
    2,
  ),
);
for (const item of failed) console.error(`FAIL ${item.name} ${JSON.stringify(item.detail ?? "")}`);
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; evidence in ${output}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
