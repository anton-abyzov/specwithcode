#!/usr/bin/env node
// Two-sided folder copy check on loopback, with throwaway Git fixtures only.
// A source and a destination, each with its own state folder, talk over HTTP:
// an empty-folder copy through a destination restart and two network drops,
// a reconcile into an out-of-sync folder (diverged repository, both-dirty file,
// linked worktree, links, ignored data, a secret file) followed by Undo, and
// the refusals before Apply (cancel, no disk space, an older source).
// Never touches a real project, the live app stores or another machine.
// Usage: node scripts/studio-folder-transfer/verify.mjs /absolute/report/dir
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [reportDir] = process.argv.slice(2);
if (!reportDir || !isAbsolute(reportDir))
  throw new Error("Expected an absolute report folder, for example /tmp/folder-copy-report.");
mkdirSync(reportDir, { recursive: true });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const test = "apps/server/src/fleet/folderTransfer/twoServer.verify.test.ts";
const run = spawnSync(
  process.execPath,
  [join(repo, "node_modules/vite-plus/bin/vp"), "test", "run", test],
  {
    cwd: repo,
    env: { ...process.env, CI: "1", FOLDER_TRANSFER_REPORT_DIR: reportDir },
    encoding: "utf8",
  },
);
const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
writeFileSync(join(reportDir, "folder-transfer-verify.log"), log);
let evidence = {};
try {
  evidence = JSON.parse(readFileSync(join(reportDir, "folder-transfer-verify.json"), "utf8"));
} catch {
  // The test did not get far enough to write evidence; the log says why.
}
const summary = {
  passed: run.status === 0,
  scenarios: Object.keys(evidence),
  report: join(reportDir, "folder-transfer-verify.json"),
  log: join(reportDir, "folder-transfer-verify.log"),
};
writeFileSync(join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(run.status === 0 ? 0 : 1);
