import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { mergeSummaries, parseArgs, readShardReport, verdict } from "./test-sharded.mjs";

describe("test-sharded options", () => {
  it("reads shards, output, changed base and trailing vitest filters", () => {
    expect(
      parseArgs(["--shards", "2", "--out", "/tmp/o", "--changed", "origin/main", "--", "src/a"]),
    ).toEqual({
      shards: 2,
      out: "/tmp/o",
      changed: "origin/main",
      timeoutMinutes: 60,
      filters: ["src/a"],
    });
  });

  it("skips the leading -- that pnpm run passes through", () => {
    expect(parseArgs(["--", "--shards", "2", "--out", "o", "--", "src/a"])).toMatchObject({
      shards: 2,
      out: "o",
      filters: ["src/a"],
    });
  });

  it("rejects a missing output, a bad shard count and a shell-looking base", () => {
    expect(() => parseArgs(["--shards", "3"])).toThrow("--out DIR is required");
    expect(() => parseArgs(["--shards", "0", "--out", "o"])).toThrow("--shards");
    expect(() => parseArgs(["--shards", "7", "--out", "o"])).toThrow("--shards");
    expect(() => parseArgs(["--out", "o", "--changed", "HEAD; rm -rf /"])).toThrow("--changed");
    expect(() => parseArgs(["--out"])).toThrow("--out needs a value");
    expect(() => parseArgs(["--out", "o", "--shard", "2"])).toThrow("Unknown option --shard");
  });
});

describe("test-sharded verdict", () => {
  const shard = (index, exitCode, files, timedOut = false) => ({
    index,
    exitCode,
    files,
    timedOut,
  });

  it("fails when any shard fails or times out", () => {
    expect(verdict([shard(1, 0, 3), shard(2, 1, 2)], {})).toEqual({
      ok: false,
      reason: "shard 2 failed",
    });
    expect(verdict([shard(1, 0, 3), shard(2, 0, 2, true)], {}).ok).toBe(false);
  });

  it("fails a full run in which no shard ran a file, but not a changed run", () => {
    expect(verdict([shard(1, 0, 0), shard(2, 0, 0)], {}).ok).toBe(false);
    expect(verdict([shard(1, 0, 0), shard(2, 0, 0)], { changed: "abc123" })).toEqual({
      ok: true,
      reason: "no test file is affected by the changes",
    });
    expect(verdict([shard(1, 0, 4), shard(2, 0, 0)], {})).toEqual({ ok: true, reason: "passed" });
  });

  it("rejects an empty changed run when server tests changed", () => {
    expect(
      verdict([shard(1, 0, 0), shard(2, 0, 0)], {
        changed: "abc123",
        changedTestFiles: ["apps/server/src/fleet/FleetWorkerGrants.test.ts"],
      }),
    ).toEqual({ ok: false, reason: "no shard ran a changed server test file" });
  });
});

describe("test-sharded reports", () => {
  it("counts files and lists failed ones relative to the server", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "test-sharded-"));
    try {
      const file = NodePath.join(dir, "server-1.json");
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          numTotalTests: 5,
          numFailedTests: 1,
          testResults: [
            { name: "/repo/apps/server/src/a.test.ts", status: "passed" },
            {
              name: "/repo/apps/server/src/b/c.test.ts",
              status: "failed",
              assertionResults: [
                { fullName: "c keeps", status: "passed", failureMessages: [] },
                {
                  fullName: "c breaks",
                  status: "failed",
                  failureMessages: ["AssertionError: expected 1 to be 2\n    at c.test.ts:9"],
                },
              ],
            },
          ],
        }),
      );
      expect(readShardReport(file, "/repo/apps/server")).toEqual({
        files: 2,
        failedFiles: ["src/b/c.test.ts"],
        failures: [
          {
            file: "src/b/c.test.ts",
            test: "c breaks",
            message: "AssertionError: expected 1 to be 2",
          },
        ],
        tests: 5,
        failedTests: 1,
      });
      expect(readShardReport(NodePath.join(dir, "missing.json"))).toEqual({
        files: 0,
        failedFiles: [],
        failures: [],
        tests: 0,
        failedTests: 0,
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("test-sharded split across jobs", () => {
  const shard = (index, exitCode, files) => ({ index, exitCode, files, timedOut: false, failedFiles: [] });

  it("runs a subset of up to 12 shards and rejects bad subsets", () => {
    expect(parseArgs(["--shards", "6", "--run", "3,4", "--out", "o"])).toMatchObject({
      shards: 6,
      run: [3, 4],
    });
    expect(() => parseArgs(["--shards", "12", "--run", "1", "--out", "o"])).not.toThrow();
    expect(() => parseArgs(["--shards", "13", "--run", "1", "--out", "o"])).toThrow("--shards");
    expect(() => parseArgs(["--shards", "6", "--run", "7", "--out", "o"])).toThrow("--run");
    expect(() => parseArgs(["--shards", "6", "--run", "2,2", "--out", "o"])).toThrow("--run");
    expect(() => parseArgs(["--merge"])).toThrow("--merge");
    expect(parseArgs(["--merge", "a", "b"])).toEqual({ merge: ["a", "b"] });
  });

  it("passes a partial run with no files, and leaves the file checks to --merge", () => {
    expect(verdict([shard(3, 0, 0)], { partial: true }).ok).toBe(true);
    expect(verdict([shard(3, 1, 2)], { partial: true }).ok).toBe(false);
  });

  it("merges every job's shards into one verdict", () => {
    const job = (shards, extra = {}) => ({ total: 4, changed: "abc", changedTestFiles: [], shards, ...extra });
    expect(mergeSummaries([job([shard(1, 0, 2), shard(2, 0, 1)]), job([shard(3, 0, 0), shard(4, 0, 4)])]))
      .toMatchObject({ ok: true, total: 4 });
    expect(mergeSummaries([job([shard(1, 0, 2), shard(2, 0, 1)])])).toMatchObject({
      ok: false,
      reason: "no result for shard 3, 4",
    });
    expect(mergeSummaries([job([shard(1, 0, 2), shard(2, 1, 1)]), job([shard(3, 0, 0), shard(4, 0, 4)])]).ok)
      .toBe(false);
    const changedTest = { changedTestFiles: ["apps/server/src/a.test.ts"] };
    expect(
      mergeSummaries([job([shard(1, 0, 0), shard(2, 0, 0)], changedTest), job([shard(3, 0, 0), shard(4, 0, 0)], changedTest)]),
    ).toMatchObject({ ok: false, reason: "no shard ran a changed server test file" });
  });
});
