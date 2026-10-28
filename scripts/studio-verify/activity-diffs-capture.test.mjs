import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BEFORE_VERSION,
  CAPTURE_PLAN,
  CaptureRefusal,
  MOCK_AGENT_PATH,
  MOCK_INSTANCE_ID,
  PAGING_FIXTURE_ONLY,
  assertNoReceipt,
  assertPhaseAllowed,
  captureSettings,
  checkCapturePlan,
  describePaging,
  gitRunner,
  parseCaptureArgs,
  resolveReleaseProvenance,
  scratchRepoFiles,
  serverEnvironment,
} from "./activity-diffs-capture.mjs";

const script = fileURLToPath(new URL("./activity-diffs-capture.mjs", import.meta.url));
const BEFORE_RECEIPT =
  process.env.STUDIO_ACTIVITY_BEFORE_RECEIPT ??
  join(
    homedir(),
    "Projects/github/specweave-umb/.specweave/increments/1011-activity-diffs-and-compact-output/reports/installed-before/receipt.json",
  );
// The before set's 38 files (reports/installed-before/receipt.json, October 23, 2026).
const BEFORE_FILES = [
  "normal-light-1280-edit",
  "normal-light-1280-edit-rows",
  "normal-light-1280-edit-rows-end",
  "normal-light-1280-readonly-rows",
  "normal-light-720-edit",
  "normal-light-720-edit-rows",
  "normal-light-720-edit-rows-end",
  "normal-light-720-readonly-rows",
  "normal-light-390-edit",
  "normal-light-390-edit-rows",
  "normal-light-390-edit-rows-end",
  "normal-light-390-readonly-rows",
  "normal-dark-1280-edit",
  "normal-dark-1280-edit-rows",
  "normal-dark-1280-edit-rows-end",
  "normal-dark-1280-readonly-rows",
  "normal-dark-720-edit",
  "normal-dark-720-edit-rows",
  "normal-dark-720-edit-rows-end",
  "normal-dark-720-readonly-rows",
  "normal-dark-390-edit",
  "normal-dark-390-edit-rows",
  "normal-dark-390-edit-rows-end",
  "normal-dark-390-readonly-rows",
  "concise-dark-1280-edit",
  "concise-dark-1280-readonly",
  "verbose-dark-1280-edit",
  "verbose-dark-1280-edit-top",
  "verbose-dark-1280-readonly",
  "verbose-dark-1280-readonly-top",
  "row-edit-expanded-dark-1280",
  "diff-from-edit-row-dark-1280",
  "row-failed-expanded-dark-1280",
  "row-large-output-expanded-dark-1280",
  "row-large-output-expanded-end-dark-1280",
  "diff-from-card-header-dark-1280",
  "card-expanded-dark-1280",
  "diff-from-card-row-dark-1280",
].map((name) => `${name}.png`);

function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A private git in a temp folder: no user hooks, templates or system config. */
function tempGit(cwd, home) {
  return (...args) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "user.name=Capture test", "-c", "user.email=capture@example.invalid", ...args],
      {
        cwd,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
      },
    ).trim();
}

const refusal =
  (pattern, exitCode = 2) =>
  (error) =>
    error instanceof CaptureRefusal && error.exitCode === exitCode && pattern.test(error.message);

test("arguments: phase, expected commit and one report directory", () => {
  assert.deepEqual(parseCaptureArgs(["--phase", "after", "--expect-commit", "abc1234", "out"]), {
    phase: "after",
    expectCommit: "abc1234",
    reportDir: join(process.cwd(), "out"),
  });
  assert.equal(parseCaptureArgs(["/tmp/r", "--phase", "before"]).phase, "before");
  assert.throws(() => parseCaptureArgs(["--phase", "before"]), refusal(/usage/));
  assert.throws(() => parseCaptureArgs(["--phase", "during", "out"]), refusal(/usage/));
  assert.throws(() => parseCaptureArgs(["--phase", "before", "a", "b"]), refusal(/usage/));
  assert.throws(
    () => parseCaptureArgs(["--phase", "before", "--route", "/x", "out"]),
    refusal(/unknown option --route/),
  );
  assert.throws(() => parseCaptureArgs(["out", "--phase"]), refusal(/--phase needs a value/));
  assert.throws(
    () => parseCaptureArgs(["--phase", "before", "--expect-commit", "abc1234", "out"]),
    refusal(/only to --phase after/),
  );
  // T-15 passes "$MERGE_SHA": an empty or missing value refuses before anything runs.
  for (const argv of [
    ["--phase", "after", "out"],
    ["--phase", "after", "--expect-commit", "", "out"],
    ["--phase", "after", "--expect-commit", "main", "out"],
  ]) {
    assert.throws(() => parseCaptureArgs(argv), refusal(/--expect-commit <sha>/));
  }
});

test("phase guard: before only on installed 1.0.74, after only on an installed release", () => {
  assert.equal(BEFORE_VERSION, "1.0.74");
  assert.doesNotThrow(() => assertPhaseAllowed({ phase: "before", bundleVersion: "1.0.74" }));
  for (const bundleVersion of ["1.0.75", "1.0.73", "", null]) {
    assert.throws(
      () => assertPhaseAllowed({ phase: "before", bundleVersion }),
      refusal(/refusing --phase before: bundleVersion=.*expected installed 1\.0\.74/),
    );
  }
  assert.throws(
    () =>
      assertPhaseAllowed({ phase: "before", bundleVersion: "1.0.74", sourceEntry: "/x/bin.mjs" }),
    refusal(/bundleVersion=source build/),
  );
  assert.doesNotThrow(() => assertPhaseAllowed({ phase: "after", bundleVersion: "1.0.76" }));
  assert.throws(
    () => assertPhaseAllowed({ phase: "after", bundleVersion: null, sourceEntry: "/x/bin.mjs" }),
    refusal(/not a source build/),
  );
  assert.throws(
    () => assertPhaseAllowed({ phase: "after", bundleVersion: null }),
    refusal(/not a source build/),
  );
  assert.doesNotThrow(() =>
    assertPhaseAllowed({ phase: "explore", bundleVersion: null, sourceEntry: "/x/bin.mjs" }),
  );
});

test("ancestry guard resolves v<bundleVersion> and requires the merge commit below it", (t) => {
  const dir = tempDir(t, "activity-diffs-ancestry-");
  const git = tempGit(dir, dir);
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const feature = git("commit-tree", tree, "-p", base, "-m", "1011 work");
  const merge = git("commit-tree", tree, "-p", base, "-p", feature, "-m", "Merge 1011");
  const release = git("commit-tree", tree, "-p", merge, "-m", "Release 1.0.80");
  const side = git("commit-tree", tree, "-p", base, "-m", "Unmerged side work");
  git("tag", "-a", "v1.0.80", "-m", "1.0.80", release);
  git("tag", "v1.0.81", merge);
  git("branch", "v1.0.82", release);
  const run = gitRunner(dir);

  assert.deepEqual(
    resolveReleaseProvenance({ bundleVersion: "1.0.80", expectCommit: merge, git: run }),
    {
      releaseTag: "v1.0.80",
      sourceCommit: release,
      mergeCommit: merge,
    },
  );
  // A short SHA resolves to the full commit; the tag commit itself counts as its own ancestor.
  assert.equal(
    resolveReleaseProvenance({
      bundleVersion: "1.0.80",
      expectCommit: feature.slice(0, 10),
      git: run,
    }).mergeCommit,
    feature,
  );
  assert.equal(
    resolveReleaseProvenance({ bundleVersion: "1.0.81", expectCommit: merge, git: run })
      .sourceCommit,
    merge,
  );
  assert.throws(
    () => resolveReleaseProvenance({ bundleVersion: "1.0.80", expectCommit: side, git: run }),
    refusal(new RegExp(`${side} is not an ancestor of v1\\.0\\.80 \\(${release}\\)`)),
  );
  assert.throws(
    () => resolveReleaseProvenance({ bundleVersion: "1.0.81", expectCommit: release, git: run }),
    refusal(/is not an ancestor of v1\.0\.81/),
  );
  // A branch named like the tag is not a release tag.
  assert.throws(
    () => resolveReleaseProvenance({ bundleVersion: "1.0.82", expectCommit: merge, git: run }),
    refusal(/release tag v1\.0\.82 is not in this repository/),
  );
  assert.throws(
    () =>
      resolveReleaseProvenance({
        bundleVersion: "1.0.80",
        expectCommit: "deadbeefdeadbeef",
        git: run,
      }),
    refusal(/commit deadbeefdeadbeef is not in this repository/),
  );
  for (const expectCommit of [undefined, "", "HEAD"]) {
    assert.throws(
      () => resolveReleaseProvenance({ bundleVersion: "1.0.80", expectCommit, git: run }),
      refusal(/--expect-commit <sha>/),
    );
  }
  assert.throws(
    () => resolveReleaseProvenance({ bundleVersion: null, expectCommit: merge, git: run }),
    refusal(/has no version/),
  );
});

test("ancestry guard runs exactly these git queries and refuses a git failure", () => {
  const calls = [];
  const sha = (char) => char.repeat(40);
  const fake = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse")
      return {
        status: 0,
        stdout: `${args[3].startsWith("refs/tags/") ? sha("a") : sha("b")}\n`,
        stderr: "",
      };
    return { status: 128, stdout: "", stderr: "fatal: not a git repository\n" };
  };
  assert.throws(
    () => resolveReleaseProvenance({ bundleVersion: "1.0.76", expectCommit: "bbbbbbb", git: fake }),
    refusal(/git merge-base --is-ancestor failed: fatal: not a git repository/),
  );
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "--quiet", "refs/tags/v1.0.76^{commit}"],
    ["rev-parse", "--verify", "--quiet", "bbbbbbb^{commit}"],
    ["merge-base", "--is-ancestor", sha("b"), sha("a")],
  ]);
});

test("every phase refuses to overwrite an existing receipt", (t) => {
  const dir = tempDir(t, "activity-diffs-receipt-");
  assert.equal(assertNoReceipt(dir), join(dir, "receipt.json"));
  writeFileSync(join(dir, "receipt.json"), "{}\n");
  assert.throws(() => assertNoReceipt(dir), refusal(/refusing to overwrite .*receipt\.json/, 3));
  assert.throws(() => assertNoReceipt("/any", () => true), refusal(/refusing to overwrite/, 3));
});

test("the script refuses from the command line before it starts a server", (t) => {
  const dir = tempDir(t, "activity-diffs-cli-");
  const home = join(dir, "home");
  mkdirSync(home);
  const fakeApp = (version) => {
    const app = join(dir, `SpecWithCode-${version}.app`);
    mkdirSync(join(app, "Contents"), { recursive: true });
    writeFileSync(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`,
    );
    return app;
  };
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
  const reports = join(dir, "reports");

  let result = run(["--phase", "before"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /usage:/);
  result = run(["--phase", "after", reports]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--expect-commit <sha>/);
  result = run(["--phase", "before", reports], {
    STUDIO_SERVER_ENTRY: join(dir, "missing-bin.mjs"),
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /bundleVersion=source build/);
  result = run(["--phase", "after", "--expect-commit", "abcdef1", reports], {
    STUDIO_SERVER_ENTRY: join(dir, "missing-bin.mjs"),
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /not a source build/);
  if (process.platform === "darwin") {
    result = run(["--phase", "before", reports], { STUDIO_CAPTURE_APP: fakeApp("1.0.75") });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /bundleVersion=1\.0\.75, expected installed 1\.0\.74/);
    result = run(["--phase", "after", "--expect-commit", "abcdef1", reports], {
      STUDIO_CAPTURE_APP: fakeApp("0.0.0-capture-test"),
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /release tag v0\.0\.0-capture-test is not in this repository/);
    mkdirSync(reports);
    writeFileSync(join(reports, "receipt.json"), "{}\n");
    result = run(["--phase", "before", reports], { STUDIO_CAPTURE_APP: fakeApp(BEFORE_VERSION) });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /refusing to overwrite/);
    assert.equal(readFileSync(join(reports, "receipt.json"), "utf8"), "{}\n");
  }
  // No refusal created private state.
  assert.equal(existsSync(join(home, ".local")), false);
});

test("importing the harness has no side effects", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); console.log(typeof m.runCapture);`,
    ],
    { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, HOME: tmpdir() } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "function\n");
  assert.equal(result.stderr, "");
});

test("the capture plan is the before set: AC-16's scenarios, widths and themes", (t) => {
  assert.deepEqual(
    CAPTURE_PLAN.map((entry) => entry.file),
    BEFORE_FILES,
  );
  const normal = CAPTURE_PLAN.filter((entry) => entry.group === "normal");
  assert.equal(normal.length, 4 * 3 * 2);
  for (const theme of ["light", "dark"]) {
    for (const viewport of ["1280x900", "720x900", "390x844"]) {
      const views = normal.filter((entry) => entry.theme === theme && entry.viewport === viewport);
      assert.deepEqual(
        views.map((entry) => `${entry.thread}:${entry.view}`),
        [
          "edit:as opened, fold closed",
          "edit:fold and tool groups expanded",
          "edit:expanded, scrolled to the last rows and card",
          "readonly:fold and tool groups expanded",
        ],
      );
    }
  }
  const rest = CAPTURE_PLAN.filter((entry) => entry.group !== "normal");
  assert.ok(rest.every((entry) => entry.theme === "dark" && entry.viewport === "1280x900"));
  const count = (group) => rest.filter((entry) => entry.group === group).length;
  assert.deepEqual(
    {
      concise: count("concise"),
      verbose: count("verbose"),
      rows: count("expanded-row"),
      openDiff: count("open-diff"),
    },
    { concise: 2, verbose: 4, rows: 5, openDiff: 3 },
  );
  assert.ok(Object.isFrozen(CAPTURE_PLAN) && CAPTURE_PLAN.every(Object.isFrozen));

  if (!existsSync(BEFORE_RECEIPT)) {
    t.diagnostic(
      `before receipt not found at ${BEFORE_RECEIPT}; compared with the pinned list only`,
    );
    return;
  }
  const before = JSON.parse(readFileSync(BEFORE_RECEIPT, "utf8"));
  assert.equal(before.bundleVersion, BEFORE_VERSION);
  assert.deepEqual(checkCapturePlan(before.screenshots), {
    ok: true,
    missing: [],
    unexpected: [],
    duplicated: [],
    mismatched: [],
  });
  assert.deepEqual(
    before.screenshots.map((shot) => shot.file),
    CAPTURE_PLAN.map((entry) => entry.file),
  );
});

test("the plan check reports missing, unexpected, duplicated and mismatched captures", () => {
  const shots = CAPTURE_PLAN.map(({ group: _group, ...shot }) => ({ ...shot }));
  assert.equal(checkCapturePlan(shots).ok, true);
  const [first, second, ...others] = shots;
  const changed = [
    { ...second, detail: "verbose" },
    ...others,
    { ...others[0] },
    { file: "explore-a-initial.png", viewport: "1280x900", theme: "dark", detail: "normal" },
  ];
  assert.deepEqual(checkCapturePlan(changed), {
    ok: false,
    missing: [first.file],
    unexpected: ["explore-a-initial.png"],
    duplicated: [others[0].file],
    mismatched: [{ file: second.file, field: "detail", expected: "normal", observed: "verbose" }],
  });
  const narrow = shots.map((shot) =>
    shot.file === "normal-dark-390-edit.png"
      ? { ...shot, viewport: "720x900", theme: "light" }
      : shot,
  );
  assert.deepEqual(checkCapturePlan(narrow).mismatched, [
    {
      file: "normal-dark-390-edit.png",
      field: "viewport",
      expected: "390x844",
      observed: "720x900",
    },
    { file: "normal-dark-390-edit.png", field: "theme", expected: "dark", observed: "light" },
  ]);
});

test("paging is claimed only when the installed output spans more than one page", () => {
  assert.equal(PAGING_FIXTURE_ONLY, "paging proven by the fixture only");
  assert.equal(describePaging(undefined), PAGING_FIXTURE_ONLY);
  assert.equal(describePaging([]), PAGING_FIXTURE_ONLY);
  assert.equal(describePaging([{ totalLength: 1000, chars: 1000 }]), PAGING_FIXTURE_ONLY);
  assert.equal(
    describePaging([{ totalLength: 302288 }, { totalLength: 302288 }]),
    "installed output read in 2 pages (302288 characters)",
  );
});

test("server settings and environment keep the run private and spend-free", () => {
  const settings = captureSettings({ nodePath: process.execPath });
  for (const driver of [
    "codex",
    "claudeAgent",
    "cursor",
    "grok",
    "pi",
    "opencode",
    "antigravity",
  ]) {
    assert.equal(settings.providers[driver].enabled, false);
    assert.equal(settings.providerInstances[driver].enabled, false);
  }
  const enabled = Object.entries(settings.providerInstances).filter(
    ([, instance]) => instance.enabled,
  );
  assert.deepEqual(
    enabled.map(([id]) => id),
    [MOCK_INSTANCE_ID],
  );
  assert.deepEqual(settings.providerInstances[MOCK_INSTANCE_ID].config, {
    source: "local",
    commandPath: process.execPath,
    commandArgs: [MOCK_AGENT_PATH],
    customModels: ["default"],
  });
  assert.equal(settings.defaultModelSelection.instanceId, MOCK_INSTANCE_ID);
  assert.equal(settings.textGenerationModelSelection.instanceId, MOCK_INSTANCE_ID);
  assert.ok(existsSync(MOCK_AGENT_PATH));

  const env = serverEnvironment({
    home: "/private/run/home",
    tmp: "/private/run/tmp",
    nodePath: "/opt/node/bin/node",
    installed: true,
  });
  assert.equal(env.HOME, "/private/run/home");
  assert.equal(env.TMPDIR, "/private/run/tmp");
  assert.equal(env.PATH.split(":")[0], "/opt/node/bin");
  assert.equal(env.STUDIO_ACP_ACTIVITY_SCENARIO, "1");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.PWDEBUG, "0");
  assert.equal(env.PLAYWRIGHT_HTML_OPEN, "never");
  assert.equal(
    serverEnvironment({ home: "/h", tmp: "/t", nodePath: "/n/node", installed: false })
      .ELECTRON_RUN_AS_NODE,
    undefined,
  );
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(
      key,
      /^(STUDIO_HOME|SPECWEAVE_|ANTHROPIC_|OPENAI_|XAI_|GEMINI_|CODEX_|CLAUDE_)/,
    );
  }
});

/** Drives the mock agent over stdio as the server's ACP client would. */
function startMock(t, cwd, home) {
  const child = spawn(process.execPath, [MOCK_AGENT_PATH], {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, STUDIO_ACP_ACTIVITY_SCENARIO: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  const pending = new Map();
  let updates = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === "session/update") {
      updates.push(message.params.update);
    }
  });
  let nextId = 0;
  const request = (method, params) =>
    new Promise((done, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out; stderr: ${stderr.slice(-600)}`)),
        30000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else done(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    exited,
    async open() {
      await request("initialize", {
        protocolVersion: 2,
        capabilities: {},
        info: { name: "capture-test", version: "0" },
      });
      return (await request("session/new", { cwd, mcpServers: [] })).sessionId;
    },
    async prompt(sessionId, text) {
      updates = [];
      await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      return updates;
    },
    end() {
      child.stdin.end();
    },
  };
}

/** One entry per tool call: its title, kind and input from the first update, then the last state. */
function toolCalls(updates) {
  const calls = new Map();
  for (const update of updates) {
    if (update.sessionUpdate !== "tool_call_update") continue;
    const call = calls.get(update.toolCallId) ?? { statuses: [] };
    for (const key of ["title", "kind", "rawInput", "rawOutput", "content", "locations"]) {
      if (update[key] !== undefined) call[key] = update[key];
    }
    if (update.status) call.statuses.push(update.status);
    calls.set(update.toolCallId, call);
  }
  return [...calls.values()];
}

test(
  "independent activity mock processes return distinct session identities",
  { timeout: 60000 },
  async (t) => {
    const dir = tempDir(t, "activity-diffs-mock-sessions-");
    const first = startMock(t, dir, dir);
    const second = startMock(t, dir, dir);
    const [firstId, secondId] = await Promise.all([first.open(), second.open()]);
    assert.notEqual(firstId, secondId);
    first.end();
    second.end();
    assert.deepEqual(await first.exited, { code: 0, signal: null });
    assert.deepEqual(await second.exited, { code: 0, signal: null });
  },
);

test(
  "the mock agent plays the two scripted turns inside the scratch repository",
  { timeout: 90000 },
  async (t) => {
    const dir = tempDir(t, "activity-diffs-mock-");
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home);
    const files = scratchRepoFiles();
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
    }
    const git = tempGit(repo, home);
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "Baseline");
    const mock = startMock(t, repo, home);
    const sessionId = await mock.open();
    const wrap = (text) =>
      `<studio_code_instructions>\nDefault mode\n</studio_code_instructions>\n\n<user_request>\n${text}\n</user_request>`;

    const edit = await mock.prompt(
      sessionId,
      wrap("SCENARIO:edit Raise the stream flush interval to 32 ms everywhere."),
    );
    const editCalls = toolCalls(edit);
    assert.deepEqual(
      editCalls.map((call) => [call.kind, call.title, call.statuses.at(-1)]),
      [
        ["read", "Read SKILL.md", "completed"],
        ["execute", "`sed -n 240,500p packages/core/src/chat/streaming.ts`", "completed"],
        ["execute", '`grep -rn "FLUSH_INTERVAL_MS" packages docs`', "completed"],
        ["execute", "`git status --short`", "completed"],
        ["edit", "Edit 3 files", "completed"],
        [
          "execute",
          "`sed -i.bak 's/const MAX_BUFFERED_CHUNKS = 64;/const MAX_BUFFERED_CHUNKS = 128;/' packages/core/src/chat/streaming.ts && rm packages/core/src/chat/streaming.ts.bak`",
          "completed",
        ],
        ["execute", "`node --test test/streaming.test.mjs`", "failed"],
        ["execute", "`cat logs/stream-trace.log`", "completed"],
      ],
    );
    assert.ok(
      editCalls.every((call) => call.statuses.join() === `pending,in_progress,${call.statuses[2]}`),
    );
    assert.equal(
      editCalls[0].rawInput.path,
      join(repo, ".claude/skills/streaming-flush-tuning/references/SKILL.md"),
    );
    assert.equal(editCalls[6].rawOutput.exit_code, 1);
    assert.match(editCalls[6].rawOutput.stdout, /not ok 1 - flush interval stays at 16 ms/);
    // The large output is one plain string, as in the before set.
    assert.equal(editCalls[7].rawOutput, files["logs/stream-trace.log"]);
    assert.ok(editCalls[7].rawOutput.length > 256 * 1024);
    const diffs = editCalls[4].content;
    assert.deepEqual(
      diffs.map((block) => block.changes.map((change) => [change.operation, change.path])),
      [
        [["modify", join(repo, "packages/core/src/chat/flushPolicy.ts")]],
        [["modify", join(repo, "packages/client-runtime/src/stream/bufferedWriter.ts")]],
        [["modify", join(repo, "docs/streaming.md")]],
      ],
    );
    for (const block of diffs) {
      assert.equal(block.patch.format, "git_patch");
      const reversed = spawnSync("/usr/bin/git", ["apply", "--check", "-R", "-"], {
        cwd: repo,
        input: block.patch.text,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
      });
      assert.equal(reversed.status, 0, `${reversed.stderr}\n${block.patch.text}`);
    }
    assert.match(
      diffs[0].patch.text,
      /^-export const FLUSH_INTERVAL_MS = 16;\n\+export const FLUSH_INTERVAL_MS = 32;$/m,
    );
    const editStatus = git("status", "--short");
    assert.deepEqual(
      editStatus
        .split("\n")
        .map((line) => line.trim())
        .sort(),
      [
        "M docs/streaming.md",
        "M packages/client-runtime/src/stream/bufferedWriter.ts",
        "M packages/core/src/chat/flushPolicy.ts",
        "M packages/core/src/chat/streaming.ts",
      ],
    );
    const messages = edit.filter((update) => update.sessionUpdate === "agent_message_chunk");
    assert.equal(new Set(messages.map((update) => update.messageId)).size, 3);
    assert.match(messages.at(-1).content.text, /^Raised the flush interval from 16 ms to 32 ms\./);
    assert.deepEqual(edit.at(-1), {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    });

    const readonly = await mock.prompt(
      sessionId,
      wrap("SCENARIO:readonly Where is the stream flush interval defined?"),
    );
    const readonlyCalls = toolCalls(readonly);
    assert.deepEqual(
      readonlyCalls.map((call) => call.title),
      [
        "Read brief.md",
        "Read SKILL.md",
        "`sed -n 240,500p packages/core/src/chat/streaming.ts`",
        "`git log --oneline -5`",
        "`ls packages/core/src/chat`",
        "`wc -l packages/core/src/chat/streaming.ts`",
        '`grep -rn "MAX_BUFFERED_CHUNKS" packages`',
        '`grep -rn "flush" docs`',
        "`git diff --stat`",
      ],
    );
    assert.ok(
      readonlyCalls.every((call) => call.kind !== "edit" && call.statuses.at(-1) === "completed"),
    );
    assert.match(readonlyCalls[0].rawOutput.content, /^# Cost architecture brief/);
    assert.equal(git("status", "--short"), editStatus);

    const other = await mock.prompt(sessionId, "Name this thread");
    assert.deepEqual(toolCalls(other), []);
    assert.equal(
      other.find((update) => update.sessionUpdate === "agent_message_chunk").content.text,
      "Mock reply.",
    );

    mock.end();
    assert.deepEqual(await mock.exited, { code: 0, signal: null });
  },
);

test(
  "the mock agent refuses the scenario outside its scratch repository",
  { timeout: 60000 },
  async (t) => {
    const dir = tempDir(t, "activity-diffs-mock-elsewhere-");
    writeFileSync(join(dir, "keep.txt"), "untouched\n");
    const mock = startMock(t, dir, dir);
    const sessionId = await mock.open();
    const updates = await mock.prompt(
      sessionId,
      "<user_request>\nSCENARIO:edit go\n</user_request>",
    );
    assert.deepEqual(toolCalls(updates), []);
    assert.match(
      updates.find((update) => update.sessionUpdate === "agent_message_chunk").content.text,
      /only in the capture's scratch repository/,
    );
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "untouched\n");
    mock.end();
    assert.deepEqual(await mock.exited, { code: 0, signal: null });
  },
);
