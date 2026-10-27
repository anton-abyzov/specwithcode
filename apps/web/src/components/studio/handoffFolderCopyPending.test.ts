import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  archivePendingCopy,
  folderCopyDraftKey,
  folderCopyLastKey,
  folderCopyStorageKey,
  readCopyDraft,
  readLastCopy,
  readoptLastCopy,
  readPendingCopy,
  writeCopyDraft,
  type PendingCopy,
} from "./handoffFolderCopyPending";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

/** Private windows and full quotas: every call throws. */
function throwingStorage(): Storage {
  const refuse = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  return {
    length: 0,
    clear: refuse,
    getItem: refuse,
    key: refuse,
    removeItem: refuse,
    setItem: refuse,
  };
}

const pendingKey = folderCopyStorageKey("m4", "source");
const lastKey = folderCopyLastKey("m4", "source");
const draftKey = folderCopyDraftKey("m4", "source");

const pointer: PendingCopy = {
  operationId: "00000000-0000-4000-8000-000000000001",
  environmentId: "m3",
  mode: "copy-only",
  targetFolder: "/Users/me/Projects/project",
  projectId: null,
  selection: ["repository", "tracked"],
  auto: true,
  method: "copy",
};

const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pointer's step fields", () => {
  it("keeps valid seen, viewed, doneSeen and linked", () => {
    save(pendingKey, { ...pointer, seen: "review", viewed: "what", doneSeen: true, linked: true });
    expect(readPendingCopy(pendingKey)).toEqual({
      ...pointer,
      seen: "review",
      viewed: "what",
      doneSeen: true,
      linked: true,
    });
  });

  it("drops invalid values and keeps the rest of the pointer", () => {
    save(pendingKey, {
      ...pointer,
      seen: "measure",
      viewed: 3,
      doneSeen: "yes",
      linked: 1,
    });
    expect(readPendingCopy(pendingKey)).toEqual(pointer);
  });

  it("parses a pointer saved before steps were remembered exactly as before", () => {
    const old = {
      operationId: pointer.operationId,
      environmentId: "m3",
      mode: "copy-and-move",
      targetFolder: "/Users/me/Projects/project",
      projectId: "project-1",
      copyRoot: "/Users/me/Projects",
      projectRelativePath: ".",
      replaceAll: true,
      replaceAllOutcome: "copy-kept",
    };
    save(pendingKey, old);
    expect(readPendingCopy(pendingKey)).toEqual(old);
  });

  it("still refuses a pointer without an operation", () => {
    save(pendingKey, { environmentId: "m3", seen: "copy" });
    expect(readPendingCopy(pendingKey)).toBeNull();
  });
});

describe("the last copy", () => {
  it("archives a finished copy, clears the pointer and reads it back", () => {
    const finished = { ...pointer, seen: "done" as const, viewed: "done" as const };
    save(pendingKey, { ...finished, doneSeen: true, linked: true });
    const archived = archivePendingCopy({
      pendingKey,
      lastKey,
      pointer: { ...finished, doneSeen: true, linked: true },
      finishedAt: "2026-10-26T12:00:00.000Z",
    });
    const { viewed: _viewed, ...kept } = finished;
    expect(archived).toEqual({ ...kept, linked: true, finishedAt: "2026-10-26T12:00:00.000Z" });
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(readLastCopy(lastKey)).toEqual(archived);
  });

  it("re-adopts the last copy as the pointer without doneSeen", () => {
    archivePendingCopy({
      pendingKey,
      lastKey,
      pointer: { ...pointer, seen: "done", doneSeen: true },
      finishedAt: "2026-10-26T12:00:00.000Z",
    });
    const readopted = readoptLastCopy({ pendingKey, lastKey });
    // Marked as the last copy opened again, so it can go back to being the last copy.
    expect(readopted).toEqual({ ...pointer, seen: "done", reopened: true });
    expect(readPendingCopy(pendingKey)).toEqual({ ...pointer, seen: "done", reopened: true });
    expect(readLastCopy(lastKey)).toBeNull();
  });

  it("ignores a last copy without finishedAt or an operation", () => {
    save(lastKey, pointer);
    expect(readLastCopy(lastKey)).toBeNull();
    save(lastKey, { environmentId: "m3", finishedAt: "2026-10-26T12:00:00.000Z" });
    expect(readLastCopy(lastKey)).toBeNull();
    expect(readoptLastCopy({ pendingKey, lastKey })).toBeNull();
  });
});

describe("the setup draft", () => {
  const draft = {
    machine: "m3",
    folder: "/Users/me/Projects/project",
    copyRoot: "/Users/me/Projects",
    mode: "copy-and-move" as const,
    chooseFirst: true,
  };

  it("round-trips and is removed with null", () => {
    expect(writeCopyDraft(draftKey, draft)).toBe(true);
    expect(readCopyDraft(draftKey)).toEqual(draft);
    expect(writeCopyDraft(draftKey, null)).toBe(true);
    expect(readCopyDraft(draftKey)).toBeNull();
  });

  it("keeps a draft with no machine chosen yet", () => {
    writeCopyDraft(draftKey, { machine: null, folder: "", mode: "copy-only", chooseFirst: false });
    expect(readCopyDraft(draftKey)).toEqual({
      machine: null,
      folder: "",
      mode: "copy-only",
      chooseFirst: false,
    });
  });

  it("refuses a draft with a wrong field", () => {
    save(draftKey, { ...draft, mode: "move" });
    expect(readCopyDraft(draftKey)).toBeNull();
    save(draftKey, { ...draft, chooseFirst: "yes" });
    expect(readCopyDraft(draftKey)).toBeNull();
    save(draftKey, { ...draft, machine: 4 });
    expect(readCopyDraft(draftKey)).toBeNull();
    localStorage.setItem(draftKey, "{not json");
    expect(readCopyDraft(draftKey)).toBeNull();
  });
});

describe("a localStorage that throws", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", throwingStorage());
  });

  it("reads nothing and never throws", () => {
    expect(readPendingCopy(pendingKey)).toBeNull();
    expect(readLastCopy(lastKey)).toBeNull();
    expect(readCopyDraft(draftKey)).toBeNull();
    expect(readoptLastCopy({ pendingKey, lastKey })).toBeNull();
  });

  it("reports refused writes instead of throwing", () => {
    expect(
      archivePendingCopy({ pendingKey, lastKey, pointer, finishedAt: "2026-10-26T12:00:00.000Z" }),
    ).toBeNull();
    expect(
      writeCopyDraft(draftKey, {
        machine: null,
        folder: "",
        mode: "copy-only",
        chooseFirst: false,
      }),
    ).toBe(false);
    expect(writeCopyDraft(draftKey, null)).toBe(false);
  });

  it("still hands back a last copy when only the writes are refused", () => {
    const storage = memoryStorage();
    storage.setItem(
      lastKey,
      JSON.stringify({ ...pointer, finishedAt: "2026-10-26T12:00:00.000Z" }),
    );
    vi.stubGlobal("localStorage", {
      ...storage,
      getItem: storage.getItem,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(readoptLastCopy({ pendingKey, lastKey })).toEqual({ ...pointer, reopened: true });
  });
});
