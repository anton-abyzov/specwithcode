import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const PROBE = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fs-watch-probe.mjs",
);

describe("fs-watch-probe", () => {
  it("prints one summary line per run, exits 0 and does not linger", () => {
    const started = Date.now();
    const out = NodeChildProcess.execFileSync(process.execPath, [PROBE], {
      env: { ...process.env, FS_WATCH_PROBE_ROUNDS: "2" },
      encoding: "utf8",
      timeout: 20_000,
    });
    const round = String.raw`(?:\d+ms|lost|error:\S+)`;
    expect(out).toMatch(
      new RegExp(String.raw`^fs-watch: [0-2]/2 events within 3000 ms \(${round} ${round}\)$`, "m"),
    );
    // Two rounds that see their events finish well under the 3 s per-round timeout.
    if (/fs-watch: 2\/2/.test(out) && !/WARNING:/.test(out)) {
      expect(Date.now() - started).toBeLessThan(2500);
    }
  });
});
