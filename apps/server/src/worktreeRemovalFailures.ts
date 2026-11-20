// @effect-diagnostics nodeBuiltinImport:off - runs lsof and reads one small state file directly; no Effect service covers lsof.
/**
 * What the chat worktree sweep remembers about a folder Git could not remove.
 * Git forgets a worktree before it deletes its files, so a removal that stops
 * halfway ("Directory not empty", commonly Finder writing `.DS_Store`) leaves a
 * folder no later sweep can explain. The sweep deletes nothing more in such a
 * folder: it records what Git did and which processes hold files open in it,
 * and Settings > Storage shows that until the folder is gone.
 *
 * The record lives in `<stateDir>/worktree-removal-failures.json`. A file that
 * cannot be read is an empty record: the sweep then decides from the folder
 * alone, which keeps it too.
 *
 * @module worktreeRemovalFailures
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const WORKTREE_REMOVAL_FAILURES_FILE = "worktree-removal-failures.json";

/** A folder whose registration survived the failure is tried again after this long. */
export const REMOVAL_RETRY_AFTER_MS = 6 * 3_600_000;
/** Failures remembered; past it the oldest are forgotten. */
const FAILURES_KEPT = 500;

const LSOF_TIMEOUT_MS = 10_000;
const LSOF_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const HOLDERS_NAMED = 5;
const LEFT_NAMED = 3;

export interface WorktreeRemovalFailure {
  /** The chat folder, as its chats record it. */
  readonly folder: string;
  /** The member Git could not remove: "the folder" or its path in the folder. */
  readonly member: string;
  /** ISO time of the attempt. */
  readonly at: string;
  /** What Git did, in one sentence without a full stop. */
  readonly what: string;
  /** Processes with files open in it, such as "Finder (pid 412)"; null when not known. */
  readonly holders: ReadonlyArray<string> | null;
  /** Members Git removed before this one. */
  readonly removedBefore: number;
}

/** `p<pid>` and `c<command>` lines of `lsof -F pc` output, as "command (pid n)". */
export function parseLsofHolders(stdout: string): ReadonlyArray<string> {
  const holders: Array<string> = [];
  let pid: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = /^\d+$/.test(line.slice(1)) ? line.slice(1) : null;
    else if (line.startsWith("c") && pid !== null) {
      const command = line.slice(1).trim();
      const holder = `${command === "" ? "a process" : command} (pid ${pid})`;
      if (!holders.includes(holder)) holders.push(holder);
      pid = null;
    }
  }
  return holders;
}

/**
 * Processes holding a file open in `folder` (`lsof +D`), or null when that
 * cannot be told: Windows, no lsof, a timeout, a folder too large to walk in
 * time. lsof exits 1 when it finds nothing, which is an answer.
 */
export function openFileHolders(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ReadonlyArray<string> | null> {
  if (platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-n", "-P", "-w", "-F", "pc", "+D", folder],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout) => {
        if (error === null) return resolve(parseLsofHolders(stdout));
        // Exit 1 is lsof's "nothing found", or "found some, could not read others".
        const failure = error as { readonly killed?: boolean; readonly code?: unknown };
        if (failure.killed !== true && failure.code === 1)
          return resolve(parseLsofHolders(stdout));
        resolve(null);
      },
    );
  });
}

const OPEN_FILES_TIMEOUT_MS = 30_000;
const OPEN_FILES_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Processes in `lsof -F pcn` output with a file, folder or cwd at or under `folder`. */
export function parseLsofHoldersUnder(stdout: string, folder: string): ReadonlyArray<string> {
  const holders: Array<string> = [];
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  let pid: string | null = null;
  let command = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = /^\d+$/.test(line.slice(1)) ? line.slice(1) : null;
      command = "";
    } else if (line.startsWith("c")) command = line.slice(1).trim();
    else if (line.startsWith("n") && pid !== null) {
      const name = line.slice(1);
      if (name !== folder && !name.startsWith(prefix)) continue;
      const holder = `${command === "" ? "a process" : command} (pid ${pid})`;
      if (!holders.includes(holder)) holders.push(holder);
    }
  }
  return holders;
}

/**
 * Processes with anything open at or under `folder`, from one listing of
 * every open file on the machine (`lsof` without `+D`, so its time does not
 * grow with the folder); null when that cannot be told. Windows refuses to
 * delete a file that is open, so there it answers none.
 */
export function openFilesUnder(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ReadonlyArray<string> | null> {
  if (platform === "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-n", "-P", "-F", "pcn"],
      { timeout: OPEN_FILES_TIMEOUT_MS, maxBuffer: OPEN_FILES_MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        // A failed run, or one that warned it could not read something, may
        // have missed a holder: not known.
        if (error !== null || stderr.trim() !== "") return resolve(null);
        resolve(parseLsofHoldersUnder(stdout, folder));
      },
    );
  });
}

/** Names of what is left in a folder, without reading into it; null when unreadable. */
export function leftBehind(folder: string): ReadonlyArray<string> | null {
  try {
    return NodeFS.readdirSync(folder).toSorted();
  } catch {
    return null;
  }
}

/** What Git did, from what the folder looks like afterwards. */
export function describeRemovalFailure(input: {
  /** The folder's registration still checks out. */
  readonly stillRegistered: boolean;
  readonly left: ReadonlyArray<string> | null;
}): string {
  if (input.stillRegistered)
    return "Git refused and changed nothing (it found changed or new files, or a lock)";
  if (input.left === null) return "Git forgot the worktree and its files could not be listed";
  if (input.left.length === 0) return "Git forgot the worktree and left its empty folder";
  const named = input.left.slice(0, LEFT_NAMED).join(", ");
  const more = input.left.length > LEFT_NAMED ? ` and ${input.left.length - LEFT_NAMED} more` : "";
  return `Git forgot the worktree but could not delete every file (Directory not empty): ${named}${more}`;
}

/** The sentence Settings > Storage shows for a failure. Never a file's contents. */
export function removalFailureDetail(failure: WorktreeRemovalFailure): string {
  const holders =
    failure.holders === null
      ? "Which process holds it open is not known."
      : failure.holders.length === 0
        ? "No process holds a file open in it."
        : `Open in ${failure.holders.slice(0, HOLDERS_NAMED).join(", ")}${
            failure.holders.length > HOLDERS_NAMED
              ? ` and ${failure.holders.length - HOLDERS_NAMED} more`
              : ""
          }.`;
  const before =
    failure.removedBefore === 0
      ? ""
      : ` ${failure.removedBefore} of its worktrees were removed before it.`;
  return `Git could not remove it (${failure.member}): ${failure.what}. ${holders}${before} It was left as it is; nothing was deleted by force.`;
}

/**
 * Whether a recorded failure still stands for its folder: always while the
 * registration is gone (Git cannot remove it again), and for a while after a
 * refusal that changed nothing. An unreadable time stands.
 */
export function removalFailureStands(
  failure: WorktreeRemovalFailure,
  input: { readonly registrationBroken: boolean; readonly now: number },
): boolean {
  if (input.registrationBroken) return true;
  const at = Date.parse(failure.at);
  if (!Number.isFinite(at) || at > input.now) return true;
  return input.now - at < REMOVAL_RETRY_AFTER_MS;
}

const isFailure = (value: unknown): value is WorktreeRemovalFailure => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["folder"] === "string" &&
    typeof entry["member"] === "string" &&
    typeof entry["at"] === "string" &&
    typeof entry["what"] === "string" &&
    typeof entry["removedBefore"] === "number" &&
    (entry["holders"] === null ||
      (Array.isArray(entry["holders"]) &&
        entry["holders"].every((holder) => typeof holder === "string")))
  );
};

/** The failures on record, by folder key (its real path). */
export class WorktreeRemovalFailures {
  private readonly byKey = new Map<string, WorktreeRemovalFailure>();
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = NodePath.join(stateDir, WORKTREE_REMOVAL_FAILURES_FILE);
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(this.file, "utf8"));
      const entries =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { failures?: unknown }).failures
          : null;
      if (typeof entries === "object" && entries !== null)
        for (const [key, value] of Object.entries(entries))
          if (isFailure(value)) this.byKey.set(key, value);
    } catch {
      // No file yet, or one that cannot be read: nothing on record.
    }
  }

  get(key: string): WorktreeRemovalFailure | undefined {
    return this.byKey.get(key);
  }

  record(key: string, failure: WorktreeRemovalFailure): void {
    this.byKey.delete(key);
    this.byKey.set(key, failure);
    while (this.byKey.size > FAILURES_KEPT) {
      const oldest = this.byKey.keys().next();
      if (oldest.done === true) break;
      this.byKey.delete(oldest.value);
    }
    this.save();
  }

  /** Forgets a folder that is gone or was removed cleanly. */
  clear(key: string): void {
    if (this.byKey.delete(key)) this.save();
  }

  private save(): void {
    try {
      NodeFS.mkdirSync(NodePath.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      NodeFS.writeFileSync(
        temporary,
        `${JSON.stringify({ schemaVersion: 1, failures: Object.fromEntries(this.byKey) })}\n`,
        { mode: 0o600 },
      );
      NodeFS.renameSync(temporary, this.file);
    } catch {
      // Kept in memory for this run; the folder stays whatever the file says.
    }
  }
}
