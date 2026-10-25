import type { EnvironmentId } from "@specweave-studio/contracts";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";

import type { ShelfFileCheck } from "~/artifactShelf";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";

const CONCURRENCY = 4;
/** A folder that has not answered by then counts as a failed check, not a missing file. */
export const FILE_CHECK_TIMEOUT_MS = 8000;

/** A folder's children by name. */
export interface FolderListing {
  readonly names: ReadonlySet<string>;
  /** False when the host cut the listing short, so an absent name proves nothing. */
  readonly complete: boolean;
}

/** Lists one folder; rejects when the host refuses, fails or the signal aborts. */
export type ListFolder = (folder: string, signal: AbortSignal) => Promise<FolderListing>;

class FolderCheckTimeout extends Error {
  override readonly name = "FolderCheckTimeout";
}

/** An absolute path the host can be asked about: `/…` or `C:\…`. */
export function isCheckablePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function splitPath(path: string): { parent: string; name: string } | null {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index <= 0) return null;
  const parent = path.slice(0, index);
  // `C:` alone is not a folder; its root is `C:\`.
  return {
    parent: /^[A-Za-z]:$/.test(parent) ? `${parent}${path[index]}` : parent,
    name: path.slice(index + 1),
  };
}

function listFolderOnHost(environmentId: EnvironmentId): ListFolder {
  return async (folder, signal) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.listEntries({ environmentId, input: { cwd: folder, directoryPath: "" } }),
      { refresh: true, signal, reportFailure: false, reportDefect: false },
    );
    if (result._tag !== "Success") throw new Error("The folder could not be listed.");
    return {
      names: new Set(result.value.entries.map((entry) => entry.path)),
      complete: !result.value.truncated,
    };
  };
}

/** One listing, given up after `timeoutMs` even when the host never answers. */
function listWithin(
  list: ListFolder,
  folder: string,
  timeoutMs: number,
  run: AbortSignal,
): Promise<FolderListing> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (run.aborted) controller.abort();
  else run.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Settled first, so the race reads as a timeout rather than the abort it causes.
      reject(new FolderCheckTimeout("no answer"));
      controller.abort();
    }, timeoutMs);
  });
  return Promise.race([list(folder, controller.signal), timeout]).finally(() => {
    clearTimeout(timer);
    run.removeEventListener("abort", abort);
  });
}

function failedCheck(cause: unknown): ShelfFileCheck {
  return {
    state: "unreachable",
    reason:
      cause instanceof FolderCheckTimeout
        ? "Check failed: no answer"
        : "Check failed: the folder could not be listed",
  };
}

/**
 * Where each of one folder's files stands. Only a definite absence is
 * missing: the folder listed in full without the file, or its parent listed
 * in full without the folder. A folder that fails or never answers makes its
 * files unreachable; a listing cut short leaves the absent ones unknown.
 */
export async function checkFolder(
  list: ListFolder,
  folder: string,
  files: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<ReadonlyMap<string, ShelfFileCheck>> {
  const checks = new Map<string, ShelfFileCheck>();
  const nameOf = (file: string) => file.slice(folder.length).replace(/^[\\/]/, "");
  let listing: FolderListing;
  try {
    listing = await listWithin(list, folder, options.timeoutMs, options.signal);
  } catch (cause) {
    // A host that did not answer would not answer for the parent either.
    const up =
      cause instanceof FolderCheckTimeout || options.signal.aborted ? null : splitPath(folder);
    const parent = up
      ? await listWithin(list, up.parent, options.timeoutMs, options.signal).catch(() => null)
      : null;
    const gone = parent !== null && parent.complete && up !== null && !parent.names.has(up.name);
    for (const file of files) checks.set(file, gone ? { state: "missing" } : failedCheck(cause));
    return checks;
  }
  for (const file of files) {
    const name = nameOf(file);
    if (listing.names.has(name)) checks.set(file, { state: "present" });
    else if (listing.complete) checks.set(file, { state: "missing" });
    else checks.set(file, { state: "unknown", reason: "Its folder is too large to check" });
  }
  return checks;
}

/**
 * Checks `paths` folder by folder, a few folders at a time, handing each
 * folder's answer over as it lands, so one slow folder holds up only its own
 * files.
 */
export async function checkArtifactPaths(
  paths: ReadonlyArray<string>,
  list: ListFolder,
  options: {
    readonly timeoutMs?: number | undefined;
    readonly signal: AbortSignal;
    readonly onChecked: (checks: ReadonlyMap<string, ShelfFileCheck>) => void;
  },
): Promise<void> {
  const byFolder = new Map<string, string[]>();
  for (const path of paths) {
    const split = isCheckablePath(path) ? splitPath(path) : null;
    if (!split) continue;
    byFolder.set(split.parent, [...(byFolder.get(split.parent) ?? []), path]);
  }
  const queue = [...byFolder];
  const take = () => (options.signal.aborted ? undefined : queue.shift());
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let job = take(); job; job = take()) {
        const checks = await checkFolder(list, job[0], job[1], {
          timeoutMs: options.timeoutMs ?? FILE_CHECK_TIMEOUT_MS,
          signal: options.signal,
        });
        if (!options.signal.aborted) options.onChecked(checks);
      }
    }),
  );
}

interface CheckRun {
  /** The machine these answers are about. */
  readonly machine: string | null;
  readonly checks: ReadonlyMap<string, ShelfFileCheck>;
  /** The paths a check is out for, or null between checks. */
  readonly running: string | null;
}

const NO_RUN: CheckRun = { machine: null, checks: new Map(), running: null };

/**
 * Where each of `paths` stands on the thread's machine, checked once per
 * folder while `enabled`. An offline machine (`offline` says why) is not
 * asked: its files are unreachable. Until a folder answers, its files keep
 * the last answer for this machine, or stay unknown. Answers are kept per
 * machine, so a thread that moved never shows the old machine's.
 */
export function useArtifactFileChecks(input: {
  readonly environmentId: EnvironmentId | null;
  readonly paths: ReadonlyArray<string>;
  readonly enabled: boolean;
  /** Why the machine cannot be asked now ("Mac mini is offline"), or null while it can. */
  readonly offline: string | null;
  /** Stands in for the host in tests. */
  readonly listFolder?: ListFolder | undefined;
}): ReadonlyMap<string, ShelfFileCheck> {
  const { environmentId, enabled, offline, paths } = input;
  const signature = useMemo(
    () => [...new Set(paths.filter(isCheckablePath))].toSorted().join("\n"),
    [paths],
  );
  const [run, setRun] = useState<CheckRun>(NO_RUN);
  const canAsk = offline === null && environmentId !== null && signature.length > 0;
  const listFolder = input.listFolder;
  useEffect(() => {
    if (!enabled || !canAsk || environmentId === null) return;
    const controller = new AbortController();
    // Answers carry over between checks of one machine, never to another.
    setRun((current) => ({
      machine: environmentId,
      checks: current.machine === environmentId ? current.checks : new Map(),
      running: signature,
    }));
    const merge = (checks: ReadonlyMap<string, ShelfFileCheck>) =>
      setRun((current) =>
        current.machine === environmentId
          ? { ...current, checks: new Map([...current.checks, ...checks]) }
          : current,
      );
    const settle = () =>
      setRun((current) =>
        current.machine === environmentId && current.running === signature
          ? { ...current, running: null }
          : current,
      );
    void checkArtifactPaths(signature.split("\n"), listFolder ?? listFolderOnHost(environmentId), {
      signal: controller.signal,
      onChecked: merge,
    }).finally(() => {
      if (!controller.signal.aborted) settle();
    });
    return () => {
      controller.abort();
      settle();
    };
  }, [canAsk, enabled, environmentId, listFolder, signature]);
  return useMemo(() => {
    const checks = new Map<string, ShelfFileCheck>();
    const known = run.machine === environmentId ? run.checks : null;
    const running = enabled && canAsk && (known === null || run.running !== null);
    for (const path of paths) {
      if (offline !== null) {
        checks.set(path, { state: "unreachable", reason: offline });
        continue;
      }
      if (!isCheckablePath(path)) {
        checks.set(path, { state: "unknown", reason: "Not checkable from here" });
        continue;
      }
      const answer = known?.get(path);
      if (answer) checks.set(path, running ? { ...answer, checking: true } : answer);
      else checks.set(path, running ? { state: "unknown", checking: true } : { state: "unknown" });
    }
    return checks;
  }, [canAsk, enabled, environmentId, offline, paths, run]);
}
