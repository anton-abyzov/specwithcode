import {
  LINKED_MEMORY_HISTORY_LIMIT,
  LINKED_MEMORY_TOMBSTONE_LIMIT,
  type LinkedMemoryExport,
} from "@specweave-studio/contracts";

/**
 * Two-way merge of linked project memory, decided per file from content hashes:
 * every machine remembers which versions a file has had, so a version the other
 * side has already seen is older, and two versions neither has seen are
 * concurrent edits that go to the last writer. Pure, so both sides of a pair
 * reach the same winner from the same two exports, and a pass that fails on one
 * side converges on the next.
 */
export const MEMORY_INDEX_NAME = "MEMORY.md";

export interface MemoryFileHistory {
  /** Content hashes the file has had here, oldest first. */
  readonly history: ReadonlyArray<string>;
  /** When the last hash was written, on the machine that wrote it. */
  readonly authoredAt?: string;
}
export interface MemoryTombstone {
  readonly deletedAt: string;
  readonly history: ReadonlyArray<string>;
}
export interface MemoryHistoryState {
  readonly files: Readonly<Record<string, MemoryFileHistory>>;
  readonly tombstones: Readonly<Record<string, MemoryTombstone>>;
}
export const emptyMemoryHistory: MemoryHistoryState = { files: {}, tombstones: {} };

/** `secondary`'s unknown hashes first, then `primary` in order, newest kept. */
export const unionHistory = (
  primary: ReadonlyArray<string>,
  secondary: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const seen = new Set(primary);
  return [...secondary.filter((hash) => !seen.has(hash)), ...primary]
    .filter((hash, index, all) => all.lastIndexOf(hash) === index)
    .slice(-LINKED_MEMORY_HISTORY_LIMIT);
};
const appendHistory = (history: ReadonlyArray<string>, hash: string) =>
  unionHistory([...history.filter((entry) => entry !== hash), hash], []);

const withoutKey = <V>(record: Readonly<Record<string, V>>, key: string) => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};
const newestTombstones = (tombstones: Readonly<Record<string, MemoryTombstone>>) =>
  Object.fromEntries(
    Object.entries(tombstones)
      .toSorted(([, a], [, b]) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
      .slice(0, LINKED_MEMORY_TOMBSTONE_LIMIT),
  );

/** A write from a tool, the UI or a merge: `hash` replaced `previous`. */
export const recordMemoryWrite = (
  state: MemoryHistoryState,
  input: {
    readonly name: string;
    readonly previous: string | undefined;
    readonly hash: string;
    readonly authoredAt: string;
  },
): MemoryHistoryState => {
  const before = unionHistory(
    state.files[input.name]?.history ?? [],
    state.tombstones[input.name]?.history ?? [],
  );
  const history = appendHistory(
    input.previous === undefined ? before : appendHistory(before, input.previous),
    input.hash,
  );
  return {
    files: { ...state.files, [input.name]: { history, authoredAt: input.authoredAt } },
    tombstones: withoutKey(state.tombstones, input.name),
  };
};

/** A deletion: the file's versions move to a tombstone the peers can honour. */
export const recordMemoryDelete = (
  state: MemoryHistoryState,
  input: { readonly name: string; readonly hash: string | undefined; readonly deletedAt: string },
): MemoryHistoryState => {
  const history = state.files[input.name]?.history ?? [];
  return {
    files: withoutKey(state.files, input.name),
    tombstones: newestTombstones({
      ...state.tombstones,
      [input.name]: {
        deletedAt: input.deletedAt,
        history: input.hash === undefined ? history : appendHistory(history, input.hash),
      },
    }),
  };
};

export interface LocalMemoryFile {
  readonly content: string;
  readonly sha: string;
  readonly revision: number;
  /** As exported: the authoring time of this content, else the row's update time. */
  readonly updatedAt: string;
  /** Ends with `sha`. */
  readonly history: ReadonlyArray<string>;
}

/** A file's versions as exported: stored history, healed to end with the current hash. */
export const localFileView = (
  stored: MemoryFileHistory | undefined,
  row: { readonly sha: string; readonly updatedAt: string },
): { readonly history: ReadonlyArray<string>; readonly updatedAt: string } => {
  const history = stored?.history ?? [];
  return history.at(-1) === row.sha && stored?.authoredAt
    ? { history, updatedAt: stored.authoredAt }
    : { history: appendHistory(history, row.sha), updatedAt: row.updatedAt };
};

export interface LocalMemory {
  readonly environmentId: string;
  /** Names this machine's conflict copies, for example "macbook-pro". */
  readonly machineSlug: string;
  readonly files: ReadonlyMap<string, LocalMemoryFile>;
  readonly tombstones: Readonly<Record<string, MemoryTombstone>>;
}

export type MemoryMergeStep =
  | {
      readonly kind: "write";
      readonly name: string;
      readonly content: string;
      readonly sha: string;
      readonly expectedRevision: number | null;
      readonly history: ReadonlyArray<string>;
      readonly authoredAt: string;
      /** This machine's losing version, saved first; `write` false when that copy exists. */
      readonly conflictCopy?: {
        readonly name: string;
        readonly content: string;
        readonly write: boolean;
      };
    }
  | {
      readonly kind: "delete";
      readonly name: string;
      readonly expectedRevision: number;
      readonly tombstone: MemoryTombstone;
    }
  /** Only the remembered versions change. */
  | {
      readonly kind: "history";
      readonly name: string;
      readonly history: ReadonlyArray<string>;
      readonly authoredAt: string;
    }
  | { readonly kind: "tombstone"; readonly name: string; readonly tombstone: MemoryTombstone };

export interface MemoryMergePlan {
  readonly steps: ReadonlyArray<MemoryMergeStep>;
  readonly kept: ReadonlyArray<string>;
}

/** Lowercase dashes, at most 32 characters, from a machine label or environment id. */
export const machineSlug = (label: string | undefined, environmentId: string): string => {
  const slug = (value: string, max: number) =>
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, max)
      .replace(/^-+|-+$/g, "");
  return slug(label ?? "", 32) || slug(environmentId, 8) || "machine";
};

const MEMORY_NAME_MAX = 128;
/** `<base>.conflict-<slug>.md`, then `-2`, `-3`… until free or already holding `sha`. */
export const conflictCopyName = (
  name: string,
  slug: string,
  holds: (candidate: string) => "free" | "same" | "taken",
): { readonly name: string; readonly exists: boolean } => {
  const base = name.replace(/\.md$/, "");
  for (let attempt = 1; ; attempt += 1) {
    const suffix = `.conflict-${slug}${attempt === 1 ? "" : `-${attempt}`}.md`;
    const candidate = `${base.slice(0, MEMORY_NAME_MAX - suffix.length).replace(/[._-]+$/, "")}${suffix}`;
    const state = holds(candidate);
    if (state !== "taken") return { name: candidate, exists: state === "same" };
  }
};

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const remoteWins = (
  local: { readonly updatedAt: string; readonly environmentId: string },
  remote: { readonly updatedAt: string; readonly environmentId: string },
) => {
  const difference = Date.parse(remote.updatedAt) - Date.parse(local.updatedAt);
  return difference === 0 || Number.isNaN(difference)
    ? remote.environmentId > local.environmentId
    : difference > 0;
};

/**
 * Plans applying a peer's export here. Names only one side has are adopted or
 * left alone: absence never deletes, so a truncated export is safe. `MEMORY.md`
 * is never deleted by a peer, and a losing local version always gets a copy.
 */
export const planMemoryMerge = (
  local: LocalMemory,
  remote: LinkedMemoryExport,
): MemoryMergePlan => {
  const steps: MemoryMergeStep[] = [];
  const kept: string[] = [];
  const taken = new Set<string>([
    ...local.files.keys(),
    ...Object.keys(local.tombstones),
    ...remote.files.map((file) => file.name),
  ]);
  const remoteFiles = new Map(
    remote.files.map((file) => [
      file.name,
      { ...file, history: appendHistory(file.history, file.contentSha256) },
    ]),
  );
  const remoteTombstones = new Map(remote.tombstones.map((entry) => [entry.name, entry]));
  const names = [...new Set([...remoteFiles.keys(), ...remoteTombstones.keys()])].toSorted();
  const write = (
    name: string,
    file: NonNullable<ReturnType<typeof remoteFiles.get>>,
    expectedRevision: number | null,
    history: ReadonlyArray<string>,
    conflictCopy?: Extract<MemoryMergeStep, { kind: "write" }>["conflictCopy"],
  ) =>
    steps.push({
      kind: "write",
      name,
      content: file.content,
      sha: file.contentSha256,
      expectedRevision,
      history,
      authoredAt: file.updatedAt,
      ...(conflictCopy ? { conflictCopy } : {}),
    });

  for (const name of names) {
    const mine = local.files.get(name);
    const theirs = remoteFiles.get(name);
    const theirTombstone = remoteTombstones.get(name);
    const myTombstone = mine || name === MEMORY_INDEX_NAME ? undefined : local.tombstones[name];

    if (mine && theirs) {
      if (mine.sha === theirs.contentSha256) {
        const history = unionHistory(mine.history, theirs.history);
        const authoredAt = later(mine.updatedAt, theirs.updatedAt);
        if (history.join() !== mine.history.join() || authoredAt !== mine.updatedAt)
          steps.push({ kind: "history", name, history, authoredAt });
        continue;
      }
      const theirsIsKnown = mine.history.includes(theirs.contentSha256);
      const mineIsKnown = theirs.history.includes(mine.sha);
      const remoteFirst = remoteWins(
        { updatedAt: mine.updatedAt, environmentId: local.environmentId },
        { updatedAt: theirs.updatedAt, environmentId: remote.environmentId },
      );
      if (theirsIsKnown && (!mineIsKnown || !remoteFirst)) {
        kept.push(name);
        continue;
      }
      if (mineIsKnown) {
        write(name, theirs, mine.revision, unionHistory(theirs.history, mine.history));
        continue;
      }
      // Concurrent edits. A winning local version does not learn the remote hash,
      // so the peer still sees a concurrent edit and keeps its own copy.
      if (!remoteFirst) {
        kept.push(name);
        continue;
      }
      const copy = conflictCopyName(name, local.machineSlug, (candidate) =>
        local.files.get(candidate)?.sha === mine.sha
          ? "same"
          : taken.has(candidate)
            ? "taken"
            : "free",
      );
      taken.add(copy.name);
      write(name, theirs, mine.revision, unionHistory(theirs.history, mine.history), {
        name: copy.name,
        content: mine.content,
        write: !copy.exists,
      });
      continue;
    }

    if (mine && theirTombstone) {
      if (name !== MEMORY_INDEX_NAME && theirTombstone.history.includes(mine.sha)) {
        steps.push({
          kind: "delete",
          name,
          expectedRevision: mine.revision,
          tombstone: {
            deletedAt: theirTombstone.deletedAt,
            history: unionHistory(theirTombstone.history, mine.history),
          },
        });
        continue;
      }
      kept.push(name);
      continue;
    }

    if (theirs) {
      if (myTombstone) {
        if (myTombstone.history.includes(theirs.contentSha256)) {
          kept.push(name);
          continue;
        }
        write(name, theirs, null, unionHistory(theirs.history, myTombstone.history));
        continue;
      }
      write(name, theirs, null, theirs.history);
      continue;
    }

    if (theirTombstone && name !== MEMORY_INDEX_NAME) {
      const history = unionHistory(theirTombstone.history, myTombstone?.history ?? []);
      const deletedAt = myTombstone
        ? later(myTombstone.deletedAt, theirTombstone.deletedAt)
        : theirTombstone.deletedAt;
      if (
        !myTombstone ||
        history.join() !== myTombstone.history.join() ||
        deletedAt !== myTombstone.deletedAt
      )
        steps.push({ kind: "tombstone", name, tombstone: { deletedAt, history } });
    }
  }
  return { steps, kept };
};

/**
 * The history state after a step was applied here. A conflict copy is an
 * ordinary new file, already recorded by the write that saved it.
 */
export const applyMergeStepToHistory = (
  state: MemoryHistoryState,
  step: MemoryMergeStep,
): MemoryHistoryState => {
  switch (step.kind) {
    case "write":
    case "history":
      return {
        files: {
          ...state.files,
          [step.name]: { history: step.history, authoredAt: step.authoredAt },
        },
        tombstones: withoutKey(state.tombstones, step.name),
      };
    case "delete":
    case "tombstone":
      return {
        files: withoutKey(state.files, step.name),
        tombstones: newestTombstones({ ...state.tombstones, [step.name]: step.tombstone }),
      };
  }
};
