import {
  StorageCleanupKeepReason,
  StorageCleanupRemoveReason,
  type StorageCleanupPlan,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeStorageCleanupReason,
  describeStorageCleanupRun,
  describeStorageCleanupTotal,
  groupStorageCleanupPlan,
  storageCleanupFolderLabel,
  storageCleanupReasonSentence,
} from "./storageCleanupPlan";

const SENTENCES = {
  merged: "Its pull request merged.",
  closed: "Its pull request closed and every commit is on the remote.",
  resolved: "Its chats are resolved and everything is pushed.",
  deleted: "Its chat was deleted.",
  inactive: "Its chats are resolved and it has been inactive.",
  unchanged: "Its branch has no commits of its own.",
  "interrupted-downloads": "Leftover files of stopped downloads.",
  running: "A chat using it is running or waiting.",
  open: "A chat using it is still open.",
  recent: "Its work finished less than 6 hours ago.",
  changes: "It has uncommitted changes.",
  untracked: "It has files Git does not track.",
  unpushed: "It has commits that are not pushed.",
  stash: "A stash was made on its branch.",
  "ignored-files": "It has ignored files that cannot be rebuilt.",
  media: "It holds more media than is copied automatically.",
  "in-use": "A terminal, an agent or a process is working in it.",
  "broken-registration": "Its Git registration is broken. Check it by hand.",
  "nested-work": "Another repository or hidden changes sit inside it.",
  "no-rule": "No cleanup rule that is on covers it.",
  unknown: "It could not be checked.",
} as const;

const plan = (
  items: ReadonlyArray<Pick<StorageCleanupPlan["items"][number], "action" | "path">>,
  removableBytes = 0,
): StorageCleanupPlan => ({
  checkedAt: "2026-11-16T12:00:00.000Z",
  items: items.map((item) => ({
    kind: "worktree",
    reason: item.action === "remove" ? "merged" : "open",
    detail: null,
    bytes: null,
    threadId: null,
    threadTitle: null,
    threadCount: 1,
    ...item,
  })),
  removableBytes,
  complete: true,
});

describe("storageCleanupReasonSentence", () => {
  it("has a plain sentence for every reason the contract can send", () => {
    const reasons = [...StorageCleanupRemoveReason.literals, ...StorageCleanupKeepReason.literals];
    expect(reasons.toSorted()).toEqual(Object.keys(SENTENCES).toSorted());
    for (const reason of reasons) {
      expect(storageCleanupReasonSentence(reason), reason).toBe(SENTENCES[reason]);
    }
  });

  it("adds the detail in parentheses when there is one", () => {
    expect(describeStorageCleanupReason({ reason: "unpushed", detail: "feature/plan" })).toBe(
      "It has commits that are not pushed. (feature/plan)",
    );
    expect(describeStorageCleanupReason({ reason: "changes", detail: null })).toBe(
      "It has uncommitted changes.",
    );
    expect(
      describeStorageCleanupReason({ reason: "merged", detail: null }, (english) => `[${english}]`),
    ).toBe("[Its pull request merged.]");
  });
});

describe("plan helpers", () => {
  it("names a folder by its last two segments", () => {
    expect(storageCleanupFolderLabel("/Users/me/.specwithcode/worktrees/app/1370-cleanup")).toBe(
      "app/1370-cleanup",
    );
    expect(storageCleanupFolderLabel("C:\\work\\trees\\app\\one\\")).toBe("app/one");
    expect(storageCleanupFolderLabel("/single")).toBe("single");
  });

  it("splits the plan into removed and kept, keeping its order", () => {
    const groups = groupStorageCleanupPlan(
      plan([
        { action: "keep", path: "/a" },
        { action: "remove", path: "/b" },
        { action: "keep", path: "/c" },
      ]),
    );
    expect(groups.remove.map((item) => item.path)).toEqual(["/b"]);
    expect(groups.keep.map((item) => item.path)).toEqual(["/a", "/c"]);
  });

  it("says the total as a lower bound and what a run removed", () => {
    expect(describeStorageCleanupTotal(plan([], 1_312_000_000))).toBe(
      "At least 1.3 GB would be freed.",
    );
    const result = (removed: ReadonlyArray<string>, removedBytes: number) => ({
      removed,
      removedBytes,
      plan: plan([]),
    });
    expect(describeStorageCleanupRun(result(["/a", "/b", "/c"], 2.4e9))).toBe(
      "Removed 3 folders, at least 2.4 GB.",
    );
    expect(describeStorageCleanupRun(result(["/a"], 4.4e8))).toBe(
      "Removed 1 folder, at least 440 MB.",
    );
    expect(describeStorageCleanupRun(result([], 0))).toBe("Nothing was removed.");
  });
});
