// Times how long a file event takes to reach fs.watch right after a watch starts, the pattern
// the server's file-watching tests rely on. Prints one summary line and always exits 0: it is a
// diagnostic for the release preflight, so a slow host shows in the log before a test times out.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { performance } from "node:perf_hooks";

const ROUNDS = Number(process.env.FS_WATCH_PROBE_ROUNDS ?? 5);
const TIMEOUT_MS = 3000;
const SLOW_MS = 1000;

function removeQuietly(dir) {
  try {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp folder is not worth failing a diagnostic over.
  }
}

function probeOnce() {
  let dir;
  try {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fs-watch-probe-"));
  } catch (error) {
    return Promise.resolve({ ms: null, error: error.code ?? String(error) });
  }
  return new Promise((resolve) => {
    let wroteAt = 0;
    let done = false;
    let watcher;
    let writeTimer;
    let timeoutTimer;
    const finish = (ms, error) => {
      if (done) return;
      done = true;
      clearTimeout(writeTimer);
      clearTimeout(timeoutTimer);
      try {
        watcher?.close();
      } catch {
        // Closing a broken watcher can throw; the folder still goes.
      }
      removeQuietly(dir);
      resolve({ ms, error });
    };
    try {
      watcher = NodeFS.watch(dir, (_event, name) => {
        if (wroteAt && name === "probe.txt") finish(Math.round(performance.now() - wroteAt));
      });
      watcher.on("error", (error) => finish(null, error.code ?? String(error)));
    } catch (error) {
      finish(null, error.code ?? String(error));
      return;
    }
    writeTimer = setTimeout(() => {
      try {
        NodeFS.writeFileSync(NodePath.join(dir, "probe.txt"), "probe");
        wroteAt = performance.now();
      } catch (error) {
        finish(null, error.code ?? String(error));
      }
    }, 100);
    timeoutTimer = setTimeout(() => finish(null), 100 + TIMEOUT_MS);
  });
}

const results = [];
for (let i = 0; i < ROUNDS; i++) results.push(await probeOnce());
const seen = results.filter((r) => r.ms !== null).map((r) => r.ms);
const max = seen.length ? Math.max(...seen) : null;
const shown = results
  .map((r) => (r.ms !== null ? `${r.ms}ms` : r.error ? `error:${r.error}` : "lost"))
  .join(" ");
console.log(`fs-watch: ${seen.length}/${ROUNDS} events within ${TIMEOUT_MS} ms (${shown})`);
if (seen.length < ROUNDS || (max !== null && max > SLOW_MS)) {
  console.log(
    "WARNING: file events arrive late or not at all; file-watching server tests will time out. " +
      "Check fseventsd on this Mac (a restart cleared this before).",
  );
}
