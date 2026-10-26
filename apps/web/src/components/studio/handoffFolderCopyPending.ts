import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import type {
  FolderCopyFileClass,
  FolderCopyMode,
  FolderCopySourceStatus,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import { formatBytes } from "../../studio/folderCopy";

/**
 * What "Replace all" leads to: "copy" when it answers everything still open, "copy-kept"
 * when some items keep the destination's version, "ask" when something still needs a choice.
 */
export type ReplaceAllOutcome = "copy" | "copy-kept" | "ask";

const REPLACE_ALL_OUTCOMES: ReadonlySet<unknown> = new Set(["copy", "copy-kept", "ask"]);

/** Browser-side pointer and helpers for a folder copy the dialog can leave and resume. */
export interface PendingCopy {
  readonly operationId: string;
  readonly environmentId: string;
  readonly mode: FolderCopyMode;
  readonly targetFolder: string;
  readonly projectId: string | null;
  readonly copyRoot?: string;
  readonly projectRelativePath?: string;
  /** What to copy, kept so a reopened dialog shows the same choice. */
  readonly selection?: ReadonlyArray<FolderCopyFileClass>;
  /**
   * One-click copy: measuring, comparing and an approval that replaces nothing run
   * straight through. Absent for copies that stop to choose what to copy.
   */
  readonly auto?: boolean;
  /** How the destination gets the files; "clone" answers cloneable rows automatically. */
  readonly method?: "copy" | "clone";
  /** The clone method's automatic choice was sent; a reopened preview keeps the person's edits. */
  readonly cloneDecided?: boolean;
  /**
   * The person clicked Replace all: once the re-compared plan has no open choice and the
   * destination has room, it is approved, even if the dialog closed meanwhile.
   */
  readonly replaceAll?: boolean;
  /** What that click led to, so a reopened re-compare says the same as the click did. */
  readonly replaceAllOutcome?: ReplaceAllOutcome;
  /**
   * The person chose Move anyway on a held move: transferring coordinator context, a retry
   * of that step and a reopened dialog go ahead despite the differences.
   */
  readonly moveAnyway?: boolean;
  /**
   * The person cancelled while the source was measuring, and the source has not confirmed
   * dropping it. A reopened dialog only tells the source again; it never resumes the copy.
   */
  readonly cancelled?: boolean;
}

export const CANCELLED_WHILE_MEASURING = "The copy was cancelled while measuring.";

/** A copy cancelled while measuring: nothing about it may run on by itself any more. */
export const cancelledPointer = (saved: PendingCopy): PendingCopy => {
  const { auto: _auto, replaceAll: _all, replaceAllOutcome: _outcome, ...rest } = saved;
  return { ...rest, cancelled: true };
};

export const folderCopyStorageKey = (environmentId: string, projectId: string) =>
  `specwithcode:folder-copy:${environmentId}:${projectId}`;

const COPYABLE_CLASSES: Readonly<Record<Exclude<FolderCopyFileClass, "secret">, true>> = {
  repository: true,
  tracked: true,
  untracked: true,
  ignoredData: true,
  rebuildable: true,
};

export function readPendingCopy(key: string): PendingCopy | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PendingCopy | null;
    if (!value || typeof value.operationId !== "string" || typeof value.environmentId !== "string")
      return null;
    const {
      selection,
      auto,
      method,
      cloneDecided,
      replaceAll,
      replaceAllOutcome,
      moveAnyway,
      cancelled,
      ...fields
    } = value;
    const rest: PendingCopy = {
      ...fields,
      ...(auto === true ? { auto } : {}),
      ...(method === "copy" || method === "clone" ? { method } : {}),
      ...(cloneDecided === true ? { cloneDecided } : {}),
      ...(replaceAll === true ? { replaceAll } : {}),
      ...(replaceAll === true && REPLACE_ALL_OUTCOMES.has(replaceAllOutcome)
        ? { replaceAllOutcome }
        : {}),
      ...(moveAnyway === true ? { moveAnyway } : {}),
      ...(cancelled === true ? { cancelled } : {}),
    };
    // Secret-like files are never part of the class selection.
    const kept: unknown[] = Array.isArray(selection)
      ? selection.filter((entry) => entry !== "secret")
      : [];
    const copyable = (entry: unknown): entry is FolderCopyFileClass =>
      typeof entry === "string" && Object.hasOwn(COPYABLE_CLASSES, entry);
    return kept.length > 0 && kept.every(copyable) ? { ...rest, selection: kept } : rest;
  } catch {
    return null;
  }
}

export const isFolderCopyNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { _tag?: unknown })._tag === "FolderCopyError" &&
  (cause as { code?: unknown }).code === "not_found";

export const abortError = () => new DOMException("closed", "AbortError");
export const isAbortError = (cause: unknown) =>
  cause instanceof DOMException && cause.name === "AbortError";

export const sleep = (ms: number, ...signals: ReadonlyArray<AbortSignal>) =>
  new Promise<void>((resolve, reject) => {
    if (signals.some((signal) => signal.aborted)) {
      reject(abortError());
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      for (const signal of signals) signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    for (const signal of signals) signal.addEventListener("abort", stop, { once: true });
  });

/** "41,203 files, 1.2 GB" measured so far. */
export const measuredSoFar = (progress: { readonly files: number; readonly bytes: number }) =>
  `${progress.files.toLocaleString()} ${progress.files === 1 ? "file" : "files"}, ${formatBytes(progress.bytes)}`;

/** Destination states after an approval landed. */
export const APPROVED: ReadonlySet<FolderCopyStatus["state"]> = new Set([
  "approved",
  "transferring",
  "verifying",
  "applying",
  "applied",
]);
export const SOURCE_FINISHED: ReadonlySet<FolderCopySourceStatus["state"]> = new Set([
  "failed",
  "committed",
  "released",
  "cancelled",
]);

/**
 * Why the source did not drop an operation it was told to drop, or null when it did. A
 * source that no longer knows the operation has dropped it.
 */
export function sourceNotDropped<A, E>(
  result: AtomCommandResult<A, E>,
  sourceLabel: string,
): Error | null {
  if (result._tag === "Success") return null;
  const cause = squashAtomCommandFailure(result);
  if (isFolderCopyNotFound(cause)) return null;
  const said = (cause as { message?: unknown } | null)?.message;
  const message = typeof said === "string" && said ? said : "It did not answer.";
  return new Error(
    `${sourceLabel} has not dropped the copy yet: ${message} Reopen this window to tell it again, or cancel the copy on ${sourceLabel}.`,
  );
}

/** The source kept the copy, and releasing it failed too: say both, without repeating. */
export function withReleaseFailure(notDropped: Error, releaseCause: unknown): Error {
  const said = (releaseCause as { message?: unknown } | null)?.message;
  const message = typeof said === "string" && said ? said : "It did not answer.";
  return notDropped.message.includes(message)
    ? notDropped
    : new Error(`${notDropped.message} Releasing it failed too: ${message}`);
}

export function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
