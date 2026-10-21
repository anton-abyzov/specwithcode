import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const gate = new URL("./typecheck-gate.sh", import.meta.url).pathname;
const skip = process.platform === "win32" ? "needs bash" : false;

// A finished run as typecheck-gate.sh leaves it: one log and exit file per package.
function run(packages, baseline, extra = []) {
  const out = mkdtempSync(join(tmpdir(), "typecheck-gate-test-"));
  try {
    writeFileSync(join(out, "packages.txt"), Object.keys(packages).join("\n") + "\n");
    for (const [name, { exit, log, timeout }] of Object.entries(packages)) {
      const slug = name.replaceAll("/", "__");
      writeFileSync(join(out, `${slug}.log`), log);
      if (exit !== undefined) writeFileSync(join(out, `${slug}.exit`), `${exit}\n`);
      if (timeout) writeFileSync(join(out, `${slug}.timeout`), "");
    }
    const baselineFile = join(out, "baseline.txt");
    writeFileSync(baselineFile, baseline);
    const result = spawnSync(
      "bash",
      [gate, "--from-logs", out, "--baseline", baselineFile, ...extra],
      { encoding: "utf8" },
    );
    return { ...result, baseline: readFileSync(baselineFile, "utf8") };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const serverLog = [
  "src/a.ts(3,5): error TS377057: This module reference uses the `fs` module.",
  "  continuation line of the message",
  "src/a.ts(9,1): error TS377057: This module reference uses the `path` module.",
  "src/b.test.ts(12,9): warning TS377033: This expression chains multiple `Effect.provide` calls.",
  "src/c.ts(1,1): suggestion TS377047: Suggestions never fail the gate.",
  "",
].join("\n");
const serverBaseline = [
  "# comment",
  "apps/server/src/a.ts TS377057 2",
  "apps/server/src/b.test.ts TS377033 1",
  "",
].join("\n");

test("passes a red package whose diagnostics are all baselined", { skip }, () => {
  const result = run({ "apps/server": { exit: 1, log: serverLog } }, serverBaseline);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /apps\/server\s+1\s+3\s+0\s+pass/);
});

test("fails on a diagnostic the baseline does not have", { skip }, () => {
  const log = serverLog + "src/d.ts(4,2): error TS2345: Argument of type 'string'.\n";
  const result = run({ "apps/server": { exit: 1, log } }, serverBaseline);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /new: apps\/server\/src\/d\.ts TS2345 \(\+1\)/);
});

test("fails when a baselined file gains another diagnostic of the same code", { skip }, () => {
  const log = serverLog + "src/a.ts(20,1): error TS377057: A third node builtin import.\n";
  const result = run({ "apps/server": { exit: 1, log } }, serverBaseline);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /new: apps\/server\/src\/a\.ts TS377057 \(\+1\)/);
});

test("fails a non-zero exit that no diagnostic explains", { skip }, () => {
  const result = run(
    { "apps/desktop": { exit: 1, log: "src/x.ts(1,1): suggestion TS377117: only advice\n" } },
    "",
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /apps\/desktop\s+1\s+0\s+0\s+FAIL/);
});

test("fails a crash exit even after baselined diagnostics", { skip }, () => {
  const result = run({ "apps/server": { exit: 134, log: serverLog } }, serverBaseline);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /apps\/server\s+134\s+3\s+0\s+FAIL/);
});

test("fails a Go crash that exits 2 after baselined diagnostics", { skip }, () => {
  const log = serverLog + "fatal error: runtime: out of memory\n\ngoroutine 1 [running]:\n";
  const result = run({ "apps/server": { exit: 2, log } }, serverBaseline);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /apps\/server\s+2\s+3\s+0\s+FAIL/);
  assert.match(result.stdout, /crashed \(exit 2\): fatal error: runtime: out of memory/);
});

test("fails a crash in the log whatever the exit code", { skip }, () => {
  for (const [exit, line] of [
    [1, "panic: runtime error: index out of range [3] with length 3"],
    [0, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"],
  ]) {
    const result = run({ "apps/server": { exit, log: serverLog + line + "\n" } }, serverBaseline);
    assert.equal(result.status, 1, `exit ${exit}`);
    assert.match(result.stdout, new RegExp(`crashed \\(exit ${exit}\\)`));
  }
});

test("fails exit 2 and signals even with baselined diagnostics and no crash text", { skip }, () => {
  for (const exit of [2, 137]) {
    const result = run({ "apps/server": { exit, log: serverLog } }, serverBaseline);
    assert.equal(result.status, 1, `exit ${exit}`);
    assert.match(result.stdout, new RegExp(`exit ${exit} is not a diagnostic exit`));
  }
});

test("does not read a diagnostic that mentions a panic as a crash", { skip }, () => {
  const log = serverLog + "src/a.ts(5,1): error TS377057: panic: not at the start of a line.\n";
  const result = run(
    { "apps/server": { exit: 1, log } },
    "apps/server/src/a.ts TS377057 3\napps/server/src/b.test.ts TS377033 1\n",
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("fails a timed-out or unfinished typecheck", { skip }, () => {
  const result = run(
    {
      "apps/web": { exit: 143, log: "", timeout: true },
      "packages/shared": { log: "" },
    },
    "",
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /apps\/web\s+143\s+0\s+0\s+TIMEOUT/);
  assert.match(result.stdout, /packages\/shared\s+-\s+0\s+0\s+NO-RESULT/);
});

test("keys files by repo-relative path, outside the package too", { skip }, () => {
  const log = "../../scripts/lib/shared.ts(2,3): error TS2322: Type 'number'.\n";
  const result = run({ "apps/desktop": { exit: 1, log } }, "scripts/lib/shared.ts TS2322 1\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("reports fixed entries and rewrites only the packages that ran", { skip }, () => {
  const baseline = serverBaseline + "packages/contracts/src/x.ts TS2345 4\n";
  const fixedLog = "src/a.ts(3,5): error TS377057: only one left.\n";
  const checked = run({ "apps/server": { exit: 1, log: fixedLog } }, baseline);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /fixed: apps\/server\/src\/a\.ts TS377057 \(baseline 2, now 1\)/);
  assert.match(
    checked.stdout,
    /fixed: apps\/server\/src\/b\.test\.ts TS377033 \(baseline 1, now 0\)/,
  );

  const written = run({ "apps/server": { exit: 1, log: fixedLog } }, baseline, [
    "--write-baseline",
  ]);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  const entries = written.baseline.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(entries, [
    "apps/server/src/a.ts TS377057 1",
    "packages/contracts/src/x.ts TS2345 4",
  ]);
});

// A real run in a throwaway workspace whose tsc is a script, so a crashing checker goes through
// job_run, the exit file and the log exactly as tsc's would.
test("a crashing checker fails a real gate run", { skip }, () => {
  const repo = mkdtempSync(join(tmpdir(), "typecheck-gate-repo-"));
  try {
    const verify = join(repo, "scripts", "studio-verify");
    mkdirSync(verify, { recursive: true });
    for (const name of ["typecheck-gate.sh", "jobs.sh"]) {
      copyFileSync(new URL(`./${name}`, import.meta.url).pathname, join(verify, name));
    }
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - pkg/*\n");
    const tsc = {
      oom: "echo \"args: $*\"\necho \"src/a.ts(1,1): error TS2322: Type 'number'.\"\necho 'fatal error: runtime: out of memory'\necho\necho 'goroutine 1 [running]:'\nexit 2\n",
      killed: "echo \"src/a.ts(1,1): error TS2322: Type 'number'.\"\nkill -9 $$\n",
      exit2: "echo \"src/a.ts(1,1): error TS2322: Type 'number'.\"\nexit 2\n",
      missing: null,
    };
    for (const [name, script] of Object.entries(tsc)) {
      const dir = join(repo, "pkg", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"scripts":{"typecheck":"tsc --noEmit"}}\n');
      if (script === null) continue;
      const bin = join(dir, "node_modules", ".bin", "tsc");
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, "#!/bin/sh\n" + script);
      chmodSync(bin, 0o755);
    }
    // Without crash detection the baselined diagnostic would make both packages pass.
    const baseline = join(repo, "baseline.txt");
    writeFileSync(
      baseline,
      ["oom", "killed", "exit2"].map((p) => `pkg/${p}/src/a.ts TS2322 1\n`).join(""),
    );
    const out = join(repo, "out");
    const env = { ...process.env };
    delete env.TYPECHECK_TSC_ARGS;
    const result = spawnSync(
      "bash",
      [join(verify, "typecheck-gate.sh"), "--out", out, "--baseline", baseline],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /pkg\/oom\s+2\s+1\s+0\s+FAIL/);
    assert.match(result.stdout, /crashed \(exit 2\): fatal error: runtime: out of memory/);
    assert.match(result.stdout, /pkg\/killed\s+137\s+1\s+0\s+FAIL/);
    assert.match(result.stdout, /pkg\/exit2\s+2\s+1\s+0\s+FAIL/);
    assert.match(result.stdout, /pkg\/missing\s+127\s+0\s+0\s+FAIL/);
    assert.match(result.stdout, /the workspace tsc is not installed/);
    // CI's checker count is the default.
    assert.match(readFileSync(join(out, "pkg__oom.log"), "utf8"), /args: --noEmit --checkers 2/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
