// Headless check that "New chat" works on a fresh state when Git cannot run.
// Starts a real server against a brand-new private --base-dir with PATH limited
// to a node symlink plus /bin (macOS /bin has no git), then drives the web UI
// in headless Chromium: the Chats heading plus, and the top "New chat" row.
//
// Usage: node apps/web/tests/chats-new-chat/verify.mjs [evidence-dir] [--only fixed|baseline]
//   fixed:    this worktree's apps/server/dist/bin.mjs (build web, then `node scripts/cli.ts build` in apps/server)
//   baseline: the installed app's bundled server (ELECTRON_RUN_AS_NODE), recorded as the before state
// Env: SPECWITHCODE_APP (default /Applications/SpecWithCode.app), CHATS_STATE_ROOT (fresh state parent).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const scratchRoot = join(homedir(), ".specwithcode/m4/scratch/linux-chat-plus");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : join(scratchRoot, "evidence"),
);
const stateRoot = resolve(process.env.CHATS_STATE_ROOT || scratchRoot);
const only = option("--only");
const app = process.env.SPECWITHCODE_APP ?? "/Applications/SpecWithCode.app";
mkdirSync(output, { recursive: true });
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });

const { chromium } = createRequire(join(repo, "apps/server/package.json"))("playwright-core");

const targets = [
  {
    label: "fixed",
    command: process.execPath,
    entry: join(repo, "apps/server/dist/bin.mjs"),
    extraEnv: {},
    expectFixed: true,
  },
  {
    label: "baseline",
    command: `${app}/Contents/MacOS/SpecWithCode`,
    entry: `${app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`,
    extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
    expectFixed: false,
  },
].filter((target) => !only || target.label === only);

const freePort = () =>
  new Promise((done, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => done(port));
    });
  });

// A clean environment: no inherited STUDIO_* / SPECWEAVE_* variables from a live service.
function gitlessEnv(binDir, extra) {
  const keep = ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL", "TERM"];
  const env = Object.fromEntries(
    keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  );
  return {
    ...env,
    PATH: `${binDir}:/bin`,
    STUDIO_DISABLE_AUTO_UPDATE: "true",
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    ...extra,
  };
}

async function run(target, browser) {
  const result = {
    label: target.label,
    entry: target.entry,
    headless: true,
    checks: {},
    screenshots: [],
  };
  const state = mkdtempSync(join(stateRoot, `state-${target.label}-`));
  mkdirSync(join(state, "userdata"));
  writeFileSync(
    join(state, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(
        ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"].map((id) => [
          id,
          { enabled: false },
        ]),
      ),
    }),
  );
  const binDir = mkdtempSync(join(state, "bin-"));
  symlinkSync(process.execPath, join(binDir, "node"));
  // The server merges in the PATH of a login shell (os-jank fixPath: `zsh -ilc`, whose
  // /etc/zprofile path_helper adds /usr/bin and its git shim). A private ZDOTDIR whose
  // .zshenv skips the global rc files keeps that login-shell PATH free of git too.
  const zdotdir = join(state, "zdotdir");
  mkdirSync(zdotdir);
  writeFileSync(join(zdotdir, ".zshenv"), `setopt no_global_rcs\nexport PATH="${binDir}:/bin"\n`);
  const env = gitlessEnv(binDir, { SHELL: "/bin/zsh", ZDOTDIR: zdotdir, ...target.extraEnv });
  const which = (cmd) =>
    spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { env, encoding: "utf8" });
  const loginShell = spawnSync(
    "/bin/zsh",
    ["-ilc", 'printf "%s\\n" "$PATH"; command -v git || echo "git: not found"'],
    {
      env,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  const gitProbe = which("git");
  const nodeProbe = which("node");
  result.state = state;
  result.path = env.PATH;
  result.checks.gitResolvable = gitProbe.status === 0 ? gitProbe.stdout.trim() : false;
  result.checks.nodeResolvable = nodeProbe.stdout.trim() || false;
  result.checks.loginShellProbe = {
    status: loginShell.status,
    stdout: loginShell.stdout.trim().split("\n"),
  };
  assert.equal(gitProbe.status === 0, false, `git resolvable at ${gitProbe.stdout}`);
  assert.ok(nodeProbe.status === 0, "node not resolvable on the restricted PATH");
  assert.ok(
    loginShell.stdout.includes("git: not found"),
    `login shell finds git: ${loginShell.stdout}`,
  );
  result.checks.stateEmptyBeforeStart =
    readdirSync(join(state, "userdata")).join(",") === "settings.json";

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    target.command,
    [
      target.entry,
      "serve",
      "--no-browser",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      state,
    ],
    { cwd: state, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  result.pid = child.pid;
  let log = "";
  const token = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("server startup timed out")), 90000);
    const observe = (chunk) => {
      log += chunk.toString();
      const match = log.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `server exited ${code}: ${log.replace(/Token: \S+/g, "Token: <omitted>").slice(-1500)}`,
        ),
      );
    });
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  try {
    const credential = await token;
    const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
      data: { credential },
      headers: { Origin: origin },
    });
    assert.equal(auth.status(), 200, "browser session");
    const rpc = async (tag, payload) => {
      const { ticket } = await (
        await context.request.post(`${origin}/api/auth/websocket-ticket`, {
          headers: { Origin: origin },
        })
      ).json();
      const url = new URL(origin);
      url.protocol = "ws:";
      url.pathname = "/ws";
      url.searchParams.set("wsTicket", ticket);
      url.searchParams.set("orchestrationProtocol", "2");
      return new Promise((done, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(
          () => (ws.close(), reject(new Error(`RPC timeout ${tag}`))),
          20000,
        );
        ws.addEventListener("open", () =>
          ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
        );
        ws.addEventListener("message", (event) => {
          for (const item of [JSON.parse(event.data)].flat())
            if (item._tag === "Exit" && String(item.requestId) === "1") {
              clearTimeout(timer);
              ws.close();
              item.exit?._tag === "Success"
                ? done(item.exit.value)
                : reject(new Error(JSON.stringify(item.exit).slice(0, 600)));
            }
        });
      });
    };
    const config = await rpc("server.getConfig", {});
    result.version = config.environment?.serverVersion ?? config.version ?? null;
    result.checks.scratchWorkspaceRoot = config.scratchWorkspaceRoot ?? null;

    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
      ),
    );
    const home = async () => {
      await page.goto(`${origin}/`);
      await page.locator(".sws-sidebar").waitFor();
      await page.locator('[aria-labelledby="sws-side-chats"] .sws-side-heading').waitFor();
      await page.waitForTimeout(1500);
    };
    await home();
    result.checks.chatRowsOnFreshState = await page
      .locator('[aria-labelledby="sws-side-chats"] .sws-chat-row')
      .count();
    const plus = page.locator(
      '[aria-labelledby="sws-side-chats"] .sws-side-heading button[aria-label="New chat"]',
    );
    result.checks.chatsHeadingPlus = await plus.count();
    const shot = async (name, locator = page) => {
      const file = join(output, `${target.label}-${name}.png`);
      await locator.screenshot({ path: file });
      result.screenshots.push(file);
    };
    await shot("sidebar", page.locator(".sws-sidebar"));
    await shot("page");

    // Clicks a New chat control and reports what happened within 10 s.
    const attempt = async (name, control) => {
      const before = new URL(page.url()).pathname;
      await control.click();
      const opened = await page
        .waitForURL(/\/draft\//, { timeout: 10000 })
        .then(() =>
          page.locator('[data-testid="composer-editor"]').first().waitFor({ timeout: 10000 }),
        )
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(800);
      const toast = await page.getByText("Could not start a chat").count();
      const outcome = {
        before,
        after: new URL(page.url()).pathname,
        draftOpened: opened,
        composerVisible: await page
          .locator('[data-testid="composer-editor"]')
          .first()
          .isVisible()
          .catch(() => false),
        couldNotStartToast: toast > 0,
      };
      await shot(`after-${name}`);
      return outcome;
    };
    if (result.checks.chatsHeadingPlus > 0)
      result.checks.plusClick = await attempt("chats-plus", plus.first());
    await home();
    result.checks.topRowClick = await attempt(
      "top-new-chat-row",
      page.locator(".sws-side-actions button.sws-side-row", { hasText: "New chat" }).first(),
    );
    result.checks.pageErrors = errors;

    const verdict = [];
    if (target.expectFixed) {
      if (result.checks.scratchWorkspaceRoot === null)
        verdict.push("server offers no Scratch folder");
      if (result.checks.chatsHeadingPlus !== 1) verdict.push("Chats heading plus missing");
      for (const key of ["plusClick", "topRowClick"]) {
        const click = result.checks[key];
        if (!click?.draftOpened || !click.composerVisible || click.couldNotStartToast)
          verdict.push(`${key} did not open a draft`);
      }
    } else {
      // Expected before state: no plus, the row starts nothing.
      if (result.checks.chatsHeadingPlus !== 0) verdict.push("baseline already has the plus");
      if (result.checks.topRowClick.draftOpened) verdict.push("baseline row opened a draft");
    }
    result.pass = verdict.length === 0;
    result.problems = verdict;
  } finally {
    await context.close();
    writeFileSync(
      join(output, `${target.label}-server.log`),
      log.replace(/Token: \S+/g, "Token: <omitted>"),
    );
    child.kill("SIGTERM");
    await new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      const timer = setTimeout(() => (child.kill("SIGKILL"), done()), 8000);
      child.once("exit", () => (clearTimeout(timer), done()));
    });
  }
  return result;
}

const browser = await chromium.launch({ headless: true });
const results = {
  scope:
    "Source verification on macOS with git hidden (PATH = node symlink + /bin, and a ZDOTDIR so the server's login-shell PATH probe also lacks git); not Linux installed acceptance. Fresh private --base-dir per target, all providers disabled.",
  date: new Date().toISOString(),
  targets: [],
};
try {
  for (const target of targets) {
    try {
      results.targets.push(await run(target, browser));
    } catch (error) {
      results.targets.push({
        label: target.label,
        pass: false,
        error: String(error?.stack ?? error),
      });
    }
  }
} finally {
  await browser.close();
}
results.pass = results.targets.every((target) => target.pass);
writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.pass ? 0 : 1;
