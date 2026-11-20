// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - one held-open Git process, like folderTransfer/git.ts.
/**
 * One Git ref transaction held open across other work (1390): `update-ref
 * --stdin` with `start`, the update, then `prepare`. Once prepared, Git holds
 * the locks of every ref the update touches, and of HEAD when the update goes
 * through it, until `commit` or `abort`. No other Git program can write those
 * refs meanwhile. A transaction whose process loses its input (the server
 * stopped) is aborted by Git itself.
 *
 * One owner: the caller sends `commit` or `abort` once whatever it ran under
 * the locks has ended. `prepare` has a time limit, and so does the answer to
 * `commit`: one that never comes stops the process (Git removes its own locks
 * on the way out; nothing here touches a lock file) and the commit is lost,
 * neither confirmed nor refused.
 */
import * as NodeChildProcess from "node:child_process";

import { gitArguments, gitEnvironment } from "./folderTransfer/git.ts";

export type TransactionAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface RefTransaction {
  /** Starts the transaction with `lines` (`update …`, `verify …`) and prepares it. */
  readonly prepare: (lines: ReadonlyArray<string>) => Promise<TransactionAnswer>;
  /** Commits it. Rejects when the answer was lost: the refs may or may not have moved. */
  readonly commit: () => Promise<TransactionAnswer>;
  /** Aborts it, or closes a transaction that never prepared. Never rejects. */
  readonly abort: () => Promise<void>;
}

export interface RefTransactionOptions {
  /** On top of the runner's environment: the move passes its Git folder and checkout. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long the answer to `commit` may take; tests shorten it. */
  readonly commitMs?: number;
}

export type RefTransactionFactory = (
  cwd: string,
  message: string,
  options?: RefTransactionOptions,
) => RefTransaction;

const PREPARE_MS = 30_000;
const COMMIT_MS = 60_000;

/** A real transaction in `cwd`, with the same safe settings as every other Git call of Sync. */
export const refTransaction: RefTransactionFactory = (cwd, message, options = {}) => {
  const child = NodeChildProcess.spawn(
    "git",
    // Not `--no-deref`: an update of HEAD goes through the branch HEAD names, read by Git
    // under HEAD's lock.
    gitArguments(cwd, ["update-ref", "-m", message, "--stdin"]),
    { cwd, env: gitEnvironment(options.env), stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let exited = false;
  const waiters: Array<() => void> = [];
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    wake();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    wake();
  });
  child.stdin.on("error", () => undefined);
  const ended = new Promise<void>((resolve) => {
    child.on("close", () => {
      exited = true;
      wake();
      resolve();
    });
    child.on("error", (cause) => {
      stderr += cause.message;
      exited = true;
      wake();
      resolve();
    });
  });
  /** Waits for the answer line `word: ok`, or for the process to end without it. */
  const answer = (word: string, limitMs?: number) =>
    new Promise<TransactionAnswer | "lost">((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const check = () => {
        if (stdout.split("\n").includes(`${word}: ok`)) {
          if (timer !== undefined) clearTimeout(timer);
          return resolve({ ok: true });
        }
        if (exited) {
          if (timer !== undefined) clearTimeout(timer);
          const reason = stderr
            .trim()
            .replace(/^(fatal|error):\s*/gmu, "")
            .trim();
          // A process stopped for want of an answer gave none, whatever it printed.
          return resolve(reason.length > 0 && !stopped ? { ok: false, reason } : "lost");
        }
        waiters.push(check);
      };
      if (limitMs !== undefined)
        timer = setTimeout(() => {
          stopped = true;
          // The process is stopped, which releases its locks; what it wrote stays written.
          child.kill("SIGTERM");
          // One that does not stop is killed.
          setTimeout(() => exited || child.kill("SIGKILL"), 5_000).unref();
        }, limitMs);
      check();
    });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      child.stdin.end();
    }
    await ended;
  };
  return {
    prepare: async (lines) => {
      child.stdin.write(`start\n${lines.join("\n")}\nprepare\n`);
      const prepared = await answer("prepare", PREPARE_MS);
      if (prepared === "lost") {
        await close();
        return { ok: false, reason: "Git ended without preparing the move." };
      }
      if (!prepared.ok) await close();
      return prepared;
    },
    commit: async () => {
      child.stdin.write("commit\n");
      const committed = await answer("commit", options.commitMs ?? COMMIT_MS);
      await close();
      if (committed === "lost") throw new Error("Git ended without answering the commit.");
      return committed;
    },
    abort: async () => {
      if (!exited && !closed) child.stdin.write("abort\n");
      await close();
    },
  };
};
