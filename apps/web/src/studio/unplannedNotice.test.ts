import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  discardUndecodableAcknowledged,
  discardUndecodableHidden,
  UNPLANNED_ACKNOWLEDGED_STORAGE_KEY,
  UNPLANNED_NOTICE_STORAGE_KEY,
  unacknowledgedThreads,
  unplannedNoticeKey,
  withAcknowledged,
  withNoticeHidden,
  withoutAcknowledged,
} from "./unplannedNotice";

describe("unplanned notice setting", () => {
  it("keys the setting by machine and project", () => {
    expect(unplannedNoticeKey("env-1", "project-1")).toBe("env-1:project-1");
    expect(unplannedNoticeKey("env-1", null)).toBeNull();
    expect(unplannedNoticeKey(undefined, "project-1")).toBeNull();
  });

  it("hides and shows one project without touching the others", () => {
    const hidden = withNoticeHidden(["env-1:other"], "env-1:project-1", true);
    expect(hidden).toEqual(["env-1:other", "env-1:project-1"]);
    expect(withNoticeHidden(hidden, "env-1:project-1", true)).toEqual(hidden);
    expect(withNoticeHidden(hidden, "env-1:project-1", false)).toEqual(["env-1:other"]);
  });
});

describe("dismissing the unplanned notice", () => {
  const key = "env-1:project-1";

  it("counts only threads it has not acknowledged", () => {
    const unplanned = new Set(["a", "b", "c"]);
    expect(unacknowledgedThreads(unplanned, [])).toBe(unplanned);
    expect([...unacknowledgedThreads(unplanned, ["a", "c", "gone"])]).toEqual(["b"]);
  });

  it("comes back only for a thread that was not counted when dismissed", () => {
    const dismissed = withAcknowledged({}, key, new Set(["a", "b"]));
    expect([...unacknowledgedThreads(new Set(["a", "b"]), dismissed[key]!)]).toEqual([]);
    // "b" got an increment, "c" is new: only "c" brings the notice back.
    expect([...unacknowledgedThreads(new Set(["a", "c"]), dismissed[key]!)]).toEqual(["c"]);
  });

  it("adds to earlier acknowledgments per project and leaves other projects alone", () => {
    const first = withAcknowledged({ "env-1:other": ["x"] }, key, ["a"]);
    const second = withAcknowledged(first, key, ["a", "b"]);
    expect(second).toEqual({ "env-1:other": ["x"], [key]: ["a", "b"] });
  });

  it("keeps the newest thousand per project", () => {
    const many = Array.from({ length: 1005 }, (_, index) => `t${index}`);
    const kept = withAcknowledged({}, key, many)[key]!;
    expect(kept).toHaveLength(1000);
    expect(kept[0]).toBe("t5");
    expect(kept.at(-1)).toBe("t1004");
  });

  it("never drops a thread it acknowledges again when the list is full", () => {
    const full = { [key]: ["a", ...Array.from({ length: 999 }, (_, index) => `t${index}`)] };
    const kept = withAcknowledged(full, key, new Set(["a", "new"]))[key]!;
    expect(kept).toHaveLength(1000);
    expect(kept.slice(-2)).toEqual(["a", "new"]);
    expect(kept).not.toContain("t0");
    expect([...unacknowledgedThreads(new Set(["a", "new"]), kept)]).toEqual([]);
  });

  it("forgets a project's acknowledgments when the notice is turned back on", () => {
    const stored = withAcknowledged({ "env-1:other": ["x"] }, key, ["a"]);
    expect(withoutAcknowledged(stored, key)).toEqual({ "env-1:other": ["x"] });
    const untouched = { "env-1:other": ["x"] };
    expect(withoutAcknowledged(untouched, key)).toBe(untouched);
  });
});

describe("a stored value this version cannot read", () => {
  function stubStorage(
    stored: string,
    key: string = UNPLANNED_ACKNOWLEDGED_STORAGE_KEY,
  ): Map<string, string> {
    const store = new Map([[key, stored]]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => void store.delete(key),
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    vi.stubGlobal("window", { localStorage: storage });
    return store;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is dropped so Dismiss can write a fresh one", () => {
    const store = stubStorage('{"env-1:project-1":"not a list"}');
    discardUndecodableAcknowledged();
    expect(store.has(UNPLANNED_ACKNOWLEDGED_STORAGE_KEY)).toBe(false);
  });

  it("is dropped so the sort menu switch can write a fresh hidden list", () => {
    const store = stubStorage('"not a list"', UNPLANNED_NOTICE_STORAGE_KEY);
    discardUndecodableHidden();
    expect(store.has(UNPLANNED_NOTICE_STORAGE_KEY)).toBe(false);
  });

  it("leaves a readable record alone", () => {
    const readable = '{"env-1:project-1":["a"]}';
    const store = stubStorage(readable);
    discardUndecodableAcknowledged();
    expect(store.get(UNPLANNED_ACKNOWLEDGED_STORAGE_KEY)).toBe(readable);
  });
});
