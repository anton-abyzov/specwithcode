#!/usr/bin/env node
// Headless installed-app capture of the thread timeline for SpecWeave increment 1011 (activity
// diffs and compact output). It reproduces the before recipe that ran outside the repo
// (studio-audit-evidence/activity-diffs/capture.mjs with steps-activity.mjs and
// steps-explore.mjs) so the after set covers the same scenario at the same widths and themes.
//
// The installed server runs against a new private state folder under
// ~/.local/share/specweave-studio/verification/activity-diffs-<phase>/ with a private HOME and
// every native driver disabled. One acpRegistry instance runs node on
// apps/server/scripts/acp-mock-agent.ts with STUDIO_ACP_ACTIVITY_SCENARIO=1, which plays two
// scripted turns inside a scratch git repository in that folder. No model is called.
//
// Usage: node scripts/studio-verify/activity-diffs-capture.mjs --phase before|after|explore
//          [--expect-commit <sha>] <report-dir>
//   --phase before   only the installed 1.0.74 bundle.
//   --phase after    the installed release v<bundleVersion>; --expect-commit names the 1011
//                    merge commit, which must be an ancestor of that tag in this repository.
//   --phase explore  button and text dumps for tuning selectors; never acceptance evidence.
// Every phase refuses to overwrite an existing receipt.json in the report directory.
// STUDIO_CAPTURE_APP overrides /Applications/SpecWithCode.app. STUDIO_SERVER_ENTRY runs a
// source build (explore only). STUDIO_PLAYWRIGHT_MODULE and STUDIO_CHROMIUM_EXECUTABLE pick
// the headless browser.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

export const INCREMENT = "1011-activity-diffs-and-compact-output";
export const BEFORE_VERSION = "1.0.74";
export const PHASES = Object.freeze(["before", "after", "explore"]);
export const PAGING_FIXTURE_ONLY = "paging proven by the fixture only";
export const MOCK_AGENT_PATH = join(root, "apps/server/scripts/acp-mock-agent.ts");
export const MOCK_INSTANCE_ID = "fixture";
export const MOCK_DISPLAY_NAME = "Activity mock";
const MOCK_MODEL = "default";
const NATIVE_DRIVERS = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
const USAGE =
  "usage: activity-diffs-capture.mjs --phase before|after|explore [--expect-commit <sha>] <report-dir>";

/** A guard refused the run before anything started. */
export class CaptureRefusal extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "CaptureRefusal";
    this.exitCode = exitCode;
  }
}

export function parseCaptureArgs(argv) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--phase" || arg === "--expect-commit") {
      if (index + 1 >= argv.length) throw new CaptureRefusal(`${arg} needs a value. ${USAGE}`);
      options.set(arg, argv[++index]);
    } else if (arg.startsWith("--")) {
      throw new CaptureRefusal(`unknown option ${arg}. ${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  const phase = options.get("--phase");
  if (!PHASES.includes(phase) || positional.length !== 1 || !positional[0]) {
    throw new CaptureRefusal(USAGE);
  }
  const expectCommit = options.get("--expect-commit");
  if (phase !== "after" && expectCommit !== undefined) {
    throw new CaptureRefusal("--expect-commit applies only to --phase after");
  }
  if (phase === "after") assertCommitArgument(expectCommit);
  return { phase, expectCommit, reportDir: resolve(positional[0]) };
}

function assertCommitArgument(expectCommit) {
  if (typeof expectCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(expectCommit)) {
    throw new CaptureRefusal(
      `refusing --phase after: --expect-commit <sha> must name the 1011 merge commit (got ${JSON.stringify(expectCommit ?? null)})`,
    );
  }
}

/** Phase guard: before is only installed 1.0.74, after only an installed release. */
export function assertPhaseAllowed({ phase, bundleVersion, sourceEntry }) {
  if (phase === "before" && (sourceEntry || bundleVersion !== BEFORE_VERSION)) {
    throw new CaptureRefusal(
      `refusing --phase before: bundleVersion=${sourceEntry ? "source build" : (bundleVersion ?? "unknown")}, expected installed ${BEFORE_VERSION}`,
    );
  }
  if (phase === "after" && (sourceEntry || !bundleVersion)) {
    throw new CaptureRefusal(
      "refusing --phase after: the after set comes from an installed release, not a source build",
    );
  }
}

export function gitRunner(cwd) {
  return (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/**
 * Ancestry guard for the after set: the installed bundle's release tag v<bundleVersion> must
 * contain the expected (merge) commit. `git` runs in this repository.
 */
export function resolveReleaseProvenance({ bundleVersion, expectCommit, git }) {
  assertCommitArgument(expectCommit);
  if (!bundleVersion) {
    throw new CaptureRefusal("refusing --phase after: the installed bundle has no version");
  }
  const releaseTag = `v${bundleVersion}`;
  const tag = git(["rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}^{commit}`]);
  if (tag.status !== 0) {
    throw new CaptureRefusal(
      `refusing --phase after: release tag ${releaseTag} is not in this repository (fetch tags first)`,
    );
  }
  const expected = git(["rev-parse", "--verify", "--quiet", `${expectCommit}^{commit}`]);
  if (expected.status !== 0) {
    throw new CaptureRefusal(
      `refusing --phase after: commit ${expectCommit} is not in this repository`,
    );
  }
  const sourceCommit = tag.stdout.trim();
  const mergeCommit = expected.stdout.trim();
  const ancestry = git(["merge-base", "--is-ancestor", mergeCommit, sourceCommit]);
  if (ancestry.status === 1) {
    throw new CaptureRefusal(
      `refusing --phase after: ${mergeCommit} is not an ancestor of ${releaseTag} (${sourceCommit})`,
    );
  }
  if (ancestry.status !== 0) {
    throw new CaptureRefusal(
      `refusing --phase after: git merge-base --is-ancestor failed: ${ancestry.stderr.trim()}`,
    );
  }
  return { releaseTag, sourceCommit, mergeCommit };
}

export function assertNoReceipt(reportDir, exists = existsSync) {
  const receiptPath = join(reportDir, "receipt.json");
  if (exists(receiptPath)) throw new CaptureRefusal(`refusing to overwrite ${receiptPath}`, 3);
  return receiptPath;
}

/**
 * AC-16: in Normal every scenario at 1280, 720 and 390 px in light and dark; Concise, Verbose,
 * expanded rows and the Open diff clicks (edit row, card header, card row) at dark 1280. The
 * order is the capture order. The before set (reports/installed-before) has exactly these files.
 */
export const CAPTURE_PLAN = buildCapturePlan();

function buildCapturePlan() {
  const plan = [];
  const add = (group, file, viewport, theme, detail, view, thread) =>
    plan.push(
      Object.freeze({
        group,
        file: `${file}.png`,
        viewport,
        theme,
        detail,
        ...(thread ? { thread } : {}),
        view,
      }),
    );
  for (const theme of ["light", "dark"]) {
    for (const viewport of ["1280x900", "720x900", "390x844"]) {
      const tag = `normal-${theme}-${viewport.split("x")[0]}`;
      add("normal", `${tag}-edit`, viewport, theme, "normal", "as opened, fold closed", "edit");
      add(
        "normal",
        `${tag}-edit-rows`,
        viewport,
        theme,
        "normal",
        "fold and tool groups expanded",
        "edit",
      );
      add(
        "normal",
        `${tag}-edit-rows-end`,
        viewport,
        theme,
        "normal",
        "expanded, scrolled to the last rows and card",
        "edit",
      );
      add(
        "normal",
        `${tag}-readonly-rows`,
        viewport,
        theme,
        "normal",
        "fold and tool groups expanded",
        "readonly",
      );
    }
  }
  for (const detail of ["concise", "verbose"]) {
    for (const thread of ["edit", "readonly"]) {
      add(detail, `${detail}-dark-1280-${thread}`, "1280x900", "dark", detail, "as opened", thread);
      if (detail === "verbose") {
        add(
          detail,
          `${detail}-dark-1280-${thread}-top`,
          "1280x900",
          "dark",
          detail,
          "scrolled to the top of the turn",
          thread,
        );
      }
    }
  }
  const dark = (group, file, view) =>
    add(group, `${file}-dark-1280`, "1280x900", "dark", "normal", view);
  dark("expanded-row", "row-edit-expanded", "edit row expanded");
  dark("open-diff", "diff-from-edit-row", "DiffPanel after Open diff in the expanded edit row");
  dark("expanded-row", "row-failed-expanded", "failing command expanded");
  dark("expanded-row", "row-large-output-expanded", "large output expanded");
  dark(
    "expanded-row",
    "row-large-output-expanded-end",
    "large output expanded, scrolled to its end",
  );
  dark("open-diff", "diff-from-card-header", "DiffPanel after the card's Open diff");
  dark("expanded-row", "card-expanded", "changed-files card with folders expanded");
  dark("open-diff", "diff-from-card-row", "DiffPanel after clicking bufferedWriter.ts in the card");
  return Object.freeze(plan);
}

/** Compares a receipt's screenshot list with the plan (file, viewport, theme, detail). */
export function checkCapturePlan(screenshots, plan = CAPTURE_PLAN) {
  const planned = new Map(plan.map((entry) => [entry.file, entry]));
  const seen = new Set();
  const unexpected = [];
  const duplicated = [];
  const mismatched = [];
  for (const shot of screenshots) {
    const entry = planned.get(shot.file);
    if (!entry) {
      unexpected.push(shot.file);
      continue;
    }
    if (seen.has(shot.file)) duplicated.push(shot.file);
    seen.add(shot.file);
    for (const field of ["viewport", "theme", "detail"]) {
      if (shot[field] !== entry[field]) {
        mismatched.push({ file: shot.file, field, expected: entry[field], observed: shot[field] });
      }
    }
  }
  const missing = plan.filter((entry) => !seen.has(entry.file)).map((entry) => entry.file);
  return {
    ok: !missing.length && !unexpected.length && !duplicated.length && !mismatched.length,
    missing,
    unexpected,
    duplicated,
    mismatched,
  };
}

/** The receipt's paging note: the installed output proves paging only past one page. */
export function describePaging(pages) {
  const count = Array.isArray(pages) ? pages.length : 0;
  if (count <= 1) return PAGING_FIXTURE_ONLY;
  return `installed output read in ${count} pages (${pages[0].totalLength} characters)`;
}

/** Files of the scratch repository the mock agent works in (the before set's content). */
export function scratchRepoFiles() {
  return {
    "README.md": "# flush-lab\n\nScratch repository for the activity-diffs capture.\n",
    "packages/core/src/chat/flushPolicy.ts":
      "// Flush cadence shared by the chat stream.\nexport const FLUSH_INTERVAL_MS = 16;\nexport const FLUSH_JITTER_MS = 2;\n",
    "packages/client-runtime/src/stream/bufferedWriter.ts":
      'const FLUSH_INTERVAL_MS = 16; // keep in sync with core\n\nexport class BufferedWriter {\n  private chunks: string[] = [];\n  write(chunk: string) {\n    this.chunks.push(chunk);\n  }\n  flush() {\n    const text = this.chunks.join("");\n    this.chunks = [];\n    return text;\n  }\n  get intervalMs() {\n    return FLUSH_INTERVAL_MS;\n  }\n}\n',
    "docs/streaming.md":
      "# Streaming\n\nThe writer flushes every 16 ms.\n\nChunks are merged before render; see packages/core/src/chat/streaming.ts.\n",
    "packages/core/src/chat/streaming.ts": [
      'import { FLUSH_INTERVAL_MS } from "./flushPolicy";',
      "",
      "const MAX_BUFFERED_CHUNKS = 64;",
      "",
      ...Array.from({ length: 560 }, (_, i) =>
        i % 40 === 0
          ? `// Section ${i / 40 + 1}: stream state machine step ${i / 40 + 1}`
          : `export function step${i}(state: { buffered: number }) { return state.buffered > MAX_BUFFERED_CHUNKS ? FLUSH_INTERVAL_MS : ${i % 7}; }`,
      ),
      "",
    ].join("\n"),
    ".claude/skills/streaming-flush-tuning/references/SKILL.md":
      "---\nname: streaming-flush-tuning\ndescription: How to tune the chat stream flush interval without dropping chunks.\n---\n\n# Streaming flush tuning\n\n1. Change FLUSH_INTERVAL_MS in every copy.\n2. Keep MAX_BUFFERED_CHUNKS at least four times the chunks per interval.\n3. Run node --test test/streaming.test.mjs.\n",
    "test/streaming.test.mjs":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\n\ntest("flush interval stays at 16 ms", () => {\n  const source = readFileSync(new URL("../packages/core/src/chat/flushPolicy.ts", import.meta.url), "utf8");\n  assert.match(source, /FLUSH_INTERVAL_MS = 16;/);\n});\n',
    // Over 300 KiB of plain text for the large-output row.
    "logs/stream-trace.log": Array.from(
      { length: 4200 },
      (_, i) =>
        `2026-10-23T06:${String(Math.floor(i / 70) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}Z chunk=${i} bytes=${(i * 37) % 4096} buffered=${i % 64} flushed=${i % 3 === 0}\n`,
    ).join(""),
  };
}

/** Server settings: every native driver off, one acpRegistry instance running the mock. */
export function captureSettings({ nodePath, mockAgentPath = MOCK_AGENT_PATH }) {
  const modelSelection = { instanceId: MOCK_INSTANCE_ID, model: MOCK_MODEL };
  return {
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: modelSelection,
    textGenerationModelSelection: modelSelection,
    providers: Object.fromEntries(NATIVE_DRIVERS.map((driver) => [driver, { enabled: false }])),
    providerInstances: {
      ...Object.fromEntries(
        NATIVE_DRIVERS.map((driver) => [driver, { driver, enabled: false, config: {} }]),
      ),
      [MOCK_INSTANCE_ID]: {
        driver: "acpRegistry",
        enabled: true,
        displayName: MOCK_DISPLAY_NAME,
        config: {
          source: "local",
          commandPath: nodePath,
          commandArgs: [mockAgentPath],
          customModels: [MOCK_MODEL],
        },
      },
    },
  };
}

/** The server's whole environment; nothing is inherited, so no live home or key leaks in. */
export function serverEnvironment({ home, tmp, nodePath, installed }) {
  return {
    HOME: home,
    USER: "studio-fixture",
    LOGNAME: "studio-fixture",
    SHELL: "/bin/zsh",
    PATH: `${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: tmp,
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    GIT_CONFIG_NOSYSTEM: "1",
    STUDIO_DISABLE_AUTO_UPDATE: "true",
    SPECWITHCODE_DISABLE_AUTO_UPDATE: "true",
    STUDIO_ACP_ACTIVITY_SCENARIO: "1",
    ...(installed ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
}

function readBundleVersion(app) {
  try {
    return execFileSync(
      "defaults",
      ["read", `${app}/Contents/Info.plist`, "CFBundleShortVersionString"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch (error) {
    throw new CaptureRefusal(
      `cannot read CFBundleShortVersionString of ${app}: ${String(error.stderr ?? error).trim()}`,
    );
  }
}

const redact = (text) =>
  text
    .replace(/Token: \S+/g, "Token: <omitted>")
    .replace(/(credential|token|ticket)=([^&\s"]+)/gi, "$1=<omitted>");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  return new Promise((done, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => done(port));
    });
  });
}

/** Stops the server this run spawned, by its PID only. */
async function stopChild(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 15000);
  await exited;
  clearTimeout(force);
}

function loadChromium() {
  const playwright = process.env.STUDIO_PLAYWRIGHT_MODULE
    ? createRequire(import.meta.url)(process.env.STUDIO_PLAYWRIGHT_MODULE)
    : createRequire(join(root, "apps/server/package.json"))("playwright-core");
  return playwright.chromium;
}

export async function runCapture(argv = process.argv.slice(2)) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new CaptureRefusal("Node 22.18 or newer is needed to run the TypeScript mock agent");
  }
  const { phase, expectCommit, reportDir } = parseCaptureArgs(argv);
  const app = process.env.STUDIO_CAPTURE_APP || "/Applications/SpecWithCode.app";
  const sourceEntry = process.env.STUDIO_SERVER_ENTRY || undefined;
  // A source build is refused before the bundle is even read.
  if (sourceEntry) assertPhaseAllowed({ phase, bundleVersion: null, sourceEntry });
  const bundleVersion = sourceEntry ? null : readBundleVersion(app);
  assertPhaseAllowed({ phase, bundleVersion, sourceEntry });
  const sourceGit = gitRunner(root);
  const provenance =
    phase === "after"
      ? resolveReleaseProvenance({ bundleVersion, expectCommit, git: sourceGit })
      : null;
  const receiptPath = assertNoReceipt(reportDir);
  if (!existsSync(MOCK_AGENT_PATH))
    throw new CaptureRefusal(`missing mock agent ${MOCK_AGENT_PATH}`);
  const harness = {
    script: relative(root, fileURLToPath(import.meta.url)),
    commit: sourceGit(["rev-parse", "HEAD"]).stdout.trim() || null,
    dirty: sourceGit(["status", "--porcelain"]).stdout.trim().length > 0,
    mockAgent: relative(root, MOCK_AGENT_PATH),
    mockAgentSha256: createHash("sha256").update(readFileSync(MOCK_AGENT_PATH)).digest("hex"),
  };

  process.env.PWDEBUG = "0";
  process.env.PLAYWRIGHT_HTML_OPEN = "never";
  mkdirSync(reportDir, { recursive: true });
  const privateRoot = join(
    homedir(),
    ".local/share/specweave-studio/verification",
    `activity-diffs-${phase}`,
  );
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  // Canonical, so the project root, git and the agent's cwd name the same paths.
  const state = realpathSync(mkdtempSync(join(privateRoot, "state-")));
  const home = join(state, "home");
  const tmp = join(state, "tmp");
  for (const dir of [join(state, "userdata"), home, tmp]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(
    join(state, "userdata/settings.json"),
    JSON.stringify(captureSettings({ nodePath: process.execPath })),
    { mode: 0o600 },
  );

  const repo = join(state, "repo");
  const files = scratchRepoFiles();
  const logBytes = Buffer.byteLength(files["logs/stream-trace.log"]);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  const gitEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "user.name=Activity fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: repo, encoding: "utf8", env: gitEnv },
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "Baseline for the activity-diffs capture");
  git("commit", "-q", "--allow-empty", "-m", "Document the 16 ms flush");

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const entrypoint = `${app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`;
  const child = spawn(
    sourceEntry ? process.execPath : `${app}/Contents/MacOS/SpecWithCode`,
    [
      sourceEntry ?? entrypoint,
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
      env: serverEnvironment({ home, tmp, nodePath: process.execPath, installed: !sourceEntry }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const credential = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("server startup timed out")), 60000);
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
      reject(new Error(`server exited ${code}: ${redact(output).slice(-1500)}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`server did not start: ${error.message}`));
    });
  });
  credential.catch(() => undefined);
  const receipt = {
    increment: INCREMENT,
    phase,
    app: sourceEntry ?? app,
    bundleVersion,
    serverVersion: null,
    ...(provenance ?? {}),
    harness,
    headless: true,
    PWDEBUG: process.env.PWDEBUG,
    PLAYWRIGHT_HTML_OPEN: process.env.PLAYWRIGHT_HTML_OPEN,
    providerSpend: `none: an acpRegistry instance runs node ${relative(root, MOCK_AGENT_PATH)} with STUDIO_ACP_ACTIVITY_SCENARIO=1; every native driver is disabled`,
    serverPid: child.pid,
    stateDir: state,
    scratchRepo: repo,
    startedAt: new Date().toISOString(),
    scenario: {
      editThread: `read SKILL.md (long absolute path), sed -n 240,500p, grep, git status, one edit-tool call changing 3 files, sed -i shell edit, failing node --test (exit 1), cat of a ${logBytes}-byte log (plain-string rawOutput), final message`,
      readonlyThread:
        "read /tmp/sk-cost-arch/brief.md (mock content), read SKILL.md, sed -n 240,500p, 6 read-only commands, final message, no edits",
      provider:
        "acpRegistry local instance -> node apps/server/scripts/acp-mock-agent.ts (ACP protocol v2, edit content as one diff block per file with a git patch)",
    },
    paging: null,
    largeOutput: null,
    threads: {},
    checks: [],
    sections: [],
    screenshots: [],
  };
  const check = (name, pass, observed, extra = {}) =>
    receipt.checks.push({ name, pass: Boolean(pass), observed, ...extra });

  let browser;
  let rpcContext;
  const contexts = [];
  async function rpc(tag, payload) {
    const ticket = (
      await (
        await rpcContext.request.post(`${origin}/api/auth/websocket-ticket`, {
          headers: { Origin: origin },
        })
      ).json()
    ).ticket;
    const url = new URL(origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    return new Promise((done, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => (ws.close(), reject(new Error(`RPC timeout ${tag}`))), 30000);
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
              : reject(new Error(`RPC ${tag}: ${JSON.stringify(item.exit).slice(0, 800)}`));
          }
      });
    });
  }
  async function newContext({ width, height, theme, detail = "normal" }) {
    // The startup credential is single-use, so every context reuses the first session's cookies.
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: "reduce",
      colorScheme: theme,
      storageState: await rpcContext.storageState(),
    });
    contexts.push(context);
    await context.addInitScript(
      (settings) => localStorage.setItem("studio:client-settings:v1", JSON.stringify(settings)),
      {
        onboardingCompletedAt: "2026-10-12T00:00:00Z",
        timelineDetail: detail,
      },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) =>
      check("no page error", false, String(error).slice(0, 300), {
        viewport: `${width}x${height}`,
        theme,
      }),
    );
    return page;
  }
  const planned = new Map(CAPTURE_PLAN.map((entry) => [entry.file, entry]));
  async function shot(page, name) {
    const file = `${name}.png`;
    const entry = planned.get(file);
    if (!entry && phase !== "explore") throw new Error(`${file} is not in the AC-16 capture plan`);
    await page.screenshot({ path: join(reportDir, file) });
    const viewport = page.viewportSize();
    const { group: _group, file: _file, ...meta } = entry ?? {};
    receipt.screenshots.push({ file, ...meta, viewport: `${viewport.width}x${viewport.height}` });
    return file;
  }
  async function section(name, run) {
    try {
      await run();
      receipt.sections.push({ name, ok: true });
    } catch (error) {
      receipt.sections.push({
        name,
        ok: false,
        error: redact(String(error?.message ?? error)).slice(0, 600),
      });
    }
  }
  const summarizeItem = (item) => ({
    id: item.id,
    type: item.type,
    status: item.status,
    title: item.title ?? null,
    ...(item.type === "command_execution"
      ? {
          input: item.input,
          exitCode: item.exitCode ?? null,
          outputChars: typeof item.output === "string" ? item.output.length : null,
        }
      : {}),
    ...(item.type === "file_change"
      ? {
          fileName: item.fileName,
          changes: item.changes?.length ?? null,
          diffStrChars: item.diffStr?.length ?? null,
        }
      : {}),
    ...(item.type === "dynamic_tool" ? { toolName: item.toolName } : {}),
  });
  async function readOutputPages(threadId, itemId) {
    const pages = [];
    let offset = 0;
    for (let guard = 0; guard < 64; guard++) {
      const result = await rpc("orchestration.getTurnItem", {
        threadId,
        itemId,
        field: "output",
        offset,
      }).catch(() => null);
      const page = result?.page;
      if (!page || typeof page.text !== "string") break;
      pages.push({
        offset: page.offset,
        end: page.end,
        totalLength: page.totalLength,
        nextOffset: page.nextOffset ?? null,
        revision: page.revision,
        chars: page.text.length,
        endsWithTransportMarker: /output truncated for transport/.test(page.text.slice(-200)),
      });
      if (page.nextOffset === null || page.nextOffset === undefined || page.nextOffset <= offset)
        break;
      offset = page.nextOffset;
    }
    return pages;
  }
  async function launchAndWait(projectId, key, title, text) {
    const threadId = randomUUID();
    await rpc("orchestration.launchThread", {
      commandId: randomUUID(),
      threadId,
      projectId,
      title,
      generateTitle: false,
      modelSelection: { instanceId: MOCK_INSTANCE_ID, model: MOCK_MODEL },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text, attachments: [] },
    });
    let projection;
    for (let n = 0; n < 120; n++) {
      await delay(1000);
      const result = await rpc("orchestration.getThreadProjection", { threadId });
      projection = result?.projection ?? result ?? null;
      const runs = projection?.runs ?? [];
      const settled =
        runs.length > 0 &&
        runs.every((run) =>
          ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(run.status),
        );
      const checkpointsSettled = (projection?.checkpoints ?? []).every(
        (cp) => !["pending", "capturing"].includes(cp.status),
      );
      if (settled && checkpointsSettled && n > 2) break;
    }
    const summary = {
      threadId,
      title,
      runs: (projection?.runs ?? []).map((run) => ({ id: run.id, status: run.status })),
      checkpoints: (projection?.checkpoints ?? []).map((cp) => ({
        status: cp.status,
        files: (cp.files ?? []).map((f) => f.path ?? f),
      })),
      items: (projection?.turnItems ?? []).map(summarizeItem),
    };
    // Stored detail as the client's on-demand read returns it (output and patch are not on the wire).
    for (const [index, item] of (projection?.turnItems ?? []).entries()) {
      if (!["command_execution", "file_change", "dynamic_tool"].includes(item.type)) continue;
      const detail = await rpc("orchestration.getTurnItem", { threadId, itemId: item.id }).catch(
        (error) => ({
          error: String(error).slice(0, 200),
        }),
      );
      const full = detail?.item;
      const outputText =
        typeof full?.output === "string"
          ? full.output
          : full?.output === undefined
            ? null
            : JSON.stringify(full.output);
      summary.items[index].detail = full
        ? {
            outputChars: outputText?.length ?? null,
            outputEndsWithTransportMarker: outputText
              ? /output truncated for transport/.test(outputText.slice(-200))
              : null,
            outputHasEarlierTruncatedMarker: outputText
              ? outputText.startsWith("[Earlier output truncated]")
              : null,
            diffStrChars: typeof full.diffStr === "string" ? full.diffStr.length : null,
            changes:
              full.changes?.map((c) => ({
                path: c.path,
                diffStrChars: typeof c.diffStr === "string" ? c.diffStr.length : null,
              })) ?? null,
            exitCode: full.exitCode ?? null,
            outputKeptTailChars: full.outputKeptTailChars ?? null,
            truncated: detail.truncated ?? null,
          }
        : detail;
      if (
        item.type === "command_execution" &&
        String(item.input ?? "").includes("stream-trace.log")
      ) {
        const pages = await readOutputPages(threadId, item.id);
        receipt.largeOutput = {
          itemId: item.id,
          pages,
          joinedChars: pages.reduce((sum, page) => sum + page.chars, 0),
          totalLength: pages[0]?.totalLength ?? null,
          revisions: [...new Set(pages.map((page) => page.revision))],
        };
      }
    }
    receipt.threads[key] = summary;
    writeFileSync(join(state, `projection-${key}.json`), JSON.stringify(projection, null, 2));
    return summary;
  }

  try {
    const token = await credential;
    const chromium = loadChromium();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
        : {}),
    });
    rpcContext = await browser.newContext();
    const auth = await rpcContext.request.post(`${origin}/api/auth/browser-session`, {
      data: { credential: token },
      headers: { Origin: origin },
    });
    if (auth.status() !== 200) throw new Error(`browser session: HTTP ${auth.status()}`);
    let config;
    for (let n = 0; n < 40; n++) {
      config = await rpc("server.getConfig", {});
      if (config.providers?.find((p) => p.instanceId === MOCK_INSTANCE_ID)?.status === "ready")
        break;
      await delay(750);
    }
    receipt.serverVersion = config.version ?? null;
    if (bundleVersion) {
      check(
        "server version matches the bundle",
        receipt.serverVersion === bundleVersion,
        `server=${receipt.serverVersion} bundle=${bundleVersion}`,
      );
    }
    const mock = config.providers?.find((p) => p.instanceId === MOCK_INSTANCE_ID);
    check("mock ACP provider is ready", mock?.status === "ready", `status=${mock?.status}`);
    const others = (config.providers ?? []).filter(
      (p) => p.enabled && p.instanceId !== MOCK_INSTANCE_ID,
    );
    check(
      "no other provider enabled",
      others.length === 0,
      others.map((p) => p.instanceId).join(","),
    );
    const projectId = "activity-diffs-check";
    await rpc("projects.mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: "flush-lab",
      workspaceRoot: repo,
    });
    const edit = await launchAndWait(
      projectId,
      "edit",
      "Tune the stream flush interval",
      "SCENARIO:edit Raise the stream flush interval to 32 ms everywhere, bump the chunk buffer, and run the streaming test.",
    );
    const readonly = await launchAndWait(
      projectId,
      "readonly",
      "Explain the flush wiring",
      "SCENARIO:readonly Where is the stream flush interval defined? Do not change anything.",
    );
    check(
      "edit thread run completed",
      edit.runs.length > 0 && edit.runs.every((r) => r.status === "completed"),
      JSON.stringify(edit.runs),
    );
    check(
      "readonly thread run completed",
      readonly.runs.length > 0 && readonly.runs.every((r) => r.status === "completed"),
      JSON.stringify(readonly.runs),
    );
    const status = git("status", "--short");
    receipt.scratchRepoStatusAfterTurns = status;
    check(
      "scratch repo has the 4 edited files",
      ["flushPolicy.ts", "bufferedWriter.ts", "streaming.md", "streaming.ts"].every((f) =>
        status.includes(f),
      ),
      status.trim().replace(/\n/g, "; "),
    );
    receipt.paging = describePaging(receipt.largeOutput?.pages);
    if ((receipt.largeOutput?.pages.length ?? 0) > 1) {
      check(
        "large output pages join to the stored length",
        receipt.largeOutput.joinedChars === receipt.largeOutput.totalLength &&
          receipt.largeOutput.revisions.length === 1,
        `joined=${receipt.largeOutput.joinedChars} total=${receipt.largeOutput.totalLength} revisions=${receipt.largeOutput.revisions.length}`,
        { ac: "AC-11" },
      );
    }
    const environmentId = config.environment?.environmentId ?? config.environmentId ?? null;
    receipt.environmentId = environmentId;
    const steps = phase === "explore" ? exploreSteps : activitySteps;
    await steps({
      newContext,
      shot,
      check,
      section,
      receipt,
      origin,
      reportDir,
      threads: { edit, readonly },
      environmentId,
      logBytes,
    });
    if (phase !== "explore") {
      receipt.plan = checkCapturePlan(receipt.screenshots);
      check(
        "screenshots match the AC-16 capture plan",
        receipt.plan.ok,
        JSON.stringify(receipt.plan).slice(0, 900),
        { ac: "AC-16" },
      );
    }
    receipt.ok = receipt.sections.every((s) => s.ok) && (phase === "explore" || receipt.plan.ok);
  } catch (error) {
    receipt.ok = false;
    receipt.error = redact(String(error?.stack ?? error)).slice(0, 2000);
  } finally {
    receipt.finishedAt = new Date().toISOString();
    receipt.pngCount = receipt.screenshots.length;
    writeFileSync(join(state, "server.log"), redact(output));
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    for (const context of contexts) await context.close().catch(() => undefined);
    await rpcContext?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await stopChild(child);
  }
  const summary = {
    ok: receipt.ok,
    receipt: receiptPath,
    pngs: receipt.screenshots.length,
    failedChecks: receipt.checks.filter((c) => !c.pass).length,
    failedSections: receipt.sections.filter((s) => !s.ok).map((s) => s.name),
    serverPid: child.pid,
    state,
    ...(receipt.error ? { error: receipt.error.split("\n")[0] } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** The before set's screenshot steps, unchanged in what they open, click and capture. */
async function activitySteps({
  newContext,
  shot,
  check,
  section,
  receipt,
  origin,
  threads,
  environmentId,
  logBytes,
}) {
  const threadPath = (key) => `/${environmentId}/${threads[key].threadId}`;
  const text = async (loc) =>
    (await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ").trim() : "";

  async function open(page, key) {
    await page.goto(`${origin}${threadPath(key)}`);
    await page
      .getByRole("button", { name: /Worked for/ })
      .first()
      .waitFor({ timeout: 30000 })
      .catch(() => undefined);
    await page.waitForTimeout(2500);
    // Machine notices (low disk, provider ready) are not part of the timeline.
    for (const name of [
      "Dismiss low disk space notice",
      "Dismiss notification",
      /^Dismiss .*provider ready$/,
    ]) {
      const buttons = page.getByRole("button", { name });
      for (let i = (await buttons.count()) - 1; i >= 0; i--)
        await buttons
          .nth(i)
          .click({ timeout: 2000 })
          .catch(() => undefined);
    }
    await page.waitForTimeout(500);
  }
  async function expandIfCollapsed(locator) {
    if (!(await locator.count())) return false;
    const target = locator.first();
    if ((await target.getAttribute("aria-expanded")) === "false") {
      await target.click();
      await target.page().waitForTimeout(700);
    }
    return true;
  }
  async function expandRows(page) {
    await expandIfCollapsed(page.getByRole("button", { name: /^Worked for/ }));
    await expandIfCollapsed(page.getByRole("button", { name: /^Used \d+ tools/ }));
    const groups = page.getByRole("button", { name: /show these \d+ tool calls$/ });
    for (let guard = 0; guard < 6 && (await groups.count()); guard++) {
      await groups.first().click();
      await page.waitForTimeout(700);
    }
  }
  async function scrollTo(locator, block = "start") {
    if (await locator.count())
      await locator.first().evaluate((el, b) => el.scrollIntoView({ block: b }), block);
    await locator.page().waitForTimeout(500);
  }
  // AC-14 measurements: page/main sideways scroll, row labels cut by an ellipsis, rows past the edge.
  async function measure(page) {
    const chrome = [
      MOCK_DISPLAY_NAME,
      "Full access",
      "Ask anything",
      "flush-lab",
      "Tune the stream",
      "Explain the flush",
    ];
    return page.evaluate((ignored) => {
      const doc = document.scrollingElement;
      const main = document.querySelector("main");
      // Timeline rows only: the composer's model button also carries aria-expanded.
      const rows = [...document.querySelectorAll("main button[aria-expanded]")]
        .filter(
          (b) =>
            b.getBoundingClientRect().height > 0 &&
            !/Next message:/.test(b.getAttribute("aria-label") ?? ""),
        )
        .map((b) => {
          const r = b.getBoundingClientRect();
          // Cut by CSS: any box in the row whose content is wider than the box and is hidden.
          const clipped = [b, ...b.querySelectorAll("*")].some(
            (e) =>
              e.scrollWidth > e.clientWidth + 1 &&
              ["hidden", "clip"].includes(getComputedStyle(e).overflowX),
          );
          const visible = (b.textContent || "").replace(/\s+/g, " ").trim();
          // A command never contains "…", so one in the visible text was added by the label code.
          const codeCut = visible.includes("…");
          return {
            label: (b.getAttribute("aria-label") || visible)
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 140),
            right: Math.round(r.right),
            clipped,
            codeCut,
            pastEdge: r.right > innerWidth + 1,
          };
        });
      const sideways = [...document.querySelectorAll("main *")]
        .filter(
          (e) =>
            e.scrollWidth > e.clientWidth + 1 &&
            ["auto", "scroll"].includes(getComputedStyle(e).overflowX) &&
            !e.closest("pre, code, [data-diffs-code-view-footer]"),
        )
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)}`);
      // Row labels sit in a `.truncate` box next to the row's button, so measure those boxes too.
      const cutLabels = [...document.querySelectorAll("main .truncate")]
        .filter((e) => e.getBoundingClientRect().height > 0 && e.scrollWidth > e.clientWidth + 1)
        .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140))
        .filter((t) => t && !ignored.some((label) => t.includes(label)));
      return {
        innerWidth,
        pageOverflowPx: doc.scrollWidth - doc.clientWidth,
        mainOverflowPx: main ? main.scrollWidth - main.clientWidth : null,
        rows,
        cutLabels,
        sideways,
      };
    }, chrome);
  }
  function fitChecks(m, label, screenshot) {
    check(
      `no sideways page scroll, ${label}`,
      m.pageOverflowPx <= 0 && (m.mainOverflowPx ?? 0) <= 0 && m.sideways.length === 0,
      `page=${m.pageOverflowPx}px main=${m.mainOverflowPx}px sidewaysScrollers=${JSON.stringify(m.sideways)}`,
      { screenshot, ac: "AC-14" },
    );
    const clipped = m.rows.filter((r) => r.clipped || r.codeCut || r.pastEdge);
    check(
      `every row label fits its row, ${label}`,
      clipped.length === 0 && m.cutLabels.length === 0,
      `${clipped.length} of ${m.rows.length} rows cut or past the edge: ${clipped
        .map((r) => `${r.label}${r.codeCut ? " [code-cut]" : ""}`)
        .join(" | ")
        .slice(
          0,
          700,
        )}; ${m.cutLabels.length} labels cut by CSS ellipsis: ${m.cutLabels.join(" | ").slice(0, 900)}`,
      { screenshot, ac: "AC-14" },
    );
  }
  async function closeDiff(page) {
    const close = page.getByRole("button", { name: "Close Diff" });
    if (await close.count())
      await close
        .first()
        .click()
        .catch(() => undefined);
    await page.waitForTimeout(600);
  }
  async function diffState(page) {
    const panelOpen = (await page.getByRole("button", { name: "Close Diff" }).count()) > 0;
    const scope =
      (await page
        .getByRole("button", { name: /^Diff scope:/ })
        .first()
        .getAttribute("aria-label")
        .catch(() => null)) ?? null;
    const files = await page
      .locator('button[aria-label^="Expand "], button[aria-label^="Collapse "]')
      .evaluateAll((nodes) =>
        nodes
          .map((n) => n.getAttribute("aria-label"))
          .filter((l) => /\.(ts|md|mjs|log)$/.test(l ?? "")),
      );
    return { panelOpen, scope, files };
  }

  // 1. Timeline at each width and theme, normal detail.
  receipt.measurements = {};
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [1280, 900],
      [720, 900],
      [390, 844],
    ]) {
      const tag = `${theme}-${width}`;
      await section(`normal ${tag}`, async () => {
        const page = await newContext({ width, height, theme, detail: "normal" });
        await open(page, "edit");
        const finalSeen =
          (await page.getByText("Raised the flush interval from 16 ms to 32 ms.").count()) > 0;
        const cardSeen = (await page.locator("[data-changed-files-state]").count()) > 0;
        await scrollTo(page.getByRole("button", { name: /^Worked for/ }), "center");
        const editShot = await shot(page, `normal-${tag}-edit`);
        check(
          `edit thread renders final message and changed-files card (${tag})`,
          finalSeen && cardSeen,
          `finalMessage=${finalSeen} card=${cardSeen}`,
          { screenshot: editShot },
        );
        await expandRows(page);
        await scrollTo(page.getByRole("button", { name: /^Used \d+ tools/ }));
        const rowsShot = await shot(page, `normal-${tag}-edit-rows`);
        const m = await measure(page);
        receipt.measurements[`edit-${tag}`] = m;
        fitChecks(m, `edit thread (${tag})`, rowsShot);
        await scrollTo(page.locator("[data-changed-files-state]"), "end");
        await shot(page, `normal-${tag}-edit-rows-end`);

        await open(page, "readonly");
        await expandRows(page);
        await scrollTo(page.getByRole("button", { name: /^Used \d+ tools/ }));
        const roShot = await shot(page, `normal-${tag}-readonly-rows`);
        const r = await measure(page);
        receipt.measurements[`readonly-${tag}`] = r;
        fitChecks(r, `read-only thread (${tag})`, roShot);
        const cards = await page.locator("[data-changed-files-state]").count();
        check(
          `read-only thread shows no changed-files card (${tag})`,
          cards === 0,
          `cards=${cards}`,
          { screenshot: roShot },
        );
        await page.context().close();
      });
    }
  }

  // 2. 1280 dark: concise and verbose detail.
  for (const detail of ["concise", "verbose"]) {
    await section(`${detail} dark-1280`, async () => {
      const page = await newContext({ width: 1280, height: 900, theme: "dark", detail });
      for (const key of ["edit", "readonly"]) {
        await open(page, key);
        const label = await page
          .getByRole("button", { name: /Show: / })
          .first()
          .getAttribute("aria-label")
          .catch(() => null);
        const file = await shot(page, `${detail}-dark-1280-${key}`);
        check(
          `${detail} detail is active (${key})`,
          label?.endsWith(
            `Show: ${{ concise: "Results only", normal: "Folded steps", verbose: "Everything" }[detail]}`,
          ),
          `control="${label}"`,
          { screenshot: file, ac: "AC-15" },
        );
        if (detail === "verbose") {
          await scrollTo(page.getByRole("button", { name: /^Used \d+ tools|^Worked for/ }));
          await shot(page, `${detail}-dark-1280-${key}-top`);
        }
      }
      await page.context().close();
    });
  }

  // 3. 1280 dark, normal: expanded rows and Open diff.
  const page = await newContext({ width: 1280, height: 900, theme: "dark", detail: "normal" });
  await section("open edit thread dark-1280", async () => {
    await open(page, "edit");
    await expandRows(page);
  });
  await section("edit row and its Open diff", async () => {
    const editRow = page.getByRole("button", { name: /flushPolicy\.ts$/ });
    check(
      "edit row is listed",
      (await editRow.count()) > 0,
      `label="${await editRow
        .first()
        .getAttribute("aria-label")
        .catch(() => null)}"`,
    );
    await editRow.first().click();
    await page.waitForTimeout(1500);
    await scrollTo(editRow, "start");
    const editInspector = await text(editRow.first().locator("xpath=.."));
    const editShot = await shot(page, "row-edit-expanded-dark-1280");
    check("expanded edit row content", true, `inspector text="${editInspector.slice(0, 400)}"`, {
      screenshot: editShot,
    });

    const rowOpenDiff = page
      .getByRole("button", { name: "Open diff", exact: true })
      .filter({ hasText: "Open diff" });
    const rowOpenDiffCount = await rowOpenDiff.count();
    // The edit row's Open diff comes before the card's in the DOM.
    await rowOpenDiff.first().click();
    await page.waitForTimeout(3000);
    const fromRow = await diffState(page);
    const rowDiffShot = await shot(page, "diff-from-edit-row-dark-1280");
    check(
      "Open diff from the edit row opens the DiffPanel",
      fromRow.panelOpen,
      `OpenDiffButtons=${rowOpenDiffCount} scope="${fromRow.scope}" files=${JSON.stringify(fromRow.files)}`,
      { screenshot: rowDiffShot, ac: "AC-04" },
    );
    check(
      "edit row diff reveals flushPolicy.ts expanded",
      fromRow.files.includes("Collapse packages/core/src/chat/flushPolicy.ts"),
      `files=${JSON.stringify(fromRow.files)}`,
      { screenshot: rowDiffShot, ac: "AC-04" },
    );
    await closeDiff(page);
  });
  await section("failing command row", async () => {
    const failedRow = page.getByRole("button", { name: /^Failed · node --test/ });
    check(
      "failing command row is listed",
      (await failedRow.count()) > 0,
      `label="${await failedRow
        .first()
        .getAttribute("aria-label")
        .catch(() => null)}"`,
    );
    await failedRow.first().click();
    await page.waitForTimeout(2000);
    await scrollTo(failedRow, "start");
    const failedText = await text(failedRow.first().locator("xpath=.."));
    const failedShot = await shot(page, "row-failed-expanded-dark-1280");
    check(
      "expanded failing command shows the test failure",
      /fail|not ok|AssertionError/i.test(failedText),
      `panel text starts "${failedText.slice(0, 300)}"; mentions exit code=${/exit/i.test(failedText)}`,
      { screenshot: failedShot, ac: "AC-10" },
    );
    await failedRow.first().click();
    await page.waitForTimeout(500);
  });
  await section("large output row", async () => {
    const largeRow = page.getByRole("button", { name: /cat logs\/stream-trace\.log/ });
    check(
      "large output row is listed",
      (await largeRow.count()) > 0,
      `label="${await largeRow
        .first()
        .getAttribute("aria-label")
        .catch(() => null)}"`,
    );
    await largeRow.first().click();
    await page.waitForTimeout(3000);
    await scrollTo(largeRow, "start");
    const largeText = await text(largeRow.first().locator("xpath=.."));
    const largeShot = await shot(page, "row-large-output-expanded-dark-1280");
    const largeCode = largeRow.first().locator("xpath=..").locator("pre, code").last();
    const shown = (await largeCode.count())
      ? await largeCode.evaluate((el) => ({
          chars: el.textContent.length,
          tail: el.textContent.slice(-160),
        }))
      : null;
    check(
      "expanded large output shows text",
      (shown?.chars ?? 0) > 0,
      `shown chars=${shown?.chars ?? 0} (file is ${logBytes} bytes); transport marker=${/output truncated for transport/.test(largeText)}; tail="${shown?.tail ?? ""}"`,
      { screenshot: largeShot, ac: "AC-11" },
    );
    if (await largeCode.count()) {
      await largeCode.evaluate((el) => {
        const scroller = el.closest("[class*=overflow]") ?? el;
        scroller.scrollTop = scroller.scrollHeight;
        el.scrollIntoView({ block: "end" });
      });
      await page.waitForTimeout(500);
    }
    await shot(page, "row-large-output-expanded-end-dark-1280");
    await largeRow.first().click();
    await page.waitForTimeout(500);
  });
  // Card header Open diff, then a card file row.
  const card = page.locator("[data-changed-files-state]").first();
  await section("card header Open diff", async () => {
    await scrollTo(card, "center");
    await card.getByRole("button", { name: "Open diff" }).first().click();
    await page.waitForTimeout(3000);
    const fromCard = await diffState(page);
    const cardShot = await shot(page, "diff-from-card-header-dark-1280");
    check(
      "Open diff from the changed-files card opens the DiffPanel",
      fromCard.panelOpen,
      `scope="${fromCard.scope}" files=${JSON.stringify(fromCard.files)}`,
      { screenshot: cardShot, ac: "AC-04" },
    );
    await closeDiff(page);
  });
  await section("card row Open diff", async () => {
    await scrollTo(card, "center");
    await card
      .getByRole("button", { name: "Expand all folders" })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(800);
    const cardFile = card.locator("button", { hasText: "bufferedWriter.ts" }).last();
    const cardFileFound = (await cardFile.count()) > 0;
    await shot(page, "card-expanded-dark-1280");
    if (cardFileFound) {
      await cardFile.click();
      await page.waitForTimeout(3000);
    }
    const fromCardRow = await diffState(page);
    const cardRowShot = await shot(page, "diff-from-card-row-dark-1280");
    check(
      "Open diff from a card row opens the DiffPanel",
      cardFileFound && fromCardRow.panelOpen,
      `row found=${cardFileFound} scope="${fromCardRow.scope}" files=${JSON.stringify(fromCardRow.files)}`,
      { screenshot: cardRowShot, ac: "AC-04" },
    );
    check(
      "card row diff reveals bufferedWriter.ts expanded",
      fromCardRow.files.includes("Collapse packages/client-runtime/src/stream/bufferedWriter.ts"),
      `files=${JSON.stringify(fromCardRow.files)}`,
      { screenshot: cardRowShot, ac: "AC-04" },
    );
  });
  await page.context().close();
}

/** Exploration only: opens the edit thread at 1280 dark, expands the fold and dumps what shows. */
async function exploreSteps({
  newContext,
  shot,
  section,
  origin,
  reportDir,
  threads,
  environmentId,
}) {
  await section("explore edit thread", async () => {
    const page = await newContext({ width: 1280, height: 900, theme: "dark" });
    const dump = async (name) => {
      await shot(page, `explore-${name}`);
      const buttons = await page
        .getByRole("button")
        .evaluateAll((nodes) =>
          nodes.map(
            (n) =>
              `${n.getAttribute("aria-label") ?? ""} | ${n.getAttribute("aria-expanded") ?? ""} | ${n.textContent?.trim().replace(/\s+/g, " ").slice(0, 100)}`,
          ),
        );
      writeFileSync(join(reportDir, `explore-${name}-buttons.txt`), buttons.join("\n"));
      writeFileSync(
        join(reportDir, `explore-${name}.txt`),
        await page
          .locator("main")
          .first()
          .innerText()
          .catch((e) => String(e)),
      );
    };
    await page.goto(`${origin}/${environmentId}/${threads.edit.threadId}`);
    await page.waitForTimeout(6000);
    for (const name of [
      "Dismiss low disk space notice",
      "Dismiss notification",
      /^Dismiss .*provider ready$/,
    ]) {
      const b = page.getByRole("button", { name });
      for (let i = (await b.count()) - 1; i >= 0; i--)
        await b
          .nth(i)
          .click()
          .catch(() => undefined);
    }
    await page.waitForTimeout(800);
    await dump("a-initial");
    await page
      .getByRole("button", { name: /Worked for/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await dump("b-fold-open");
    await page
      .getByRole("button", { name: /^Used \d+ tools/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await dump("c-tools-open");
    writeFileSync(
      join(reportDir, "explore-c-tools-open.html"),
      await page.locator("main").first().innerHTML(),
    );
    const groups = page.getByRole("button", { name: /, show these \d+ tool calls$/ });
    for (let guard = 0; guard < 6 && (await groups.count()); guard++) {
      await groups.first().click();
      await page.waitForTimeout(1200);
    }
    await dump("d-subgroups-open");
    writeFileSync(
      join(reportDir, "explore-d.html"),
      await page.locator("main").first().innerHTML(),
    );
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCapture().then(
    (summary) => {
      process.exitCode = summary.ok ? 0 : 1;
    },
    (error) => {
      if (error instanceof CaptureRefusal) {
        console.error(error.message);
        process.exitCode = error.exitCode;
      } else {
        console.error(redact(String(error?.stack ?? error)));
        process.exitCode = 1;
      }
    },
  );
}
