import { execFileSync } from "node:child_process";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const PROBE = NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "fs-watch-probe.mjs");

describe("fs-watch-probe", () => {
  it("prints one summary line per run and exits 0", () => {
    const out = execFileSync(process.execPath, [PROBE], {
      env: { ...process.env, FS_WATCH_PROBE_ROUNDS: "2" },
      encoding: "utf8",
      timeout: 20_000,
    });
    const round = String.raw`(?:\d+ms|lost)`;
    expect(out).toMatch(
      new RegExp(String.raw`^fs-watch: [0-2]/2 events within 3000 ms \(${round} ${round}\)$`, "m"),
    );
  });
});
