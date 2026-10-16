import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
