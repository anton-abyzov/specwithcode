#!/usr/bin/env node
// Handoff mode (0967) two-machine verification. Runs the source machine's moves
// against a destination machine's receiver over real Git repositories (a source
// checkout and a destination clone), then writes a receipt with every scenario.
//
// Both machines run in one process: a paired machine is reachable only at a
// private Tailscale HTTPS origin (*.ts.net), which two servers on 127.0.0.1
// cannot present, so the peer HTTP hop is a stub and everything behind it
// (bundles, preflight, takeover, leases, heartbeats, the side-effect journal)
// is the shipped code.
//
// Usage: node scripts/verify-handoff-mode/run.mjs [output-dir]
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), `handoff-mode-proof-${randomUUID()}`));
mkdirSync(output, { recursive: true, mode: 0o700 });
const report = join(output, "vitest.json");
const env = { ...process.env };
delete env.GIT_CONFIG_PARAMETERS;
delete env.GIT_CONFIG_COUNT;

const run = spawnSync(
  "npx",
  [
    "vp",
    "test",
    "run",
    "--config",
    "../../vite.config.ts",
    "--dir",
    ".",
    "src/handoff",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${report}`,
  ],
  { cwd: join(root, "apps/server"), env, stdio: "inherit" },
);

const results = JSON.parse(readFileSync(report, "utf8"));
const scenarios = results.testResults.flatMap((file) =>
  file.assertionResults.map((test) => ({
    file: file.name.slice(root.length + 1),
    name: test.fullName,
    status: test.status,
  })),
);
const receipt = {
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  evidenceKind: "two-machines-one-process-real-git",
  covers: [
    "checkpoint on hidden ref, HEAD and index untouched",
    "replication of each checkpoint to linked project machines",
    "explicit handoff with resume from a usage limit",
    "running turn interrupted before takeover",
    "preflight failure leaves the source untouched",
    "lost takeover answer stays paused; heartbeat fences",
    "lost takeover request re-sent at the same epoch, launched once",
    "sleep handoff of running threads with resume",
    "fenced wake keeps later changes on swc/from-<machine>/<branch>",
    "stopped turn stays resumable when the final checkpoint fails",
    "stale epoch refused",
    "silent-loss continue here only after a stale lease",
    "stale source rejoins and is fenced",
    "partition self-fence and recovery",
    "side effects journaled and reused, never repeated",
  ],
  passed: results.numPassedTests,
  failed: results.numFailedTests,
  scenarios,
  success: run.status === 0 && results.numFailedTests === 0,
};
writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`receipt: ${join(output, "receipt.json")}`);
process.exit(receipt.success ? 0 : 1);
