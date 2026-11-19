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
 * the locks has ended. A time limit applies to `prepare` only, before anything
 * else is written; after it, nothing here ever stops the process.
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

export type RefTransactionFactory = (cwd: string, message: string) => RefTransaction;

const PREPARE_MS = 30_000;

/** A real transaction in `cwd`, with the same safe settings as every other Git call of Sync. */
export const refTransaction: RefTransactionFactory = (cwd, message) => {
  const child = NodeChildProcess.spawn(
    "git",
    // Not `--no-deref`: an update of HEAD goes through the branch HEAD names, read by Git
    // under HEAD's lock.
    gitArguments(cwd, ["update-ref", "-m", message, "--stdin"]),
    { cwd, env: gitEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
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
          return resolve(reason.length > 0 ? { ok: false, reason } : "lost");
        }
        waiters.push(check);
      };
      if (limitMs !== undefined)
        timer = setTimeout(() => {
          // Only before anything is written: the process is stopped, which releases its locks.
          child.kill("SIGTERM");
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
      const committed = await answer("commit");
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
