// @effect-diagnostics nodeBuiltinImport:off -- Real processes and POSIX locks: the failure lives in the kernel.
// @effect-diagnostics globalTimers:off -- Plain async waits between real child processes.
/**
 * The M4 crash of October 16 2026, reproduced with real processes. A holder
 * keeps a WAL database open and reads through its `-shm` index, like the
 * service; another process then opens it. Once the holder has closed a plain
 * descriptor for `-shm` (which drops its POSIX locks on it), a normal
 * read-only open rebuilds `-shm` under the holder and kills it with SIGBUS.
 * The safe reader cannot, and the guard keeps the descriptor from being
 * opened in the first place.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";

const GUARD_URL = new URL("./liveDatabaseGuard.ts", import.meta.url).href;
const SNAPSHOT_URL = new URL("./liveDatabaseSnapshot.ts", import.meta.url).href;
const ROWS = 3000;

const HOLDER = `
import * as NodeFS from "node:fs";
import { DatabaseSync } from "node:sqlite";
const [dbPath, mode] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, v BLOB); CREATE INDEX t_k ON t(k);");
const insert = db.prepare("INSERT INTO t(k, v) VALUES (?, randomblob(200))");
db.exec("BEGIN");
for (let i = 0; i < ${ROWS}; i++) insert.run("k" + (i % 97));
db.exec("COMMIT");
let touched = "kept";
if (mode === "guarded") {
  const guard = await import(${JSON.stringify(GUARD_URL)});
  guard.installLiveDatabaseGuard();
  guard.registerLiveDatabase(dbPath);
}
if (mode !== "intact") {
  try {
    NodeFS.closeSync(NodeFS.openSync(dbPath + "-shm", "r"));
    touched = "dropped";
  } catch (error) {
    touched = "refused " + error.code;
  }
}
const select = db.prepare("SELECT count(*) AS n FROM t WHERE k = ?");
process.stdout.write(touched + "\\n");
let n = 0;
const loop = () => {
  for (let i = 0; i < 20; i++) select.get("k" + ((n + i) % 97));
  n++;
  setImmediate(loop);
};
loop();
`;

const PLAIN_READER = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
console.log(db.prepare("SELECT count(*) AS n FROM t").get().n);
db.close();
`;

const SAFE_READER = `
const { openLiveDatabaseReadOnly } = await import(${JSON.stringify(SNAPSHOT_URL)});
const db = openLiveDatabaseReadOnly(process.argv[1]);
console.log(db.prepare("SELECT count(*) AS n FROM t").get().n);
db.close();
`;

const node = (code: string, args: ReadonlyArray<string>) => [
  "--no-warnings",
  "--input-type=module",
  "--eval",
  code,
  ...args,
];

interface Outcome {
  readonly touched: string;
  readonly reads: ReadonlyArray<string>;
  readonly holderSignal: NodeJS.Signals | null;
  readonly shmInodeKept: boolean;
}

async function run(mode: "intact" | "dropped" | "guarded", reader: string): Promise<Outcome> {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-locks-"));
  const dbPath = NodePath.join(directory, "statev2.sqlite");
  const holder = NodeChildProcess.spawn(process.execPath, node(HOLDER, [dbPath, mode]), {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    holder.once("exit", (_code, signal) => resolve(signal)),
  );
  try {
    const touched = await new Promise<string>((resolve, reject) => {
      const lines = NodeReadline.createInterface({ input: holder.stdout });
      lines.once("line", (line) => {
        lines.close();
        resolve(line);
      });
      holder.once("exit", () => reject(new Error("The holder exited before it was ready.")));
    });
    const inode = NodeFS.statSync(`${dbPath}-shm`).ino;
    const reads: Array<string> = [];
    for (
      let attempt = 0;
      attempt < 3 && holder.exitCode === null && holder.signalCode === null;
      attempt++
    ) {
      const result = NodeChildProcess.spawnSync(process.execPath, node(reader, [dbPath]), {
        encoding: "utf8",
      });
      reads.push(result.status === 0 ? result.stdout.trim() : `failed: ${result.stderr.trim()}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const shmInodeKept = NodeFS.statSync(`${dbPath}-shm`).ino === inode;
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGTERM");
    const signal = await exited;
    return { touched, reads, holderSignal: signal === "SIGTERM" ? null : signal, shmInodeKept };
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

const posix = HostProcessPlatform.defaultValue() !== "win32";

describe.runIf(posix)("a reader of a database another process holds", () => {
  it("is harmless while the holder keeps its locks", async () => {
    const outcome = await run("intact", PLAIN_READER);
    assert.equal(outcome.touched, "kept");
    assert.isNull(outcome.holderSignal);
    assert.deepEqual(outcome.reads, [String(ROWS), String(ROWS), String(ROWS)]);
  });

  // The page size decides where the truncated index faults; on macOS, where
  // the incident happened, the first read past 16 KiB always does.
  it.runIf(HostProcessPlatform.defaultValue() === "darwin")(
    "crashes the holder with SIGBUS once the holder closed a descriptor for -shm",
    async () => {
      const outcome = await run("dropped", PLAIN_READER);
      assert.equal(outcome.touched, "dropped");
      assert.equal(outcome.holderSignal, "SIGBUS");
    },
  );

  it("cannot reset -shm through openLiveDatabaseReadOnly, even after the holder lost its locks", async () => {
    const outcome = await run("dropped", SAFE_READER);
    assert.equal(outcome.touched, "dropped");
    assert.isNull(outcome.holderSignal);
    assert.isTrue(outcome.shmInodeKept);
    assert.deepEqual(outcome.reads, [String(ROWS), String(ROWS), String(ROWS)]);
  });

  it("keeps its locks when the guard refuses the descriptor, so even a plain reader is harmless", async () => {
    const outcome = await run("guarded", PLAIN_READER);
    assert.equal(outcome.touched, "refused EACCES");
    assert.isNull(outcome.holderSignal);
    assert.deepEqual(outcome.reads, [String(ROWS), String(ROWS), String(ROWS)]);
  });
});
