import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@specweave-studio/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { shelfEntries, type ShelfEntry } from "~/artifactShelf";
import type { ThreadArtifact } from "~/threadArtifacts";

import {
  artifactShelfStorageKey,
  compactSnapshot,
  legacyArtifactShelfStorageKey,
  readShelfSnapshot,
  readShelfState,
  remapShelfId,
  type ShelfOrigin,
  shelfOrigins,
  SNAPSHOT_INDEX_KEY,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_THREADS,
  touchSnapshotIndex,
  useArtifactShelfState,
} from "./useArtifactShelfState";

// Synthetic machines, threads and checkouts only.
const MAC_A = EnvironmentId.make("example-mac-a");
const MAC_B = EnvironmentId.make("example-mac-b");
const MAC_C = EnvironmentId.make("example-mac-c");
const ON_A = { environmentId: MAC_A, threadId: ThreadId.make("thread-a") };
const ON_B = { environmentId: MAC_B, threadId: ThreadId.make("handoff:thread-b") };
const ON_C = { environmentId: MAC_C, threadId: ThreadId.make("handoff:thread-c") };
const BACK_ON_A = { environmentId: MAC_A, threadId: ThreadId.make("handoff:thread-a2") };
const ROOT_A = "/Users/example/work/repo";
const ROOT_B = "/tmp/example-b/repo";
const ROOT_C = "/tmp/example-c/repo";

const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

function origin(ref: ScopedThreadRef, workspaceRoot: string | null): ShelfOrigin {
  return { ...ref, workspaceRoot, machineLabel: null };
}

type Shelf = ReturnType<typeof useArtifactShelfState>;
let shelf: Shelf | undefined;
function Probe(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly origins?: ReadonlyArray<ShelfOrigin>;
  readonly root?: string | null;
}) {
  shelf = useArtifactShelfState(props.threadRef, {
    origins: props.origins ?? [],
    workspaceRoot: props.root ?? null,
  });
  return null;
}

let renderer: ReactTestRenderer | undefined;
async function mount(props: Parameters<typeof Probe>[0]) {
  await act(async () => renderer?.unmount());
  await act(async () => {
    renderer = create(createElement(Probe, props));
  });
  return shelf!;
}

function stored(ref: ScopedThreadRef): Record<string, unknown> | null {
  const text = store.get(artifactShelfStorageKey(ref));
  return text === undefined ? null : JSON.parse(text);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.clear();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useArtifactShelfState", () => {
  it("copies an older build's choices once, and leaves them for a downgrade", async () => {
    const legacy = JSON.stringify({ pinned: ["file:/tmp/a.md"], hidden: ["link:example.com"] });
    store.set(legacyArtifactShelfStorageKey(ON_A), legacy);
    const state = await mount({ threadRef: ON_A });
    expect([...state.pinned]).toEqual(["file:/tmp/a.md"]);
    expect(stored(ON_A)).toMatchObject({ version: 2, pinned: ["file:/tmp/a.md"] });
    expect(store.get(legacyArtifactShelfStorageKey(ON_A))).toBe(legacy);
  });

  it("keeps pins across a reload, an app update and a provider switch in the thread", async () => {
    await mount({ threadRef: ON_A });
    await act(async () => shelf!.setPinned("file:/tmp/a.md", true));
    await act(async () => shelf!.setHidden("link:example.com", true));
    // A newer build added a field this one does not know.
    store.set(
      artifactShelfStorageKey(ON_A),
      JSON.stringify({ ...stored(ON_A), sharedWith: ["example-phone"] }),
    );
    // Claude, then Codex, then Claude again: the thread and its key stay the same.
    for (let reload = 0; reload < 3; reload++) {
      const state = await mount({ threadRef: { ...ON_A } });
      expect([...state.pinned]).toEqual(["file:/tmp/a.md"]);
      expect([...state.hidden]).toEqual(["link:example.com"]);
    }
  });

  it("inherits a migrated thread's choices with file ids moved into the new checkout, once", async () => {
    store.set(
      artifactShelfStorageKey(ON_A),
      JSON.stringify({
        version: 2,
        pinned: [`file:${ROOT_A}/docs/plan.md`, "file:/tmp/outside.md", "link:example.com/x"],
        hidden: [`file:${ROOT_A}/notes.md`],
      }),
    );
    const state = await mount({ threadRef: ON_B, origins: [origin(ON_A, ROOT_A)], root: ROOT_B });
    expect([...state.pinned]).toEqual([
      `file:${ROOT_B}/docs/plan.md`,
      "file:/tmp/outside.md",
      "link:example.com/x",
    ]);
    expect([...state.hidden]).toEqual([`file:${ROOT_B}/notes.md`]);
    expect(stored(ON_B)).toMatchObject({ inheritedFrom: [artifactShelfStorageKey(ON_A)] });
    // An unpin on the new machine is not undone by the origin's record.
    await act(async () => shelf!.setPinned(`file:${ROOT_B}/docs/plan.md`, false));
    const again = await mount({ threadRef: ON_B, origins: [origin(ON_A, ROOT_A)], root: ROOT_B });
    expect(again.pinned.has(`file:${ROOT_B}/docs/plan.md`)).toBe(false);
  });

  it("follows a chain of moves and a continue-here back", async () => {
    store.set(
      legacyArtifactShelfStorageKey(ON_A),
      JSON.stringify({ pinned: [`file:${ROOT_A}/a.md`], hidden: [] }),
    );
    await mount({ threadRef: ON_B, origins: [origin(ON_A, ROOT_A)], root: ROOT_B });
    await mount({ threadRef: ON_C, origins: [origin(ON_B, ROOT_B)], root: ROOT_C });
    expect([...shelf!.pinned]).toEqual([`file:${ROOT_C}/a.md`]);
    expect(stored(ON_C)?.inheritedFrom).toEqual([
      artifactShelfStorageKey(ON_B),
      artifactShelfStorageKey(ON_A),
    ]);
    await mount({ threadRef: BACK_ON_A, origins: [origin(ON_C, ROOT_C)], root: ROOT_A });
    expect([...shelf!.pinned]).toEqual([`file:${ROOT_A}/a.md`]);
  });

  it("starts empty on unreadable storage, and the next choice still saves", async () => {
    store.set(artifactShelfStorageKey(ON_A), "{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await mount({ threadRef: ON_A });
    expect(state.pinned.size).toBe(0);
    await act(async () => shelf!.setPinned("file:/tmp/a.md", true));
    expect(stored(ON_A)).toMatchObject({ pinned: ["file:/tmp/a.md"] });
  });

  it("records what the list showed, for a continuation that cannot read this thread", async () => {
    await mount({ threadRef: ON_A });
    const entries = shelfEntries({
      artifacts: [file(`${ROOT_A}/a.md`), file(`${ROOT_A}/b.md`)],
      mentionedAt: () => 1_000,
      pullRequests: new Map(),
      fileChecks: new Map(),
      pinned: new Set(),
      hidden: new Set([`file:${ROOT_A}/b.md`]),
      now: 2_000,
    });
    await act(async () => shelf!.recordSnapshot(entries));
    expect(readShelfSnapshot(storage, ON_A)).toEqual([
      {
        id: `file:${ROOT_A}/a.md`,
        kind: "markdown",
        name: "a.md",
        path: `${ROOT_A}/a.md`,
        at: 1_000,
      },
    ]);
    expect(JSON.parse(store.get(SNAPSHOT_INDEX_KEY)!)).toEqual([artifactShelfStorageKey(ON_A)]);
  });
});

function file(path: string): ThreadArtifact {
  const basename = path.split("/").at(-1)!;
  return {
    key: `file:${path}`,
    kind: "markdown",
    name: basename,
    messageId: "m",
    meta: { filePath: path, basename, workspaceRelativePath: null } as never,
  };
}

describe("shelfOrigins", () => {
  it("names the checkout a continuation came from, and nothing for a project move", () => {
    const sourceRoot = { ...ON_A, workspaceRoot: ROOT_A };
    expect(shelfOrigins({ id: ON_B.threadId, execution: { sourceRoot } }, MAC_B)).toEqual([
      origin(ON_A, ROOT_A),
    ]);
    // Its own record is not an origin.
    expect(shelfOrigins({ id: ON_A.threadId, execution: { sourceRoot } }, MAC_A)).toEqual([]);
    expect(
      shelfOrigins(
        { id: ON_B.threadId, movedFrom: { threadId: ON_A.threadId, kind: "project" } },
        MAC_B,
      ),
    ).toEqual([]);
    expect(
      shelfOrigins(
        { id: ON_B.threadId, movedFrom: { threadId: ON_A.threadId, kind: "handoff" } },
        MAC_B,
      ),
    ).toEqual([
      { environmentId: MAC_B, threadId: ON_A.threadId, workspaceRoot: null, machineLabel: null },
    ]);
    expect(shelfOrigins(null, MAC_B)).toEqual([]);
  });
});

describe("remapShelfId", () => {
  it("moves only file ids inside the old checkout", () => {
    expect(remapShelfId(`file:${ROOT_A}/a.md`, ROOT_A, ROOT_B)).toBe(`file:${ROOT_B}/a.md`);
    expect(remapShelfId(`file:${ROOT_A}`, `${ROOT_A}/`, ROOT_B)).toBe(`file:${ROOT_B}`);
    expect(remapShelfId(`file:${ROOT_A}-other/a.md`, ROOT_A, ROOT_B)).toBe(
      `file:${ROOT_A}-other/a.md`,
    );
    expect(remapShelfId("link:example.com/a", ROOT_A, ROOT_B)).toBe("link:example.com/a");
    expect(remapShelfId(`file:${ROOT_A}/a.md`, null, ROOT_B)).toBe(`file:${ROOT_A}/a.md`);
  });

  it("reads its own record before an origin's", () => {
    store.set(
      artifactShelfStorageKey(ON_B),
      JSON.stringify({ version: 2, pinned: ["own"], hidden: [] }),
    );
    store.set(
      artifactShelfStorageKey(ON_A),
      JSON.stringify({ version: 2, pinned: ["a"], hidden: [] }),
    );
    expect(readShelfState(storage, ON_B, [origin(ON_A, ROOT_A)], ROOT_B)).toMatchObject({
      from: "own",
      state: { pinned: ["own"] },
    });
  });
});

describe("snapshots", () => {
  function entry(index: number, pinned = false): ShelfEntry {
    const [made] = shelfEntries({
      artifacts: [file(`${ROOT_A}/${"x".repeat(200)}-${index}.md`)],
      mentionedAt: () => index,
      pullRequests: new Map(),
      fileChecks: new Map(),
      pinned: new Set(pinned ? [`file:${ROOT_A}/${"x".repeat(200)}-${index}.md`] : []),
      hidden: new Set(),
      now: 0,
    });
    return made!;
  }

  it("keeps pinned entries first and stays inside its byte budget", () => {
    const entries = [...Array.from({ length: 300 }, (_, index) => entry(index)), entry(999, true)];
    const snapshot = compactSnapshot(entries);
    expect(snapshot[0]!.id).toContain("-999.md");
    expect(snapshot.length).toBeLessThanOrEqual(61);
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  });

  it("drops the least recently opened thread's snapshot past the limit, never its pins", () => {
    const keys = Array.from({ length: SNAPSHOT_THREADS + 1 }, (_, index) =>
      artifactShelfStorageKey({ environmentId: MAC_A, threadId: ThreadId.make(`thread-${index}`) }),
    );
    for (const key of keys) {
      store.set(
        key,
        JSON.stringify({ version: 2, pinned: ["file:/tmp/a.md"], hidden: [], snapshot: [] }),
      );
      touchSnapshotIndex(storage, key);
    }
    expect(JSON.parse(store.get(keys[0]!)!)).toEqual({
      version: 2,
      pinned: ["file:/tmp/a.md"],
      hidden: [],
    });
    expect(JSON.parse(store.get(keys[1]!)!).snapshot).toEqual([]);
    expect(JSON.parse(store.get(SNAPSHOT_INDEX_KEY)!)).toHaveLength(SNAPSHOT_THREADS);
  });

  it("removes an evicted thread's key when it has no pins or hides left", () => {
    const keys = Array.from({ length: SNAPSHOT_THREADS + 1 }, (_, index) =>
      artifactShelfStorageKey({ environmentId: MAC_A, threadId: ThreadId.make(`plain-${index}`) }),
    );
    for (const key of keys) {
      store.set(
        key,
        JSON.stringify({ version: 2, pinned: [], hidden: [], snapshot: [], savedAt: 1 }),
      );
      touchSnapshotIndex(storage, key);
    }
    expect(store.has(keys[0]!)).toBe(false);
    expect(store.has(keys[1]!)).toBe(true);
  });
});
