import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo } from "react";

import type { ShelfEntry } from "~/artifactShelf";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const LegacyShelfState = Schema.Struct({
  pinned: Schema.Array(Schema.String),
  hidden: Schema.Array(Schema.String),
});

/** Enough of an entry to list it again where its thread cannot be read. */
const ShelfSnapshotEntry = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  path: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.String),
});
export type ShelfSnapshotEntry = typeof ShelfSnapshotEntry.Type;

const ShelfState = Schema.Struct({
  version: Schema.Literal(2),
  pinned: Schema.Array(Schema.String),
  hidden: Schema.Array(Schema.String),
  /** The threads (storage keys) these choices came from, nearest first. */
  inheritedFrom: Schema.optional(Schema.Array(Schema.String)),
  snapshot: Schema.optional(Schema.Array(ShelfSnapshotEntry)),
  savedAt: Schema.optional(Schema.Number),
});
export type ShelfState = typeof ShelfState.Type;

const decodeState = Schema.decodeSync(Schema.fromJsonString(ShelfState));
const decodeLegacyState = Schema.decodeSync(Schema.fromJsonString(LegacyShelfState));
const decodeIndex = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const EMPTY: ShelfState = { version: 2, pinned: [], hidden: [] };
/** Enough for any thread; the oldest choice drops first past it. */
const LIMIT = 500;
/** The newest entries a snapshot keeps besides the pinned ones. */
const SNAPSHOT_RECENT = 60;
/** Per thread, so fifty snapshots stay well inside the browser's storage quota. */
export const SNAPSHOT_MAX_BYTES = 32_000;
/** Threads whose snapshots are kept; the least recently opened loses its snapshot, not its pins. */
export const SNAPSHOT_THREADS = 50;
export const SNAPSHOT_INDEX_KEY = "studio:artifact-shelf:v2:index";

export function artifactShelfStorageKey(threadRef: ScopedThreadRef | null): string {
  return threadRef === null
    ? "studio:artifact-shelf:v2:none"
    : `studio:artifact-shelf:v2:${threadRef.environmentId}:${threadRef.threadId}`;
}

/** Where builds before v2 kept the choices; read once, never written again. */
export function legacyArtifactShelfStorageKey(threadRef: ScopedThreadRef | null): string {
  return threadRef === null
    ? "studio:artifact-shelf:v1:none"
    : `studio:artifact-shelf:v1:${threadRef.environmentId}:${threadRef.threadId}`;
}

/** A thread this one continued: another machine's copy, or this machine's before a handoff. */
export interface ShelfOrigin {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Its checkout, so its file entries can be found in this one's. */
  readonly workspaceRoot: string | null;
  readonly machineLabel: string | null;
}

/** The thread fields continuity reads; older servers omit both. */
export interface ShelfContinuedThread {
  readonly id: ThreadId;
  readonly execution?:
    | {
        readonly sourceRoot?:
          | {
              readonly environmentId: EnvironmentId;
              readonly threadId: ThreadId;
              readonly workspaceRoot: string;
              readonly machineLabel?: string | undefined;
            }
          | null
          | undefined;
      }
    | null
    | undefined;
  readonly movedFrom?:
    | {
        readonly threadId: ThreadId;
        readonly kind?: "project" | "handoff" | undefined;
        readonly environmentId?: EnvironmentId | undefined;
        readonly machineLabel?: string | undefined;
      }
    | null
    | undefined;
}

/**
 * The threads a continuation came from, nearest first: the checkout its
 * execution record names, then a handoff link. A project move starts fresh,
 * so it carries nothing.
 */
export function shelfOrigins(
  thread: ShelfContinuedThread | null | undefined,
  environmentId: EnvironmentId,
): ShelfOrigin[] {
  if (!thread) return [];
  const origins: ShelfOrigin[] = [];
  const source = thread.execution?.sourceRoot;
  if (source && (source.threadId !== thread.id || source.environmentId !== environmentId)) {
    origins.push({
      environmentId: source.environmentId,
      threadId: source.threadId,
      workspaceRoot: source.workspaceRoot,
      machineLabel: source.machineLabel ?? null,
    });
  }
  const moved = thread.movedFrom;
  if (moved?.kind === "handoff") {
    const origin: ShelfOrigin = {
      environmentId: moved.environmentId ?? environmentId,
      threadId: moved.threadId,
      workspaceRoot: null,
      machineLabel: moved.machineLabel ?? null,
    };
    const same = origins.findIndex(
      (entry) => entry.environmentId === origin.environmentId && entry.threadId === origin.threadId,
    );
    if (same < 0 && (origin.threadId !== thread.id || origin.environmentId !== environmentId)) {
      origins.push(origin);
    } else if (same >= 0 && origins[same]!.machineLabel === null) {
      origins[same] = { ...origins[same]!, machineLabel: origin.machineLabel };
    }
  }
  return origins;
}

function withoutTrailingSeparators(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** A file entry's id in another checkout; links and pages keep theirs. */
export function remapShelfId(id: string, fromRoot: string | null, toRoot: string | null): string {
  if (!fromRoot || !toRoot) return id;
  const from = `file:${withoutTrailingSeparators(fromRoot)}`;
  const to = `file:${withoutTrailingSeparators(toRoot)}`;
  if (from === to) return id;
  if (id === from) return to;
  const rest = id.slice(from.length);
  return id.startsWith(from) && (rest.startsWith("/") || rest.startsWith("\\"))
    ? `${to}${rest}`
    : id;
}

export function remapShelfPath(path: string, fromRoot: string | null, toRoot: string | null) {
  return remapShelfId(`file:${path}`, fromRoot, toRoot).slice("file:".length);
}

function readJson<T>(storage: ShelfStorage, key: string, decode: (text: string) => T): T | null {
  try {
    const text = storage.getItem(key);
    return text === null ? null : decode(text);
  } catch {
    return null;
  }
}

export type ShelfStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

function shelfStorage(): ShelfStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface ResolvedShelfState {
  readonly state: ShelfState;
  /** "own", "legacy", or the storage key of the thread it was inherited from. */
  readonly from: string;
}

/**
 * A thread's choices: its own, else what an older build kept for it, else
 * those of the thread it continued (theirs carried forward the same way),
 * with file ids moved into this thread's checkout.
 */
export function readShelfState(
  storage: ShelfStorage,
  threadRef: ScopedThreadRef,
  origins: ReadonlyArray<ShelfOrigin>,
  workspaceRoot: string | null,
): ResolvedShelfState | null {
  const own = readJson(storage, artifactShelfStorageKey(threadRef), decodeState);
  if (own) return { state: own, from: "own" };
  const legacy = readJson(storage, legacyArtifactShelfStorageKey(threadRef), decodeLegacyState);
  if (legacy) return { state: { version: 2, ...legacy }, from: "legacy" };
  for (const origin of origins) {
    const ref = { environmentId: origin.environmentId, threadId: origin.threadId };
    const key = artifactShelfStorageKey(ref);
    const legacyFound = readJson(storage, legacyArtifactShelfStorageKey(ref), decodeLegacyState);
    const found: ShelfState | null =
      readJson(storage, key, decodeState) ??
      (legacyFound === null ? null : { version: 2, ...legacyFound });
    if (!found) continue;
    const move = (ids: ReadonlyArray<string>) =>
      ids.map((id) => remapShelfId(id, origin.workspaceRoot, workspaceRoot));
    return {
      state: {
        version: 2,
        pinned: move(found.pinned),
        hidden: move(found.hidden),
        inheritedFrom: [key, ...(found.inheritedFrom ?? [])],
      },
      from: key,
    };
  }
  return null;
}

/** The snapshot an origin left, for listing its entries while its thread cannot be read. */
export function readShelfSnapshot(
  storage: ShelfStorage | null,
  origin: Pick<ShelfOrigin, "environmentId" | "threadId">,
): ReadonlyArray<ShelfSnapshotEntry> {
  if (storage === null) return [];
  return readJson(storage, artifactShelfStorageKey(origin), decodeState)?.snapshot ?? [];
}

export function readOriginSnapshot(origin: Pick<ShelfOrigin, "environmentId" | "threadId">) {
  return readShelfSnapshot(shelfStorage(), origin);
}

/** Pinned entries, then the newest, as many as fit the per-thread budget. */
export function compactSnapshot(entries: ReadonlyArray<ShelfEntry>): ShelfSnapshotEntry[] {
  const chosen = [
    ...entries.filter((entry) => entry.pinned && !entry.hidden),
    ...entries.filter((entry) => !entry.pinned && !entry.hidden).slice(0, SNAPSHOT_RECENT),
  ];
  const snapshot: ShelfSnapshotEntry[] = [];
  let bytes = 2;
  for (const entry of chosen) {
    const { artifact } = entry;
    // A page published as an attachment lives on its own machine; it is not carried.
    if (artifact.kind === "html" && "attachmentId" in artifact) continue;
    const url =
      artifact.kind === "link"
        ? artifact.url
        : artifact.kind === "native"
          ? (artifact.native.url ?? undefined)
          : undefined;
    const path =
      artifact.kind === "native"
        ? artifact.native.localPath
        : "meta" in artifact
          ? artifact.meta.filePath
          : undefined;
    const item: ShelfSnapshotEntry = {
      id: entry.id,
      kind: artifact.kind,
      name: entry.label,
      ...(path === undefined ? {} : { path }),
      ...(url === undefined ? {} : { url }),
      ...(entry.mentionedAt === null ? {} : { at: entry.mentionedAt }),
      ...(entry.source ? { source: entry.source.label } : {}),
    };
    const size = JSON.stringify(item).length + 1;
    if (bytes + size > SNAPSHOT_MAX_BYTES) break;
    bytes += size;
    snapshot.push(item);
  }
  return snapshot;
}

/**
 * Marks a thread's snapshot as just used, and drops the snapshots of the
 * least recently used threads past {@link SNAPSHOT_THREADS}. Pins and hides
 * are never dropped; a thread left with neither loses its key.
 */
export function touchSnapshotIndex(storage: ShelfStorage, key: string): void {
  try {
    const index = readJson(storage, SNAPSHOT_INDEX_KEY, decodeIndex) ?? [];
    const next = [...index.filter((entry) => entry !== key), key];
    for (const evicted of next.splice(0, Math.max(0, next.length - SNAPSHOT_THREADS))) {
      const state = readJson(storage, evicted, decodeState);
      if (!state?.snapshot) continue;
      const { snapshot: _snapshot, savedAt: _savedAt, ...rest } = state;
      if (rest.pinned.length === 0 && rest.hidden.length === 0 && storage.removeItem) {
        storage.removeItem(evicted);
      } else {
        storage.setItem(evicted, JSON.stringify(rest));
      }
    }
    storage.setItem(SNAPSHOT_INDEX_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store keeps the snapshots it has; pins are unaffected.
  }
}

function toggled(list: ReadonlyArray<string>, id: string, on: boolean): string[] {
  const rest = list.filter((entry) => entry !== id);
  return on ? [...rest, id].slice(-LIMIT) : rest;
}

const NO_ORIGINS: ReadonlyArray<ShelfOrigin> = [];

/**
 * What the user pinned and hid in one thread's artifacts list, on this
 * device. Hiding takes an entry off the list and nothing else: the file stays
 * where it is. A thread without choices of its own takes those of the thread
 * it continued, once; after that its own choices decide.
 */
export function useArtifactShelfState(
  threadRef: ScopedThreadRef | null,
  continuity?: {
    readonly origins: ReadonlyArray<ShelfOrigin>;
    readonly workspaceRoot: string | null;
  },
) {
  const key = artifactShelfStorageKey(threadRef);
  const [stored, setStored] = useLocalStorage(key, EMPTY, ShelfState);
  const origins = continuity?.origins ?? NO_ORIGINS;
  const originsKey = origins
    .map((origin) => `${origin.environmentId}:${origin.threadId}:${origin.workspaceRoot ?? ""}`)
    .join("\n");
  const workspaceRoot = continuity?.workspaceRoot ?? null;
  const storage = shelfStorage();
  const fallback = useMemo(
    () =>
      stored === EMPTY && threadRef !== null && storage !== null
        ? readShelfState(storage, threadRef, origins, workspaceRoot)
        : null,
    [key, originsKey, stored, storage, workspaceRoot],
  );
  const state = stored === EMPTY ? (fallback?.state ?? EMPTY) : stored;
  const update = useCallback(
    (change: (current: ShelfState) => ShelfState) => {
      // A value no build can read would refuse every write; it is cleared first.
      if (
        storage !== null &&
        storage.getItem(key) !== null &&
        readJson(storage, key, decodeState) === null
      ) {
        storage.removeItem?.(key);
      }
      setStored((current) => change(current === EMPTY ? (fallback?.state ?? EMPTY) : current));
    },
    [fallback, key, setStored, storage],
  );
  useEffect(() => {
    if (fallback === null || fallback.from === "own") return;
    // Written once, so a later unpin here is not undone by the older record.
    update((current) => current);
  }, [fallback, update]);
  const pinned = useMemo(() => new Set(state.pinned), [state.pinned]);
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden]);
  const setPinned = useCallback(
    (id: string, on: boolean) =>
      update((current) => ({
        ...current,
        pinned: toggled(current.pinned, id, on),
        // A pinned entry is one the user wants to see.
        hidden: on ? toggled(current.hidden, id, false) : current.hidden,
      })),
    [update],
  );
  const setHidden = useCallback(
    (id: string, on: boolean) =>
      update((current) => ({
        ...current,
        pinned: on ? toggled(current.pinned, id, false) : current.pinned,
        hidden: toggled(current.hidden, id, on),
      })),
    [update],
  );
  const snapshotIds = (state.snapshot ?? []).map((entry) => entry.id).join("\n");
  /** Keeps what the list shows, so a continuation elsewhere can list it while this thread is out of reach. */
  const recordSnapshot = useCallback(
    (entries: ReadonlyArray<ShelfEntry>) => {
      if (threadRef === null || storage === null) return;
      const snapshot = compactSnapshot(entries);
      if (snapshot.length === 0 && snapshotIds === "") return;
      if (snapshot.map((entry) => entry.id).join("\n") !== snapshotIds) {
        update((current) => ({ ...current, snapshot, savedAt: Date.now() }));
      }
      touchSnapshotIndex(storage, key);
    },
    [key, snapshotIds, storage, threadRef, update],
  );
  return { pinned, hidden, setPinned, setHidden, recordSnapshot };
}
