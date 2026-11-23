// Times how long a file event takes to reach fs.watch right after a watch starts, the pattern
// the server's file-watching tests rely on. Prints one summary line and never fails the caller:
// it is a diagnostic for the release preflight, so a slow host shows in the log before a test
// times out on it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROUNDS = Number(process.env.FS_WATCH_PROBE_ROUNDS ?? 5);
const TIMEOUT_MS = 3000;
const SLOW_MS = 1000;

function probeOnce() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-watch-probe-"));
  return new Promise((resolve) => {
    let wroteAt = 0;
    let done = false;
    let watcher;
    const finish = (value) => {
      if (done) return;
      done = true;
      watcher?.close();
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(value);
    };
    try {
      watcher = fs.watch(dir, (_event, name) => {
        if (wroteAt && name === "probe.txt") finish(Date.now() - wroteAt);
      });
    } catch {
      finish(null);
      return;
    }
    setTimeout(() => {
      if (done) return;
      fs.writeFileSync(path.join(dir, "probe.txt"), "probe");
      wroteAt = Date.now();
    }, 100);
    setTimeout(() => finish(null), 100 + TIMEOUT_MS);
  });
}

const results = [];
for (let i = 0; i < ROUNDS; i++) results.push(await probeOnce());
const seen = results.filter((ms) => ms !== null);
const max = seen.length ? Math.max(...seen) : null;
const shown = results.map((ms) => (ms === null ? "lost" : `${ms}ms`)).join(" ");
console.log(`fs-watch: ${seen.length}/${ROUNDS} events within ${TIMEOUT_MS} ms (${shown})`);
if (seen.length < ROUNDS || (max !== null && max > SLOW_MS)) {
  console.log(
    "WARNING: file events arrive late or not at all; file-watching server tests will time out. " +
      "Check fseventsd on this Mac (a restart cleared this before).",
  );
}
