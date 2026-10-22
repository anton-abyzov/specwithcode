#!/usr/bin/env node
/**
 * Runs verify-live.mjs several times in a row to catch flakes, each run in its
 * own private home. Writes loop.json with every run's result.
 * Usage: node apps/web/tests/design-workspace/live/loop-live.mjs <count> <evidence-dir>
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { spawnSync } = NodeChildProcess;
const { mkdirSync, readFileSync, writeFileSync, existsSync } = NodeFS;
const { dirname, join, resolve } = NodePath;

const here = dirname(NodeURL.fileURLToPath(import.meta.url));
const count = Number(process.argv[2] ?? 20);
const out = resolve(process.argv[3] ?? join(here, "evidence-loop"));
mkdirSync(out, { recursive: true });
const runs = [];
for (let index = 1; index <= count; index += 1) {
  const dir = join(out, `run-${String(index).padStart(2, "0")}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(here, "verify-live.mjs"), dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(`${dir}.log`, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  const receiptFile = join(dir, "receipt.json");
  const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, "utf8")) : null;
  const failed = receipt?.checks.filter((check) => !check.ok).map((check) => check.name) ?? [];
  const fromCode = receipt?.checks.find((check) => check.name.startsWith("design from code"));
  runs.push({
    run: index,
    passed: result.status === 0,
    ms: Date.now() - started,
    checks: receipt
      ? `${receipt.checks.filter((check) => check.ok).length}/${receipt.checks.length}`
      : null,
    failed,
    slowConnect: fromCode?.detail?.slowConnect ?? null,
  });
  console.log(`run ${index}: ${result.status === 0 ? "pass" : `FAIL ${failed.join(", ")}`}`);
}
const passed = runs.filter((run) => run.passed).length;
writeFileSync(join(out, "loop.json"), JSON.stringify({ count, passed, runs }, null, 2));
console.log(`${passed}/${count} runs passed; ${join(out, "loop.json")}`);
process.exit(passed === count ? 0 : 1);
