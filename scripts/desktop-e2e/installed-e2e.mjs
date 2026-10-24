#!/usr/bin/env node
// End-to-end check of an INSTALLED SpecWithCode desktop app on Windows, Linux
// or macOS. It starts the server bundled in the installed resources with the
// installed executable as Node (ELECTRON_RUN_AS_NODE=1, as the desktop app
// starts its backend), pairs a headless Chromium through the bundled CLI, runs
// a deterministic offline ACP agent as a provider instance, and proves that a
// thread and the project coordinator answer a message.
//
// Usage:
//   node scripts/desktop-e2e/installed-e2e.mjs --app <installed executable> --out <dir>
//     [--keep-scratch] [--timeout-ms 180000]
//
// --app   Windows: %LOCALAPPDATA%\Programs\SpecWithCode\SpecWithCode.exe
//         Linux:   /opt/SpecWithCode/specweave-studio-desktop (or an extracted AppImage binary)
//         macOS:   /Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode
// --out   Directory for results.json, screenshots and logs.
//
// Needs playwright-core (resolved from apps/server/node_modules) and its
// Chromium headless shell:
//   node apps/server/node_modules/playwright-core/cli.js install --only-shell chromium
//
// Everything runs in a throwaway HOME and data directory on a free loopback
// port (never 8319). Only the processes this script starts are stopped.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const SCRIPT_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.resolve(SCRIPT_DIR, "../..");
// oxlint-disable-next-line studio/no-global-process-runtime -- Standalone CI check has no Effect runtime.
const PLATFORM = NodeOS.platform();
// oxlint-disable-next-line studio/no-global-process-runtime -- Standalone CI check has no Effect runtime.
const ARCH = NodeOS.arch();
const IS_WIN = PLATFORM === "win32";
const RESERVED_PORT = 8319;
const PROVIDER_INSTANCE_ID = "e2e-fake";
const MODEL_ID = "fake-e2e-1";
const MODEL_SELECTION = { instanceId: PROVIDER_INSTANCE_ID, model: MODEL_ID };
const PROJECT_TITLE = "E2E project";

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")
    ? argv[index + 1]
    : undefined;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "Usage: node scripts/desktop-e2e/installed-e2e.mjs --app <executable> --out <dir> [--keep-scratch] [--timeout-ms N]",
  );
  process.exit(0);
}
const APP = option("--app") ? NodePath.resolve(option("--app")) : undefined;
const OUT = option("--out") ? NodePath.resolve(option("--out")) : undefined;
const KEEP_SCRATCH = argv.includes("--keep-scratch");
const TIMEOUT_MS = Number(option("--timeout-ms") ?? 180_000);
if (!APP || !OUT) {
  console.error("installed-e2e: --app <installed executable> and --out <dir> are required.");
  process.exit(2);
}
if (!NodeFS.existsSync(APP)) {
  console.error(`installed-e2e: the app executable does not exist: ${APP}`);
  process.exit(2);
}
NodeFS.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- scratch isolation
const REAL_DATA_DIRS = [".specwithcode", ".specweave-studio"].map((name) =>
  NodePath.resolve(NodeOS.homedir(), name),
);
const insideRealData = (candidate) => {
  const resolved = NodePath.resolve(candidate);
  return REAL_DATA_DIRS.some((dir) => resolved === dir || resolved.startsWith(dir + NodePath.sep));
};
if (insideRealData(OUT)) {
  console.error(`installed-e2e: refusing to write into real SpecWithCode data: ${OUT}`);
  process.exit(2);
}
const SCRATCH = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-e2e-")));
if (insideRealData(SCRATCH)) throw new Error(`Scratch directory is inside real data: ${SCRATCH}`);
const HOME = NodePath.join(SCRATCH, "home");
const BASE_DIR = NodePath.join(SCRATCH, "base");
const PROJECT_DIR = NodePath.join(SCRATCH, "project");
const AGENT_DIR = NodePath.join(SCRATCH, "agent");
for (const dir of [HOME, BASE_DIR, PROJECT_DIR, AGENT_DIR])
  NodeFS.mkdirSync(dir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(PROJECT_DIR, "README.md"), "# SpecWithCode installed e2e\n");

const FAKE_ACP_LOG = NodePath.join(OUT, "fake-acp.jsonl");
const SERVER_LOG = NodePath.join(OUT, "server.log");
for (const file of [FAKE_ACP_LOG, SERVER_LOG, NodePath.join(OUT, "results.json")])
  NodeFS.rmSync(file, { force: true });
// Screenshots from an earlier run in the same --out.
for (const file of NodeFS.readdirSync(OUT))
  if (/^\d\d-.*\.png$/u.test(file)) NodeFS.rmSync(NodePath.join(OUT, file));

// ---------------------------------------------------------------- results
const log = (...parts) => console.log(`[installed-e2e ${new Date().toISOString()}]`, ...parts);
const results = {
  app: APP,
  platform: PLATFORM,
  arch: ARCH,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  scratch: SCRATCH,
  baseDir: BASE_DIR,
  home: HOME,
  port: null,
  serverPid: null,
  headless: true,
  checks: [],
  consoleErrors: [],
  cleanup: [],
};
const record = (name, pass, observed = {}) => {
  results.checks.push({ name, status: pass ? "pass" : "fail", ...observed });
  log(pass ? "PASS" : "FAIL", name, pass ? "" : JSON.stringify(observed).slice(0, 600));
  return pass;
};
const writeResults = () =>
  NodeFS.writeFileSync(NodePath.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
const errorText = (error) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];

// ---------------------------------------------------------------- environment
// Child environment: a small allowlist of the runner's variables, never the
// caller's SpecWithCode, provider or Electron settings, plus a scratch HOME.
const INHERITED = IS_WIN
  ? [
      "PATH",
      "Path",
      "SystemRoot",
      "SYSTEMROOT",
      "windir",
      "COMSPEC",
      "ComSpec",
      "PATHEXT",
      "TEMP",
      "TMP",
      "ProgramData",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "CommonProgramFiles",
      "CommonProgramFiles(x86)",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE",
      "OS",
      "SystemDrive",
      "USERNAME",
      "USERDOMAIN",
    ]
  : ["TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"];
const childEnv = Object.fromEntries(
  INHERITED.filter((name) => process.env[name] !== undefined).map((name) => [
    name,
    process.env[name],
  ]),
);
Object.assign(childEnv, {
  HOME,
  XDG_CONFIG_HOME: NodePath.join(HOME, ".config"),
  XDG_DATA_HOME: NodePath.join(HOME, ".local", "share"),
  XDG_STATE_HOME: NodePath.join(HOME, ".local", "state"),
  XDG_CACHE_HOME: NodePath.join(HOME, ".cache"),
  ELECTRON_RUN_AS_NODE: "1",
  STUDIO_HOME: BASE_DIR,
  STUDIO_DESKTOP_TEST_OFFSCREEN: "1",
  STUDIO_NO_BROWSER: "true",
  SWC_E2E_FAKE_ACP_LOG: FAKE_ACP_LOG,
});
if (IS_WIN) {
  Object.assign(childEnv, {
    USERPROFILE: HOME,
    APPDATA: NodePath.join(HOME, "AppData", "Roaming"),
    LOCALAPPDATA: NodePath.join(HOME, "AppData", "Local"),
  });
  NodeFS.mkdirSync(childEnv.APPDATA, { recursive: true });
  NodeFS.mkdirSync(childEnv.LOCALAPPDATA, { recursive: true });
} else {
  // System tools only (git, sh), so no locally installed agent CLI is detected.
  childEnv.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  childEnv.LANG ??= "en_US.UTF-8";
}

// ---------------------------------------------------------------- process tracking
let serverProcess = null;
let serverExit = null;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const killTree = async (pid, label) => {
  if (!pid || !alive(pid)) return;
  if (IS_WIN) {
    NodeChildProcess.spawnSync("taskkill", ["/T", "/PID", String(pid)], { stdio: "ignore" });
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
    if (alive(pid))
      NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
      });
  } else {
    // The server leads its own process group (detached spawn).
    const signal = (sig) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {}
      }
    };
    signal("SIGTERM");
    for (let i = 0; i < 60 && alive(pid); i++) await sleep(250);
    if (alive(pid)) signal("SIGKILL");
  }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  results.cleanup.push({ pid, label, stopped: !alive(pid) });
};

const fakeAgentPids = () => {
  try {
    return [
      ...new Set(
        NodeFS.readFileSync(FAKE_ACP_LOG, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.event === "start")
          .map((entry) => entry.pid),
      ),
    ];
  } catch {
    return [];
  }
};

let cleanedUp = false;
const cleanup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  if (serverProcess && serverExit === null) await killTree(serverProcess.pid, "server");
  // Fake agents the server started for this run, in case any outlived it.
  for (const pid of fakeAgentPids()) if (alive(pid)) await killTree(pid, "fake-acp-agent");
  if (!KEEP_SCRATCH) {
    try {
      NodeFS.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      results.cleanup.push({ scratch: SCRATCH, removed: false, reason: errorText(error) });
    }
  }
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    results.checks.push({ name: "interrupted", status: "fail", signal: sig });
    cleanup().finally(() => {
      results.finishedAt = new Date().toISOString();
      writeResults();
      process.exit(130);
    });
  });
}

// ---------------------------------------------------------------- helpers
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const runApp = (args, { timeout = TIMEOUT_MS } = {}) => {
  const result = NodeChildProcess.spawnSync(APP, args, {
    cwd: HOME,
    env: childEnv,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? errorText(result.error) : null,
  };
};

const resolveServerEntry = () => {
  const resources =
    PLATFORM === "darwin"
      ? NodePath.resolve(NodePath.dirname(APP), "..", "Resources")
      : NodePath.join(NodePath.dirname(APP), "resources");
  // Packaged Windows ships the server tree in the server.asar sidecar; macOS
  // and Linux keep it in app.asar (apps/desktop/src/app/DesktopEnvironment.ts).
  const roots = ["server.asar", "app.asar", "app"].map((name) => NodePath.join(resources, name));
  const candidates = roots
    .filter((root) => NodeFS.existsSync(root))
    .map((root) => NodePath.join(root, "apps", "server", "dist", "bin.mjs"));
  // Plain Node cannot see inside an asar; ask the installed runtime.
  const probe = runApp(
    [
      "-e",
      "const fs=require('fs');process.stdout.write(JSON.stringify(process.argv.slice(1).map(p=>fs.existsSync(p))))",
      ...candidates,
    ],
    { timeout: 60_000 },
  );
  let found = [];
  try {
    found = JSON.parse(probe.stdout.trim() || "[]");
  } catch {}
  const entry = candidates.find((_, index) => found[index] === true) ?? null;
  return { resources, candidates, entry, probe };
};

const waitFor = async (what, fn, { timeout = TIMEOUT_MS, interval = 1000 } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (serverExit !== null)
      throw new Error(`server exited (${JSON.stringify(serverExit)}) while waiting for ${what}`);
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${errorText(last)}` : ""}`);
};

const loadPlaywright = () => {
  const require = NodeModule.createRequire(
    NodePath.join(REPO_ROOT, "apps", "server", "package.json"),
  );
  return require("playwright-core");
};

// ---------------------------------------------------------------- run
let browser = null;
const main = async () => {
  // 1. Locate and start the bundled server.
  const located = resolveServerEntry();
  const versionProbe = located.entry
    ? runApp([located.entry, "--version"], { timeout: 60_000 })
    : null;
  const bundledVersion =
    versionProbe?.stdout.trim().split(/\s+/u).pop()?.replace(/^v/u, "") ?? null;
  if (
    !record("bundled-server-entry", located.entry !== null && versionProbe?.status === 0, {
      resources: located.resources,
      candidates: located.candidates,
      entry: located.entry,
      version: bundledVersion,
      probeError: located.entry
        ? undefined
        : located.probe.stderr.slice(0, 600) || located.probe.error,
    })
  )
    return;

  let port = await freePort();
  while (port === RESERVED_PORT) port = await freePort();
  results.port = port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = NodeFS.openSync(SERVER_LOG, "a");
  serverProcess = NodeChildProcess.spawn(
    APP,
    [located.entry, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", BASE_DIR],
    {
      cwd: HOME,
      env: childEnv,
      stdio: ["ignore", serverLog, serverLog],
      detached: !IS_WIN,
      windowsHide: true,
    },
  );
  results.serverPid = serverProcess.pid;
  serverProcess.on("exit", (code, signal) => (serverExit = { code, signal }));
  log("server PID", serverProcess.pid, "port", port);

  let environment;
  try {
    environment = await waitFor("server readiness", async () => {
      const response = await fetch(`${baseUrl}/.well-known/studio/environment`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? response.json() : null;
    });
  } catch (error) {
    record("server-start", false, { reason: errorText(error), log: SERVER_LOG });
    return;
  }
  record("server-start", environment.serverVersion === bundledVersion, {
    pid: serverProcess.pid,
    url: baseUrl,
    serverVersion: environment.serverVersion,
    bundledVersion,
    platform: environment.platform,
    environmentId: environment.environmentId,
  });

  // 2. Pairing link from the bundled CLI, opened in headless Chromium.
  const pairing = runApp([
    located.entry,
    "auth",
    "pairing",
    "create",
    "--base-dir",
    BASE_DIR,
    "--ttl",
    "30m",
    "--label",
    "e2e",
    "--base-url",
    baseUrl,
    "--json",
  ]);
  let pairUrl = null;
  try {
    const text = pairing.stdout;
    pairUrl = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).pairUrl ?? null;
  } catch {}
  if (
    !record(
      "pairing-link",
      pairing.status === 0 && typeof pairUrl === "string" && pairUrl.startsWith(baseUrl),
      {
        exitCode: pairing.status,
        pairUrlOrigin: pairUrl ? new URL(pairUrl).origin : null,
        stderr: pairing.status === 0 ? undefined : pairing.stderr.slice(0, 600),
      },
    )
  )
    return;

  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: true, timeout: TIMEOUT_MS });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("console", (message) => {
    if (message.type() === "error") results.consoleErrors.push(message.text().slice(0, 400));
  });
  page.on("pageerror", (error) =>
    results.consoleErrors.push(`pageerror: ${error.message.slice(0, 400)}`),
  );
  const shot = async (name) => {
    const file = NodePath.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, animations: "disabled" }).catch(() => {});
    return NodeFS.existsSync(file) ? file : null;
  };

  // Effect RPC (JSON serialization) over the page's cookie-authenticated /ws.
  const rpc = (calls, waitMs = 60_000) =>
    page.evaluate(
      async ({ calls, waitMs, appVersion }) => {
        const ws = new WebSocket(
          `${location.origin.replace("http", "ws")}/ws?clientSurface=web&clientAppVersion=${encodeURIComponent(appVersion)}&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2`,
        );
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
        });
        const out = {};
        ws.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message._tag === "Exit") out[message.requestId] = message.exit;
          else if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        });
        calls.forEach((call, index) =>
          ws.send(
            JSON.stringify({
              _tag: "Request",
              id: String(index + 1),
              tag: call.tag,
              payload: call.payload,
              headers: [],
            }),
          ),
        );
        const start = Date.now();
        while (Object.keys(out).length < calls.length && Date.now() - start < waitMs) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        ws.close();
        return calls.map((_, index) => out[String(index + 1)] ?? { _tag: "Timeout" });
      },
      { calls, waitMs, appVersion: environment.serverVersion },
    );
  const rpcOne = async (tag, payload, waitMs) => {
    const [exit] = await rpc([{ tag, payload }], waitMs);
    if (exit?._tag !== "Success") throw new Error(`${tag}: ${JSON.stringify(exit).slice(0, 600)}`);
    return exit.value;
  };

  const wizardSteps = [];
  try {
    await page.goto(pairUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    const nav = page.getByRole("navigation", { name: "Projects and chats" });
    const wizard = page.getByRole("dialog").filter({ hasText: "SpecWithCode" }).first();
    // First-run wizard: choose this machine as the main one, then skip the
    // agent and project-import steps.
    const wizardButtons = [
      /up as my main machine/u,
      /^Do not import projects$/u,
      /^Skip/u,
      /^Continue$/u,
      /^(Finish|Done|Get started|Close)$/u,
    ];
    // isVisible() does not wait, so poll until the sidebar is usable.
    const deadline = Date.now() + TIMEOUT_MS;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (await wizard.isVisible().catch(() => false)) {
        let clicked = null;
        for (const name of wizardButtons) {
          const button = wizard.getByRole("button", { name }).last();
          if (
            (await button.isVisible().catch(() => false)) &&
            (await button.isEnabled().catch(() => false))
          ) {
            clicked = (await button.innerText().catch(() => String(name))).trim().split("\n")[0];
            await button.click();
            break;
          }
        }
        if (clicked) wizardSteps.push(clicked);
        if (wizardSteps.length > 12) throw new Error("the first-run wizard did not finish");
      } else {
        ready = await nav.isVisible().catch(() => false);
      }
      if (!ready) await page.waitForTimeout(1000);
    }
    if (!ready) throw new Error("the sidebar navigation 'Projects and chats' never became visible");
    record("pairing-authenticated-ui", true, {
      url: new URL(page.url()).pathname,
      wizardSteps,
      screenshot: await shot("01-paired"),
    });
  } catch (error) {
    record("pairing-authenticated-ui", false, {
      reason: errorText(error),
      wizardSteps,
      screenshot: await shot("01-paired-FAILED"),
    });
    return;
  }

  // 3. Fake ACP agent as a local provider instance.
  const agentScript = NodePath.join(AGENT_DIR, "fake-acp-agent.mjs");
  NodeFS.copyFileSync(NodePath.join(SCRIPT_DIR, "fake-acp-agent.mjs"), agentScript);
  let commandPath;
  let commandArgs;
  if (IS_WIN) {
    // Local ACP commands launch without a shell and refuse .cmd/.bat, so run
    // the installed executable itself; it inherits ELECTRON_RUN_AS_NODE=1 from
    // the server's environment.
    commandPath = APP;
    commandArgs = [agentScript];
  } else {
    // A wrapper sets ELECTRON_RUN_AS_NODE itself, because the Linux cgroup
    // wrapper unsets it before starting the agent.
    commandPath = NodePath.join(AGENT_DIR, "swc-e2e-agent");
    NodeFS.writeFileSync(
      commandPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE\nexec ${JSON.stringify(APP)} ${JSON.stringify(agentScript)} "$@"\n`,
    );
    NodeFS.chmodSync(commandPath, 0o755);
    commandArgs = [];
  }
  let provider = null;
  try {
    await rpcOne("server.updateSettings", {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId: PROVIDER_INSTANCE_ID,
        instance: {
          driver: "acpRegistry",
          displayName: "E2E Fake Agent",
          enabled: true,
          config: { source: "local", agentId: "", commandPath, commandArgs },
        },
      },
    });
    provider = await waitFor(
      "fake provider ready",
      async () => {
        const config = await rpcOne("server.getConfig", {}, 30_000);
        const entry = (config.providers ?? []).find((p) => p.instanceId === PROVIDER_INSTANCE_ID);
        const models = (entry?.models ?? []).map((m) => m.slug);
        provider = entry
          ? {
              providerStatus: entry.status,
              installed: entry.installed,
              enabled: entry.enabled,
              message: entry.message,
              models,
            }
          : null;
        const usable = entry && (entry.status === "ready" || entry.status === "warning");
        return usable && models.includes(MODEL_ID) ? provider : null;
      },
      { interval: 2000 },
    );
    record("fake-provider-registered", true, {
      instanceId: PROVIDER_INSTANCE_ID,
      commandPath,
      commandArgs,
      ...provider,
    });
    // Sign in as a person would from Settings > Providers. A provider whose
    // sign-in is unknown never runs the project coordinator.
    await rpcOne("provider.auth.start", {
      instanceId: PROVIDER_INSTANCE_ID,
      methodId: "e2e-sign-in",
    });
    const auth = await waitFor(
      "fake provider signed in",
      async () => {
        const config = await rpcOne("server.getConfig", {}, 30_000);
        const entry = (config.providers ?? []).find((p) => p.instanceId === PROVIDER_INSTANCE_ID);
        return entry?.auth?.status === "authenticated" ? entry.auth : null;
      },
      { interval: 1000 },
    );
    record("fake-provider-signed-in", true, { auth });
  } catch (error) {
    record("fake-provider-registered", false, {
      reason: errorText(error),
      commandPath,
      commandArgs,
      lastSeen: provider,
    });
    return;
  }

  // Project for the scratch folder, on the fake provider.
  const projectId = `e2e-${NodeCrypto.randomUUID()}`;
  try {
    const project = await rpcOne("projects.mutate", {
      type: "project.create",
      commandId: `e2e-project-${NodeCrypto.randomUUID()}`,
      projectId,
      title: PROJECT_TITLE,
      workspaceRoot: PROJECT_DIR,
      defaultModelSelection: MODEL_SELECTION,
    });
    // Create starts a project on this host's default model; choose the fake agent
    // the way the project settings do, so the coordinator runs on it.
    await rpcOne("projects.mutate", {
      type: "project.update",
      commandId: `e2e-project-model-${NodeCrypto.randomUUID()}`,
      projectId,
      defaultModelSelection: MODEL_SELECTION,
    });
    record("project-created", project?.id === projectId, {
      projectId,
      title: project?.title,
      workspaceRoot: project?.workspaceRoot,
    });
  } catch (error) {
    record("project-created", false, { reason: errorText(error), projectId });
    return;
  }

  const assistantReply = async (threadId, token) => {
    const projection = await rpcOne("orchestration.getThreadProjection", { threadId }, 30_000);
    const messages = projection?.messages ?? [];
    const reply = messages.find(
      (m) => m.role === "assistant" && !m.streaming && m.text.includes(token),
    );
    return reply ? { messageId: reply.id, text: reply.text, messageCount: messages.length } : null;
  };

  // Thread on the fake provider: created through orchestration, prompted
  // through the web composer, answered by the agent.
  const threadId = `thread:project:${projectId}:${NodeCrypto.randomUUID()}`;
  const threadToken = `E2E-THREAD-${NodeCrypto.randomBytes(4).toString("hex")}`;
  try {
    await rpcOne("orchestration.dispatchCommand", {
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: `e2e-thread-${NodeCrypto.randomUUID()}`,
      threadId,
      projectId,
      title: "E2E thread",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    await page.goto(
      `${baseUrl}/${encodeURIComponent(environment.environmentId)}/${encodeURIComponent(threadId)}`,
      {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_MS,
      },
    );
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await composer.fill(`Reply with the token ${threadToken}`);
    // The composer can still be hydrating right after navigation, so send with
    // Enter, then with the Send button, until the server has the message.
    const userMessageArrived = async () => {
      const projection = await rpcOne("orchestration.getThreadProjection", { threadId }, 30_000);
      return (projection?.messages ?? []).some(
        (m) => m.role === "user" && m.text.includes(threadToken),
      );
    };
    let sendAttempts = 0;
    for (; sendAttempts < 4 && !(await userMessageArrived()); sendAttempts++) {
      if (sendAttempts === 0) await composer.press("Enter");
      else await page.getByRole("button", { name: "Send message" }).click({ timeout: 10_000 });
      await waitFor("thread message to reach the server", userMessageArrived, {
        timeout: 10_000,
      }).catch(() => {});
    }
    const reply = await waitFor("thread reply", () => assistantReply(threadId, threadToken), {
      interval: 1500,
    });
    const visible = await page
      .getByText(`E2E fake agent reply ${threadToken}`)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    record("thread-reply", visible, {
      threadId,
      sendAttempts,
      token: threadToken,
      apiReply: reply.text,
      visibleInUi: visible,
      screenshot: await shot("02-thread-reply"),
    });
  } catch (error) {
    record("thread-reply", false, {
      threadId,
      token: threadToken,
      reason: errorText(error),
      screenshot: await shot("02-thread-reply-FAILED"),
    });
  }

  // 4. The project coordinator answers one message on the same provider.
  const coordinatorToken = `E2E-COORDINATOR-${NodeCrypto.randomBytes(4).toString("hex")}`;
  try {
    const sent = await rpcOne("projects.coordinatorSend", {
      projectId,
      commandId: `e2e-coordinator-${NodeCrypto.randomUUID()}`,
      prompt: `Reply with the token ${coordinatorToken}`,
    });
    const reply = await waitFor(
      "coordinator reply",
      () => assistantReply(sent.threadId, coordinatorToken),
      { interval: 1500 },
    );
    // The project page shows its coordinator in the main column.
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    const sidebar = page.getByRole("navigation", { name: "Projects and chats" });
    const projectLink = sidebar.getByRole("link", { name: PROJECT_TITLE }).first();
    // A project in a temporary folder (/tmp on Linux) is listed under Automated,
    // which starts collapsed; open that group the way a person would.
    const automated = sidebar.getByRole("button", { name: /^Automated \(\d+\)/ });
    await Promise.race([
      projectLink.waitFor({ state: "visible", timeout: 60_000 }),
      automated.waitFor({ state: "visible", timeout: 60_000 }),
    ]);
    if (!(await projectLink.isVisible())) await automated.click({ timeout: 10_000 });
    await projectLink.click({ timeout: 60_000 });
    const visible = await page
      .getByText(`E2E fake agent reply ${coordinatorToken}`)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    record("coordinator-reply", visible, {
      threadId: sent.threadId,
      created: sent.created,
      token: coordinatorToken,
      apiReply: reply.text,
      visibleInUi: visible,
      screenshot: await shot("03-coordinator-reply"),
    });
  } catch (error) {
    record("coordinator-reply", false, {
      token: coordinatorToken,
      reason: errorText(error),
      screenshot: await shot("03-coordinator-reply-FAILED"),
    });
  }

  // The replies came from the fake agent, started with the installed runtime.
  const prompts = (() => {
    try {
      return NodeFS.readFileSync(FAKE_ACP_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  const answered = prompts.filter((entry) => entry.event === "prompt").map((entry) => entry.token);
  record("fake-agent-log", answered.includes(threadToken) && answered.includes(coordinatorToken), {
    log: FAKE_ACP_LOG,
    agentPids: fakeAgentPids(),
    answeredTokens: answered,
  });
};

let exitCode = 1;
try {
  await main();
} catch (error) {
  record("harness", false, {
    reason: errorText(error),
    stack: error?.stack?.split("\n").slice(0, 6),
  });
} finally {
  await browser?.close().catch(() => {});
  await cleanup();
  results.ok =
    results.checks.length > 0 && results.checks.every((check) => check.status === "pass");
  results.finishedAt = new Date().toISOString();
  writeResults();
  exitCode = results.ok ? 0 : 1;
  log(results.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED", NodePath.join(OUT, "results.json"));
}
process.exit(exitCode);
