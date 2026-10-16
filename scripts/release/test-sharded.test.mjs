import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { parseArgs, readShardReport, verdict } from "./test-sharded.mjs";

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
});

describe("test-sharded reports", () => {
  it("counts files and lists failed ones relative to the server", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-sharded-"));
    try {
      const file = join(dir, "server-1.json");
      writeFileSync(
        file,
        JSON.stringify({
          numTotalTests: 5,
          numFailedTests: 1,
          testResults: [
            { name: "/repo/apps/server/src/a.test.ts", status: "passed" },
            { name: "/repo/apps/server/src/b/c.test.ts", status: "failed" },
          ],
        }),
      );
      expect(readShardReport(file, "/repo/apps/server")).toEqual({
        files: 2,
        failedFiles: ["src/b/c.test.ts"],
        tests: 5,
        failedTests: 1,
      });
      expect(readShardReport(join(dir, "missing.json"))).toEqual({
        files: 0,
        failedFiles: [],
        tests: 0,
        failedTests: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
