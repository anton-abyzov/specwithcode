// Live check: a Claude sign-in changed outside SpecWithCode shows and is used
// without a restart. Runs this checkout's built server on a private base dir,
// HOME and loopback port. Claude's binary is claude-account-switch/fake-claude.mjs,
// which reads the "signed-in" account from the private home the way Claude Code
// does, so no real account, token or network is involved. The check switches the
// account as a terminal `/login` does (an atomic rename of `.claude.json`), then
// as a Claude Console sign-in does (a profile in the Anthropic profile folder), and
// records when each surface shows it and which account serves the next turn.
//
// Build first: (cd apps/web && node ../../node_modules/vite-plus/bin/vp build) and
// node apps/server/scripts/cli.ts build. Then, with Node 22:
//   node scripts/studio-verify/claude-account-switch.mjs /absolute/new/evidence-dir
// Set PLAYWRIGHT_MODULE (a playwright-core index.mjs) and PLAYWRIGHT_EXECUTABLE_PATH
// when the defaults are missing. Always headless. The pairing token is never written.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.strict;
const { spawn } = NodeChildProcess;
const { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = NodeFS;
const { createServer } = NodeNet;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath, pathToFileURL } = NodeURL;

process.env.PWDEBUG = "0";
const out = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Pass a new evidence directory");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = join(root, "apps/server/dist/bin.mjs");
assert.ok(existsSync(entrypoint), "Build the server first: node apps/server/scripts/cli.ts build");
mkdirSync(out, { recursive: true, mode: 0o700 });
const state = mkdtempSync(join(out, "private-state-"));
const home = mkdtempSync(join(out, "private-home-"));
const work = mkdtempSync(join(out, "work-"));
mkdirSync(join(state, "userdata"));
const fake = join(state, "claude");
writeFileSync(
  fake,
  `#!/bin/sh\nexec "${process.execPath}" "${join(root, "scripts/studio-verify/claude-account-switch/fake-claude.mjs")}" "$@"\n`,
);
chmodSync(fake, 0o755);
writeFileSync(
  join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: {
      ...Object.fromEntries(
        ["codex", "cursor", "grok", "pi", "opencode", "antigravity"].map((id) => [
          id,
          { enabled: false },
        ]),
      ),
      // No home folder of its own: the account is `$HOME/.claude.json`, as on most machines.
      claudeAgent: { enabled: true, binaryPath: fake },
    },
  }),
);

const PERSONAL = {
  accountUuid: "acct-personal",
  organizationUuid: "org-personal",
  organizationName: "Personal",
  emailAddress: "personal@example.invalid",
  billingType: "stripe_subscription",
  fixturePlan: "pro",
  fixtureFiveHourPercent: 12,
  fixtureSevenDayPercent: 31,
};
const ENTERPRISE = {
  accountUuid: "acct-enterprise",
  organizationUuid: "org-enterprise",
  organizationName: "Enterprise Org",
  emailAddress: "work@enterprise.example.invalid",
  billingType: "stripe_subscription",
  fixturePlan: "max",
  fixtureFiveHourPercent: 64,
  fixtureSevenDayPercent: 8,
};
const accountFile = join(home, ".claude.json");
let startups = 1;
/** What `claude /login` does to `.claude.json`: the whole file, written aside, then renamed. */
const signIn = (account) => {
  const staged = `${accountFile}.tmp-${process.pid}`;
  writeFileSync(staged, JSON.stringify({ numStartups: startups++, oauthAccount: account }));
  renameSync(staged, accountFile);
};
const profiles = join(home, ".config", "anthropic");
const consoleSignIn = () => {
  mkdirSync(join(profiles, "configs"), { recursive: true });
  writeFileSync(
    join(profiles, "configs", "default.json"),
    JSON.stringify({ email: "api@console.example.invalid", organization: "Console Org" }),
  );
  writeFileSync(join(profiles, "active_config"), "default");
};
const consoleSignOut = () => rmSync(join(profiles, "active_config"), { force: true });
signIn(PERSONAL);

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : pathToFileURL(join(root, "node_modules/.pnpm/node_modules/playwright-core/index.mjs")).href
);
const port = await new Promise((done, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [
    entrypoint,
    "serve",
    "--no-browser",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
  ],
  {
    cwd: state,
    env: {
      // Nothing of the person running this: no real home, Claude or Anthropic settings.
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      SHELL: "/bin/bash",
      USER: process.env.USER ?? "dev",
      LANG: "en_US.UTF-8",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      STUDIO_DISABLE_HOSTED_SERVICES: "true",
      SPECWEAVE_STUDIO_THREAD_ID: "",
      FAKE_CLAUDE_LOG: join(out, "fake-claude.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const stop = () => {
  if (child.exitCode === null) child.kill("SIGTERM");
};
process.once("exit", stop);
process.once("SIGINT", () => (stop(), process.exit(130)));

let output = "";
const credential = new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error("server startup timed out")), 90_000);
  const observe = (chunk) => {
    output += chunk.toString();
    const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
    if (match) {
      clearTimeout(timer);
      done(match[1]);
    }
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`server exited ${code}`));
  });
});

const receipt = { headless: true, port, steps: [], screenshots: [], failures: [] };
const step = (name, detail) => {
  receipt.steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(`${name}: ${JSON.stringify(detail)}`);
};
let browser;
let page;
const shot = async (name) => {
  const file = join(out, name);
  await page.screenshot({ path: file });
  receipt.screenshots.push(file);
};
try {
  const token = await credential;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: "reduce",
  });
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential: token },
    headers: { Origin: origin },
  });
  assert.equal(auth.status(), 200);
  let requestId = 0;
  async function rpc(tag, payload) {
    const { ticket } = await (
      await context.request.post(`${origin}/api/auth/websocket-ticket`, {
        headers: { Origin: origin },
      })
    ).json();
    const url = new URL("/ws", origin);
    url.protocol = "ws:";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    const id = String(++requestId);
    return new Promise((done, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => (ws.close(), reject(new Error(`RPC timeout ${tag}`))), 60_000);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        for (const item of [JSON.parse(event.data)].flat())
          if (item._tag === "Exit" && String(item.requestId) === id) {
            clearTimeout(timer);
            ws.close();
            item.exit?._tag === "Success"
              ? done(item.exit.value)
              : reject(new Error(`RPC ${tag}: ${JSON.stringify(item.exit).slice(0, 800)}`));
          }
      });
    });
  }
  const claudeOf = (providers) => {
    const claude = providers.find((p) => p.instanceId === "claudeAgent");
    const fiveHour = claude?.usageLimits?.windows?.find?.((window) => window.id === "five_hour");
    return {
      email: claude?.auth?.email ?? null,
      label: claude?.auth?.label ?? null,
      type: claude?.auth?.type ?? null,
      status: claude?.auth?.status ?? null,
      apiKeyBilling: claude?.auth?.apiKeyBilling === true,
      fiveHourPercent: fiveHour?.usedPercent ?? null,
      usageMessage: claude?.usageLimits?.unavailable?.message ?? null,
      accountChangedAt: claude?.usageLimits?.accountChangedAt ?? null,
    };
  };
  const claudeNow = async () => claudeOf((await rpc("server.getConfig", {})).providers ?? []);
  const waitFor = async (label, predicate, limitMs = 30_000) => {
    const started = Date.now();
    for (;;) {
      const now = await claudeNow();
      if (predicate(now)) return { ms: Date.now() - started, claude: now };
      if (Date.now() - started > limitMs) {
        receipt.failures.push(`${label}: still ${JSON.stringify(now)} after ${limitMs} ms`);
        return { ms: null, claude: now };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const first = await waitFor("first read", (c) => c.email === PERSONAL.emailAddress, 90_000);
  step("signed in as the personal account", first);

  await rpc("projects.mutate", {
    type: "project.create",
    commandId: "create-account-switch",
    projectId: "account-switch",
    title: "Account switch",
    workspaceRoot: work,
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
    ),
  );
  const openProject = async () => {
    await page.goto(`${origin}/`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const inSidebar = page.getByText("Account switch", { exact: true }).first();
    if (await inSidebar.isVisible().catch(() => false)) await inSidebar.click();
    else {
      await page.goto(`${origin}/settings/archived`);
      await page
        .locator("[data-automated-projects], [data-archived-projects]")
        .getByRole("link", { name: "Account switch", exact: true })
        .first()
        .click();
    }
    await page.locator("#project-prompt:visible").waitFor();
  };
  const send = async (text) => {
    const prompt = page.locator("#project-prompt:visible");
    await prompt.click();
    await prompt.fill(text);
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.keyboard.press("Enter");
      const taken = await page
        .waitForFunction(() => document.querySelector("#project-prompt")?.value === "", null, {
          timeout: 5000,
        })
        .then(
          () => true,
          () => false,
        );
      if (taken) return;
      await prompt.click();
    }
    throw new Error(`the host never took "${text}"`);
  };
  /** Every "Served by" reply on the page, oldest first. */
  const servedLines = async () =>
    [
      ...(await page.locator("body").innerText()).matchAll(
        /Served by (\S+) in claude process (\d+)/g,
      ),
    ].map((match) => ({ email: match[1], pid: Number(match[2]) }));
  let asked = 0;
  /** Sends a message and reads which account and process served it. */
  const ask = async (text) => {
    // A reopened conversation loads its history first: count only once all earlier replies show.
    const before = asked;
    await page.waitForFunction(
      (count) =>
        (document.body.innerText.match(/Served by \S+ in claude process \d+/g)?.length ?? 0) >=
        count,
      before,
      { timeout: 60_000 },
    );
    asked += 1;
    await send(text);
    await page.waitForFunction(
      (count) =>
        (document.body.innerText.match(/Served by \S+ in claude process \d+/g)?.length ?? 0) >
        count,
      before,
      { timeout: 60_000 },
    );
    return (await servedLines()).at(-1);
  };
  const surfaces = async (tag) => {
    await page.goto(`${origin}/settings/providers`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page
      .getByText(/Claude/)
      .first()
      .waitFor();
    await shot(`${tag}-settings-providers.png`);
    await page.goto(`${origin}/usage`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const limits = page
      .getByRole("tab", { name: /Limits/i })
      .or(page.getByRole("button", { name: /^Limits$/i }));
    if (
      await limits
        .first()
        .isVisible()
        .catch(() => false)
    )
      await limits.first().click();
    await page.waitForTimeout(800);
    await shot(`${tag}-usage-limits.png`);
  };

  await openProject();
  const turn1 = await ask("Which account serves this turn?");
  const firstPid = turn1.pid;
  step("turn 1", turn1);
  if (turn1.email !== PERSONAL.emailAddress)
    receipt.failures.push(`turn 1 served by ${turn1.email}`);
  await shot("1-personal-composer.png");
  await surfaces("1-personal");

  // A terminal `/login` to another account, while the app keeps running. No click.
  await openProject();
  signIn(ENTERPRISE);
  const watched = await waitFor(
    "watcher after /login",
    (c) =>
      c.email === ENTERPRISE.emailAddress && c.fiveHourPercent !== PERSONAL.fixtureFiveHourPercent,
  );
  step("terminal /login to the enterprise account, no click", watched);
  await page.waitForTimeout(500);
  await shot("2-enterprise-composer-live.png");
  const turn2 = await ask("And which account serves this one?");
  step("turn 2 after the switch", { ...turn2, replacedProcess: turn2.pid !== firstPid });
  if (turn2.email !== ENTERPRISE.emailAddress || turn2.pid === firstPid)
    receipt.failures.push(
      `turn 2 after the switch served by ${turn2.email} in ${turn2.pid === firstPid ? "the old" : "a new"} process`,
    );
  await shot("2-enterprise-composer-turn.png");
  await surfaces("2-enterprise");

  // The refresh a person presses, sent the moment the file changes: before the
  // watcher's debounce, and without `fresh`, the way older clients ask. It must
  // already answer the new account rather than the cached one.
  signIn(PERSONAL);
  const pressed = claudeOf((await rpc("server.refreshProviders", {})).providers ?? []);
  step("plain refresh at the moment of the switch back", { claude: pressed });
  if (pressed.email !== PERSONAL.emailAddress)
    receipt.failures.push(`plain refresh answered ${pressed.email}, not the new account`);
  const freshPressed = claudeOf(
    (await rpc("server.refreshProviders", { fresh: true })).providers ?? [],
  );
  step("pressed Refresh (fresh, untargeted)", { claude: freshPressed });

  // A Claude Console sign-in: a profile that outranks `.claude.json`, which is untouched.
  consoleSignIn();
  const consoleRead = await waitFor(
    "watcher after Console sign-in",
    (c) => c.apiKeyBilling || /Console/i.test(`${c.label} ${c.usageMessage}`),
  );
  step("Console profile sign-in, no click", consoleRead);
  // The next turn must bill the Console profile, not keep the subscription's process.
  await openProject();
  const turn3 = await ask("Which account serves this turn now?");
  step("turn 3 after the Console sign-in", turn3);
  if (turn3.email !== "api@console.example.invalid")
    receipt.failures.push(`turn 3 after the Console sign-in served by ${turn3.email}`);
  await shot("3-console-composer-turn.png");
  await surfaces("3-console");
  consoleSignOut();
  const backRead = await waitFor(
    "watcher after Console sign-out",
    (c) => !c.apiKeyBilling && c.email === PERSONAL.emailAddress && !/Console/i.test(`${c.label}`),
  );
  step("Console profile sign-out, no click", backRead);
  await openProject();
  const turn4 = await ask("And after the Console sign-out?");
  step("turn 4 after the Console sign-out", turn4);
  if (turn4.email !== PERSONAL.emailAddress)
    receipt.failures.push(`turn 4 after the Console sign-out served by ${turn4.email}`);
  await shot("4-personal-again-composer-turn.png");
  await surfaces("4-personal-again");
} catch (error) {
  receipt.failures.push(String(error?.stack ?? error).slice(0, 2000));
  if (page) await shot("failure.png").catch(() => undefined);
} finally {
  await browser?.close().catch(() => undefined);
  stop();
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  writeFileSync(
    join(out, "server.log"),
    output.replace(/Token: \S+/g, "Token: <omitted>").replace(/token=[^\s&]+/gi, "token=<omitted>"),
  );
  console.log(receipt.failures.length ? `FAILED: ${receipt.failures.join("\n")}` : "PASSED");
  process.exitCode = receipt.failures.length ? 1 : 0;
}
