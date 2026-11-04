// verify-built-app.mjs without a real build: argument parsing, the step deadline, and how each
// failure reaches the receipt and the exit code, with a fake app (a Node script whose bundled
// "server" answers the environment endpoint) and fake installed-e2e and proof scripts. The
// upgraded mode runs the real post-update check (update.py verify --local) on a small home.
// Children get a scratch environment, so the fakes read their behaviour from BEHAVIOUR and log
// the HOME they were given to HOMES.
//
//   node --test scripts/release/verify-built-app.test.mjs
import assert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_SCRIPTS, compareVersions, main, parseArgs, runStep, UsageError } from "./verify-built-app.mjs";

const ROOT = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "verify-built-app-test-")));
// What failed runs keep for inspection (scratch homes) lands here and goes with it.
const SAVED_TMPDIR = process.env.TMPDIR;
process.env.TMPDIR = ROOT;
after(() => {
  if (SAVED_TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = SAVED_TMPDIR;
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

const BEHAVIOUR = NodePath.join(ROOT, "behaviour.json");
const HOMES = NodePath.join(ROOT, "homes.log");
// Read by every fake: { e2e: ok|hang|inner-timeout|thread-fails|no-coordinator, proof: ok|fail }.
const BEHAVIOUR_JS = `const behaviour = (() => { try { return JSON.parse(require("node:fs").readFileSync(${JSON.stringify(BEHAVIOUR)}, "utf8")); } catch { return {}; } })();
const logHome = (role) => require("node:fs").appendFileSync(${JSON.stringify(HOMES)}, JSON.stringify({ role, home: process.env.HOME, studioHome: process.env.STUDIO_HOME, tmp: process.env.TMPDIR }) + "\\n");`;
const ESM_REQUIRE = `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`;

const SCHEMA = `
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(request_id TEXT, prompt TEXT, status TEXT);
CREATE TABLE orchestration_v2_effect_outbox(effect_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_provider_sessions(session_id TEXT, status TEXT);
INSERT INTO projection_projects VALUES ('project-1', 'E2E project');
INSERT INTO orchestration_v2_projection_threads VALUES ('thread-1', 'E2E thread');
INSERT INTO orchestration_v2_projection_runs VALUES ('run-1', 'thread-1', 'completed');
`;

// The fake app: Node, run through its shebang. `-e` answers the server-entry probe; `<entry>
// start ... --port P --base-dir B` serves the environment endpoint, after dropping a thread when
// the app folder holds lose-thread.
const FAKE_APP = `#!${process.execPath}
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
${BEHAVIOUR_JS}
const here = path.dirname(fs.realpathSync(__filename));
const version = fs.readFileSync(path.join(here, "version.txt"), "utf8").trim();
const args = process.argv.slice(2);
if (args[0] === "-e") {
  process.stdout.write(JSON.stringify(args.slice(2).map((p) => fs.existsSync(p))));
  process.exit(0);
}
if (args[1] === "start") {
  logHome("server");
  const port = Number(args[args.indexOf("--port") + 1]);
  const base = args[args.indexOf("--base-dir") + 1];
  if (fs.existsSync(path.join(here, "lose-thread"))) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(base, "userdata", "statev2.sqlite"));
    db.exec("DELETE FROM orchestration_v2_projection_threads");
    db.close();
  }
  const environmentId = fs.readFileSync(path.join(base, "userdata", "environment-id"), "utf8").trim();
  http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ serverVersion: version, environmentId }));
  }).listen(port, "127.0.0.1");
  process.on("SIGTERM", () => process.exit(0));
  return;
}
process.exit(3);
`;

// The fake installed-e2e (behaviour.e2e): ok; hang (ignores its own --timeout-ms); inner-timeout
// (stops itself at --timeout-ms and writes its diagnostics, as the real one does); thread-fails;
// no-coordinator (leaves the coordinator check out). It leaves a scratch home with a small statev2
// the way the real one does with --keep-scratch.
const FAKE_E2E = `${ESM_REQUIRE}
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { spawn } from "node:child_process"; import { DatabaseSync } from "node:sqlite";
${BEHAVIOUR_JS}
logHome("installed-e2e");
const argv = process.argv.slice(2), opt = (n) => argv[argv.indexOf(n) + 1];
const app = opt("--app"), out = opt("--out"), mode = behaviour.e2e ?? "ok";
fs.mkdirSync(out, { recursive: true });
if (mode === "inner-timeout") {
  setTimeout(() => {
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ ok: false, checks: [{ name: "timeout", status: "fail", diagnostics: "written" }] }));
    process.exit(1);
  }, Number(opt("--timeout-ms")));
} else if (mode === "hang") {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  fs.writeFileSync(path.join(out, "grandchild.pid"), String(child.pid));
  setInterval(() => {}, 1000);
} else {
  const version = fs.readFileSync(path.join(path.dirname(app), "version.txt"), "utf8").trim();
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swc-e2e-")));
  const base = path.join(scratch, "base");
  fs.mkdirSync(path.join(base, "userdata"), { recursive: true });
  const db = new DatabaseSync(path.join(base, "userdata", "statev2.sqlite"));
  db.exec(${JSON.stringify(SCHEMA)}); db.close();
  fs.writeFileSync(path.join(base, "userdata", "settings.json"), JSON.stringify({ theme: "dark" }));
  fs.writeFileSync(path.join(base, "userdata", "environment-id"), "environment-" + version + "\\n");
  const checks = [
    { name: "bundled-server-entry", status: "pass", entry: path.join(path.dirname(app), "bin.mjs") },
    { name: "server-start", status: "pass", serverVersion: version, environmentId: "environment-" + version },
    { name: "thread-reply", status: mode === "thread-fails" ? "fail" : "pass" },
    ...(mode === "no-coordinator" ? [] : [{ name: "coordinator-reply", status: "pass" }]),
    { name: "fake-agent-log", status: "pass" },
  ];
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ ok: mode !== "thread-fails", scratch, baseDir: base, checks }));
  process.exit(mode === "thread-fails" ? 1 : 0);
}
`;

// A fake acceptance proof: behaviour.proof fail exits 1; otherwise a passed receipt.
const FAKE_PROOF = `${ESM_REQUIRE}
import * as fs from "node:fs"; import * as path from "node:path";
${BEHAVIOUR_JS}
logHome("proof");
const argv = process.argv.slice(2), dir = argv[argv.indexOf("--report-dir") + 1];
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(path.dirname(dir), "proof-calls.txt"), argv.join(" ") + "\\n");
if (behaviour.proof === "fail") process.exit(1);
fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify({ result: "passed" }));
`;

const SCRIPTS = {
  ...DEFAULT_SCRIPTS,
  installedE2e: NodePath.join(ROOT, "fake-e2e.mjs"),
  startupProof: NodePath.join(ROOT, "fake-proof.mjs"),
  installedStartup: NodePath.join(ROOT, "fake-proof.mjs"),
};

const makeApp = (version) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(ROOT, `app-${version}-`));
  const executable = NodePath.join(dir, "Fake.app", "Contents", "MacOS", "Fake");
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
  NodeFS.writeFileSync(executable, FAKE_APP, { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(NodePath.dirname(executable), "version.txt"), `${version}\n`);
  NodeFS.writeFileSync(
    NodePath.join(dir, "Fake.app", "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key>\n<string>Fake</string></dict></plist>\n",
  );
  // Where the server-entry probe looks on macOS (Resources) and elsewhere (resources).
  for (const resources of [NodePath.join(dir, "Fake.app", "Contents", "Resources"), NodePath.join(NodePath.dirname(executable), "resources")]) {
    NodeFS.mkdirSync(NodePath.join(resources, "app", "apps", "server", "dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(resources, "app", "apps", "server", "dist", "bin.mjs"), "");
  }
  return { bundle: NodePath.join(dir, "Fake.app"), executable };
};

const quiet = () => {};
const run = (args) => main(args, { scripts: SCRIPTS, log: quiet });
const receiptOf = (out) => JSON.parse(NodeFS.readFileSync(NodePath.join(out, "receipt.json"), "utf8"));
const withBehaviour = async (values, fn) => {
  NodeFS.writeFileSync(BEHAVIOUR, JSON.stringify(values));
  try {
    return await fn();
  } finally {
    NodeFS.rmSync(BEHAVIOUR, { force: true });
  }
};
// What a mode leaves in this test's TMPDIR: nothing unless --keep.
const leftScratch = () => NodeFS.readdirSync(ROOT).filter((name) => /^swc-(verify|e2e)-/.test(name));
const outDir = (name) => NodePath.join(ROOT, "out", name);

before(() => {
  NodeFS.writeFileSync(SCRIPTS.installedE2e, FAKE_E2E);
  NodeFS.writeFileSync(SCRIPTS.startupProof, FAKE_PROOF);
});

describe("parseArgs", () => {
  const base = ["--mode", "fresh", "--app", "/x/SpecWithCode.app", "--version", "1.2.3", "--out", "/tmp/o"];

  it("reads a fresh run with defaults of 120 s and the proofs on", () => {
    assert.deepEqual(parseArgs(base), {
      mode: "fresh",
      app: "/x/SpecWithCode.app",
      version: "1.2.3",
      out: "/tmp/o",
      proofs: true,
      keep: false,
      timeoutMs: 120_000,
      proofTimeoutMs: 240_000,
    });
  });

  it("refuses an upgraded run without the previous release's state: a skipped verify is a failure", () => {
    assert.throws(
      () => parseArgs(["--mode", "upgraded", ...base.slice(2)]),
      (error) => error instanceof UsageError && /a skipped verify fails the release/.test(error.message),
    );
    assert.equal(parseArgs(["--mode", "all", ...base.slice(2), "--fixture", "f.tar.gz"]).fixture, NodePath.resolve("f.tar.gz"));
  });

  it("refuses missing, malformed and conflicting options", () => {
    const refuses = (args, pattern) =>
      assert.throws(() => parseArgs(args), (error) => error instanceof UsageError && pattern.test(error.message));
    refuses(base.filter((_, i) => i !== 4 && i !== 5), /--version X\.Y\.Z is required/);
    refuses([...base.slice(0, 5), "1.2", ...base.slice(6)], /--version X\.Y\.Z is required/);
    refuses(["--mode", "later", ...base.slice(2)], /--mode must be/);
    refuses([...base, "--archive", "a.zip"], /one of --archive or --app/);
    refuses(base.slice(0, 2).concat(base.slice(4)), /one of --archive or --app/);
    refuses([...base, "--timeout-ms", "soon"], /--timeout-ms must be/);
    refuses([...base, "--proof-timeout-ms", "5"], /--proof-timeout-ms must be/);
    refuses([...base, "--out"], /--out needs a value/);
    refuses([...base, "--bogus", "1"], /unknown option --bogus/);
    refuses([...base, "--fixture", "f"], /for the upgraded mode/);
    refuses(["--mode", "all", ...base.slice(2), "--fixture", "f", "--previous-app", "p"], /one of --fixture/);
    refuses(["--mode", "upgraded", ...base.slice(2), "--fixture", "f", "--fixture-out", "g"], /--fixture-out needs the fresh mode/);
  });

  it("returns 2 for a usage error", async () => {
    assert.equal(await run(["--mode", "upgraded", "--app", "a", "--version", "1.0.0", "--out", outDir("usage")]), 2);
    assert.equal(NodeFS.existsSync(outDir("usage")), false);
  });

  it("orders versions", () => {
    assert.equal(compareVersions("1.0.9", "1.0.10"), -1);
    assert.equal(compareVersions("1.1.0", "1.0.99"), 1);
    assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  });
});

describe("runStep", () => {
  it("stops a step and everything in its group at the deadline", async () => {
    const pidFile = NodePath.join(ROOT, "step-grandchild.pid");
    const started = Date.now();
    const step = await runStep(
      "sh",
      ["-c", `sleep 600 & echo $! > '${pidFile}'; wait`],
      { timeoutMs: 1_500, log: NodePath.join(ROOT, "step.log") },
    );
    assert.equal(step.timedOut, true);
    assert.notEqual(step.code, 0);
    assert.ok(Date.now() - started < 15_000, "the deadline did not stop the step");
    const grandchild = Number(NodeFS.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
  });

  it("reports a command that cannot start", async () => {
    const step = await runStep(NodePath.join(ROOT, "missing-binary"), [], { timeoutMs: 5_000, log: NodePath.join(ROOT, "missing.log") });
    assert.equal(step.timedOut, false);
    assert.match(step.error, /ENOENT/);
  });
});

describe("fresh mode", () => {
  it("passes, runs the startup proof against the bundled server and packs the fixture", async () => {
    const app = makeApp("1.0.1");
    const out = outDir("fresh-ok");
    const fixture = NodePath.join(ROOT, "fixtures", "state-1.0.1.tar.gz");
    assert.equal(await run(["--mode", "fresh", "--app", app.bundle, "--version", "1.0.1", "--out", out, "--fixture-out", fixture]), 0);
    const receipt = receiptOf(out);
    assert.equal(receipt.result, "passed");
    assert.equal(receipt.executable, app.executable);
    assert.equal(receipt.modes.fresh.serverVersion, "1.0.1");
    assert.deepEqual(receipt.failures, []);
    const calls = NodeFS.readFileSync(NodePath.join(out, "fresh", "proof-calls.txt"), "utf8");
    assert.match(calls, /--entrypoint \S+bin\.mjs --cli-wrapper \S+studio-cli --report-dir/);
    const listing = NodeChildProcess.spawnSync("tar", ["-tzf", fixture], { encoding: "utf8" }).stdout;
    assert.match(listing, /base\/userdata\/statev2\.sqlite/);
    assert.match(listing, /fixture\.json/);
  });

  it("fails when the environment endpoint reports another version", async () => {
    const app = makeApp("1.0.1");
    const out = outDir("fresh-version");
    assert.equal(await run(["--mode", "fresh", "--app", app.bundle, "--version", "1.0.2", "--out", out]), 1);
    assert.ok(receiptOf(out).failures.includes("fresh: /.well-known/studio/environment reports 1.0.1, expected 1.0.2"));
  });

  it("fails on a thread that got no reply and names the check", async () => {
    const out = outDir("fresh-thread");
    const code = await withBehaviour({ e2e: "thread-fails" }, () =>
      run(["--mode", "fresh", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", out]),
    );
    assert.equal(code, 1);
    const { failures, result } = receiptOf(out);
    assert.equal(result, "failed");
    assert.ok(failures.includes("fresh: check thread-reply failed"));
    assert.ok(failures.some((failure) => /^fresh: installed-e2e exited 1/.test(failure)));
    assert.deepEqual(leftScratch(), [], "a failed run still removes its scratch homes");
  });

  it("leaves installed-e2e the time to write its diagnostics at its own deadline", async () => {
    const out = outDir("fresh-inner-timeout");
    const code = await withBehaviour({ e2e: "inner-timeout" }, () =>
      run(["--mode", "fresh", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", out, "--timeout-ms", "1500"]),
    );
    assert.equal(code, 1);
    const { failures } = receiptOf(out);
    assert.ok(failures.includes("fresh: check timeout failed"), failures.join("; "));
    assert.ok(!failures.some((failure) => /did not finish/.test(failure)), failures.join("; "));
    assert.equal(JSON.parse(NodeFS.readFileSync(NodePath.join(out, "fresh", "fresh", "results.json"), "utf8")).checks[0].diagnostics, "written");
  });

  it("requires the coordinator reply and the fake agent log checks", async () => {
    const out = outDir("fresh-no-coordinator");
    const code = await withBehaviour({ e2e: "no-coordinator" }, () =>
      run(["--mode", "fresh", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", out]),
    );
    assert.equal(code, 1);
    assert.ok(receiptOf(out).failures.includes("fresh: check coordinator-reply did not run"));
  });

  it("keeps the scratch homes with --keep", async () => {
    const out = outDir("fresh-keep");
    assert.equal(await run(["--mode", "fresh", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", out, "--keep"]), 0);
    const kept = receiptOf(out).modes.fresh.scratch;
    assert.ok(NodeFS.readdirSync(NodePath.join(kept, "tmp")).some((name) => name.startsWith("swc-e2e-")));
    NodeFS.rmSync(kept, { recursive: true, force: true });
  });

  it("fails a hung run at --timeout-ms and stops what it started", async () => {
    const out = outDir("fresh-hang");
    const started = Date.now();
    const code = await withBehaviour({ e2e: "hang" }, () =>
      run(["--mode", "fresh", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", out, "--timeout-ms", "2000"]),
    );
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 20_000);
    // Its own deadline, then the headroom for its diagnostics: 2000 + 2000 ms.
    assert.ok(receiptOf(out).failures.some((failure) => /installed-e2e did not finish within 4000 ms/.test(failure)));
    assert.deepEqual(leftScratch(), []);
    const grandchild = Number(NodeFS.readFileSync(NodePath.join(out, "fresh", "fresh", "grandchild.pid"), "utf8"));
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
  });

  it("on SIGTERM stops every child group and removes its temporary folders", async () => {
    const out = outDir("fresh-sigterm");
    const tmp = NodeFS.mkdtempSync(NodePath.join(ROOT, "sigterm-tmp-"));
    // The CLI's own wiring (verify-built-app.mjs's entry block), with the fakes as its scripts.
    const driver = NodePath.join(ROOT, "sigterm-driver.mjs");
    NodeFS.writeFileSync(driver, `import { interrupted, main } from ${JSON.stringify(new URL("./verify-built-app.mjs", import.meta.url).href)};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => interrupted(sig));
process.exitCode = await main(process.argv.slice(2), { scripts: ${JSON.stringify(SCRIPTS)}, log: () => {} });\n`);
    NodeFS.writeFileSync(BEHAVIOUR, JSON.stringify({ e2e: "hang" }));
    try {
      const child = NodeChildProcess.spawn(process.execPath, [driver, "--mode", "fresh", "--app", makeApp("1.0.1").bundle,
        "--version", "1.0.1", "--out", out, "--timeout-ms", "120000"], { env: { ...process.env, TMPDIR: tmp }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
      const pidFile = () => {
        const walk = (dir) => NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(NodePath.join(dir, entry.name)) : entry.name === "grandchild.pid" ? [NodePath.join(dir, entry.name)] : []);
        return walk(tmp)[0];
      };
      const started = Date.now();
      while (!pidFile()) {
        assert.ok(Date.now() - started < 30_000, `the hung e2e never started: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const grandchild = Number(NodeFS.readFileSync(pidFile(), "utf8"));
      child.kill("SIGTERM");
      const { code } = await exited;
      assert.equal(code, 143, stderr);
      assert.match(stderr, /stopped by SIGTERM/);
      assert.deepEqual(NodeFS.readdirSync(tmp), []);
      assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
    } finally {
      NodeFS.rmSync(BEHAVIOUR, { force: true });
    }
  });

  it("fails when the startup proof fails, and packs no fixture from that home", async () => {
    const out = outDir("fresh-proof");
    const fixture = NodePath.join(ROOT, "fixtures", "state-proof-failed.tar.gz");
    const code = await withBehaviour({ proof: "fail" }, () =>
      run(["--mode", "fresh", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", out, "--fixture-out", fixture]),
    );
    assert.equal(code, 1);
    assert.ok(receiptOf(out).failures.some((failure) => /^fresh: test-startup\.mjs exited 1/.test(failure)));
    assert.equal(NodeFS.existsSync(fixture), false);
    assert.deepEqual(leftScratch(), []);
  });

  it("fails on an app that does not exist", async () => {
    const out = outDir("fresh-missing");
    assert.equal(await run(["--mode", "fresh", "--app", NodePath.join(ROOT, "None.app"), "--version", "1.0.1", "--out", out]), 1);
    assert.match(receiptOf(out).failures[0], /names no main executable|does not exist/);
  });
});

describe("upgraded mode", () => {
  let fixture;
  before(async () => {
    fixture = NodePath.join(ROOT, "fixtures", "state-1.0.1-upgraded.tar.gz");
    assert.equal(await run(["--mode", "fresh", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", outDir("make-fixture"), "--fixture-out", fixture]), 0);
  });

  it("passes the post-update check and the local installed-startup proof on the seeded home", async () => {
    const out = outDir("upgraded-ok");
    assert.equal(await run(["--mode", "upgraded", "--app", makeApp("1.0.2").bundle, "--version", "1.0.2", "--out", out, "--fixture", fixture]), 0);
    const receipt = receiptOf(out);
    assert.equal(receipt.modes.upgraded.previousVersion, "1.0.1");
    assert.equal(receipt.modes.upgraded.serverVersion, "1.0.2");
    const check = JSON.parse(NodeFS.readFileSync(NodePath.join(out, "upgraded", "post-update-check.json"), "utf8"));
    assert.equal(check.result, "verified");
    const calls = NodeFS.readFileSync(NodePath.join(out, "upgraded", "proof-calls.txt"), "utf8");
    assert.match(calls, /^--local --origin http:\/\/127\.0\.0\.1:\d+ --cli-wrapper \S+ --base-dir \S+ --expected \S+before\.json/m);
    assert.deepEqual(leftScratch(), []);
  });

  it("gives no child of the upgraded mode the caller's HOME", async () => {
    // python3 on PATH logs the HOME the post-update check gets, then runs the real one.
    const bin = NodePath.join(ROOT, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    const python = NodeChildProcess.spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    NodeFS.writeFileSync(NodePath.join(bin, "python3"),
      `#!/bin/sh\nprintf '{"role":"python3","home":"%s","studioHome":"%s","tmp":"%s"}\\n' "$HOME" "$STUDIO_HOME" "$TMPDIR" >> '${HOMES}'\nexec '${python}' "$@"\n`, { mode: 0o755 });
    NodeFS.rmSync(HOMES, { force: true });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${NodePath.delimiter}${savedPath}`;
    const out = outDir("upgraded-homes");
    try {
      assert.equal(await run(["--mode", "upgraded", "--app", makeApp("1.0.2").bundle, "--version", "1.0.2", "--out", out, "--previous-app", makeApp("1.0.1").bundle]), 0);
    } finally {
      process.env.PATH = savedPath;
    }
    const seen = NodeFS.readFileSync(HOMES, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual([...new Set(seen.map((entry) => entry.role))].sort(), ["installed-e2e", "proof", "python3", "server"]);
    const real = NodeOS.userInfo().homedir;
    for (const entry of seen) {
      assert.notEqual(entry.home, real, `${entry.role} got the real HOME`);
      assert.match(entry.home, /\/swc-verify-upgraded-[^/]+\/home$/, `${entry.role} HOME ${entry.home}`);
      assert.match(entry.studioHome, /\/swc-verify-upgraded-[^/]+\/base$/, `${entry.role} STUDIO_HOME ${entry.studioHome}`);
      assert.match(entry.tmp, /\/swc-verify-upgraded-[^/]+\/tmp$/, `${entry.role} TMPDIR ${entry.tmp}`);
    }
    assert.deepEqual(leftScratch(), []);
  });

  it("makes the fixture from the previous app when none is given", async () => {
    const out = outDir("upgraded-previous-app");
    const code = await run(["--mode", "all", "--app", makeApp("1.0.2").bundle, "--version", "1.0.2", "--out", out, "--previous-app", makeApp("1.0.1").bundle]);
    assert.equal(code, 0);
    const receipt = receiptOf(out);
    assert.deepEqual(Object.keys(receipt.modes), ["fresh", "upgraded"]);
    assert.equal(receipt.modes.upgraded.previousVersion, "1.0.1");
  });

  it("fails when the new build loses a thread", async () => {
    const app = makeApp("1.0.2");
    NodeFS.writeFileSync(NodePath.join(NodePath.dirname(app.executable), "lose-thread"), "");
    const out = outDir("upgraded-lost-thread");
    assert.equal(await run(["--mode", "upgraded", "--app", app.bundle, "--version", "1.0.2", "--out", out, "--fixture", fixture]), 1);
    const receipt = receiptOf(out);
    assert.ok(receipt.failures.some((failure) => /post-update check \(update\.py verify --local\) exited 1/.test(failure)));
    const check = JSON.parse(NodeFS.readFileSync(NodePath.join(out, "upgraded", "post-update-check.json"), "utf8"));
    assert.equal(check.error, "A thread disappeared during migration");
    assert.equal(receipt.modes.upgraded.scratch, undefined);
    assert.deepEqual(leftScratch(), [], "a failed upgrade still removes its scratch home");
  });

  it("refuses a fixture that is not from an earlier release", async () => {
    const out = outDir("upgraded-same");
    assert.equal(await run(["--mode", "upgraded", "--app", makeApp("1.0.1").bundle, "--version", "1.0.1", "--out", out, "--fixture", fixture]), 1);
    assert.ok(receiptOf(out).failures.includes("upgraded: the fixture is from 1.0.1, not a release before 1.0.1"));
  });

  it("fails on a fixture file that does not exist", async () => {
    const out = outDir("upgraded-nofixture");
    assert.equal(await run(["--mode", "upgraded", "--app", makeApp("1.0.2").bundle, "--version", "1.0.2", "--out", out, "--fixture", NodePath.join(ROOT, "none.tar.gz")]), 1);
    assert.ok(receiptOf(out).failures.some((failure) => /does not exist/.test(failure)));
  });
});
