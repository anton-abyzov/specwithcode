import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
const test = NodeTest.test;
const assert = NodeAssert.default;
const workflow = NodeFS.readFileSync(
  new URL("../../.github/workflows/platform-tests.yml", import.meta.url),
  "utf8",
);
const start = workflow.indexOf(
  "          set -euo pipefail\n",
  workflow.indexOf("- name: Choose the matrix"),
);
const end = workflow.indexOf("\n  test:\n", start);
assert.ok(start > 0 && end > start);
const script = workflow
  .slice(start, end)
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");
function matrix(files, event = "pull_request") {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "platform matrix "));
  try {
    const out = NodePath.join(dir, "out"),
      summary = NodePath.join(dir, "summary");
    const prefix = `set -euo pipefail\nif command -v cygpath >/dev/null; then GITHUB_OUTPUT="$(cygpath -u "$GITHUB_OUTPUT")"; GITHUB_STEP_SUMMARY="$(cygpath -u "$GITHUB_STEP_SUMMARY")"; fi\ngit() { printf '%s\\n' "$FILES"; }; jq() { if [ "$1" = length ]; then echo 0; else cat >/dev/null; fi; };\n`;
    NodeChildProcess.execFileSync("bash", ["-c", prefix + script], {
      env: {
        ...process.env,
        FILES: files.join("\n"),
        EVENT_NAME: event,
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: summary,
      },
      encoding: "utf8",
    });
    const result = NodeFS.readFileSync(out, "utf8").trim();
    assert.ok(result.startsWith("include="));
    return JSON.parse(result.slice("include=".length));
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
test("actual broad and narrow PR matrices require exactly five Windows server shards", () => {
  for (const files of [
    ["packages/contracts/src/server.ts"],
    ["apps/server/src/test.ts"],
    [".github/workflows/platform-tests.yml"],
  ]) {
    const rows = matrix(files).filter((row) => row.suite === "server");
    assert.deepEqual(
      rows.map((row) => row.shard),
      [1, 2, 3, 4, 5],
    );
    assert.ok(rows.every((row) => row.changed && row.shards === 5 && row.os === "windows-2025"));
  }
});
test("actual empty and web-only matrices preserve scoped reachability", () => {
  assert.deepEqual(matrix(["docs/user/install.md"]), []);
  assert.deepEqual(matrix([]), []);
  const web = matrix(["apps/web/src/a.ts"]);
  assert.equal(web.length, 1);
  assert.equal(web[0].suite, "web");
  assert.equal(web[0].shards, 1);
});
test("nightly/manual full matrices preserve both OSes and existing shard counts", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const rows = matrix([], event);
    assert.equal(rows.length, 11);
    assert.equal(
      rows.filter((row) => row.os === "ubuntu-24.04" && row.suite === "server").length,
      2,
    );
    assert.equal(
      rows.filter((row) => row.os === "windows-2025" && row.suite === "server").length,
      5,
    );
    assert.ok(rows.every((row) => !row.changed));
  }
});
function gates(text) {
  return (
    text.includes("timeout-minutes: 60") &&
    text.includes('VITEST_MAX_WORKERS: "2"') &&
    text.includes("fail-fast: false") &&
    text.includes("needs: [plan, test]") &&
    text.includes("if: ${{ always() && needs.plan.result != 'skipped' }}") &&
    text.includes(
      'node scripts/studio-verify/platform-shard-coverage.mjs verify "$PLAN" logs "$HEAD_SHA" "$BASE_SHA"',
    ) &&
    text.includes('[ "${{ needs.test.result }}" = "success" ]') &&
    text.includes(
      "name: platform-tests-${{ runner.os }}-${{ matrix.suite }}-${{ matrix.shard }}",
    ) &&
    text.includes("format('--changed origin/{0}', github.base_ref)") &&
    text.includes('git update-ref "refs/remotes/origin/$BASE" "$BASE_SHA"')
  );
}
test("workflow keeps limits, base, artifacts and required aggregate coverage", () => {
  assert.ok(gates(workflow));
  for (const token of [
    "needs: [plan, test]",
    "platform-shard-coverage.mjs verify",
    "timeout-minutes: 60",
    'VITEST_MAX_WORKERS: "2"',
    "fail-fast: false",
  ])
    assert.ok(!gates(workflow.replace(token, "removed")), token);
  assert.match(workflow, /List failing test files per OS\n\s+if: always\(\)/);
  assert.match(workflow, /set -e\n\s+if reaches apps\/server packages/);
});
