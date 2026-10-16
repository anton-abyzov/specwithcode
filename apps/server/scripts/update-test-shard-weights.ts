// @effect-diagnostics nodeBuiltinImport:off - a one-off maintenance script with no
// Effect runtime; it only spawns vitest and reads and writes two files.
// Run with: node apps/server/scripts/update-test-shard-weights.ts
// Runs the whole server suite once and records how long each test file takes,
// so CI can split the suite into shards of equal duration. See
// src/testUtils/weightedShardSequencer.ts. Rerun it when a shard in CI runs
// much longer than the others. To record from the shard reports of a sharded
// run instead, use the root scripts/update-test-shard-weights.ts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const serverDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const weightsPath = NodePath.join(serverDir, "src/testUtils/shardWeights.json");
const reportDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-server-test-report-"));
const reportPath = NodePath.join(reportDir, "report.json");

// `node --run` puts the package's own `vp` on PATH, on every platform. Failing
// tests still report their duration, so the exit code is not checked.
NodeChildProcess.spawnSync(
  process.execPath,
  ["--run", "test", "--", "--reporter=json", `--outputFile=${reportPath}`],
  { cwd: serverDir, stdio: "inherit" },
);

// The root script owns the recording rules (span, rounding, threshold, key form), so a full
// run here and the shard reports of a release run record the same way.
const recorded = NodeChildProcess.spawnSync(
  process.execPath,
  [
    NodeURL.fileURLToPath(
      new URL("../../../scripts/update-test-shard-weights.ts", import.meta.url),
    ),
    reportPath,
    "--root",
    serverDir,
    "--out",
    weightsPath,
  ],
  { stdio: "inherit" },
);
NodeFS.rmSync(reportDir, { recursive: true, force: true });
process.exitCode = recorded.status ?? 1;
