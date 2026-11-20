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
  storageCleanupPlanFailure,
  storageCleanupReasonSentence,
} from "./storageCleanupPlan";

const SENTENCES = {
  merged: "Its pull request merged.",
  closed: "Its pull request closed and every commit is on the remote.",
  resolved: "Its chats are resolved or archived and everything is pushed.",
  deleted: "Its chat was deleted.",
  inactive: "Its chats are resolved or archived and it has been inactive.",
  unchanged: "Its branch has no commits of its own.",
  "interrupted-downloads": "Leftover files of stopped downloads.",
  running: "Work in it has not finished.",
  open: "A chat that is still open works in it or near it.",
  recent: "It was used less than 6 hours ago.",
  changes: "It has uncommitted changes.",
  untracked: "It has files Git does not track.",
  unpushed: "It has commits that exist only on this machine.",
  stash: "A stash was made on its branch.",
  "ignored-files": "It has ignored files that may hold data.",
  media: "It holds more media than is copied automatically.",
  "in-use": "Something is working in it, or it is locked.",
  "broken-registration": "Its Git registration is broken. Check it by hand.",
  "nested-work": "Another repository or hidden changes sit inside it.",
  "no-rule": "No cleanup rule covers it.",
  unknown: "It could not be fully checked, so it is kept.",
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
      "It has commits that exist only on this machine. (feature/plan)",
    );
    expect(describeStorageCleanupReason({ reason: "changes", detail: null })).toBe(
      "It has uncommitted changes.",
    );
    expect(
      describeStorageCleanupReason({ reason: "merged", detail: null }, (english) => `[${english}]`),
    ).toBe("[Its pull request merged.]");
  });

  it("leaves out a detail that only repeats the sentence", () => {
    // The server's details for these say what the sentence already says.
    for (const [reason, detail] of [
      ["merged", "Its pull request merged."],
      ["closed", "Its pull request closed and every commit is on the remote."],
      ["deleted", "Its chat was deleted."],
      ["unchanged", "No commits of its own."],
      ["no-rule", "No cleanup rule that is switched on covers it."],
      ["unknown", "It could not be checked."],
      ["unknown", "It could not be fully checked."],
    ] as const) {
      expect(describeStorageCleanupReason({ reason, detail }), detail).toBe(SENTENCES[reason]);
    }
    // Translated, the English detail would otherwise follow its own translation.
    expect(
      describeStorageCleanupReason(
        { reason: "deleted", detail: "Its chat was deleted." },
        (english) => `[${english}]`,
      ),
    ).toBe("[Its chat was deleted.]");
    // A detail that adds a fact stays.
    expect(
      describeStorageCleanupReason({
        reason: "unknown",
        detail: "It is reached through a symbolic link.",
      }),
    ).toBe(
      "It could not be fully checked, so it is kept. (It is reached through a symbolic link.)",
    );
  });

  it("shows a Git removal failure's detail alone, untranslated", () => {
    const detail =
      "Git could not remove it: fatal: 'app/1370' contains modified or untracked files. Open files: node (4512).";
    expect(describeStorageCleanupReason({ reason: "unknown", detail })).toBe(detail);
    const bracket = (english: string) => `[${english}]`;
    expect(describeStorageCleanupReason({ reason: "unknown", detail: `  ${detail}\n` }, bracket)).toBe(
      detail,
    );
    // Only for reason "unknown": another reason keeps its sentence.
    expect(describeStorageCleanupReason({ reason: "in-use", detail })).toBe(
      `Something is working in it, or it is locked. (${detail})`,
    );
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

  it("tells a check that could not finish from one with nothing to remove", () => {
    expect(storageCleanupPlanFailure(plan([]))).toBeNull();
    expect(storageCleanupPlanFailure({ ...plan([]), complete: false })).toEqual({ reason: null });
    // Items with some sizes missing are a real answer, only with lower-bound totals.
    expect(
      storageCleanupPlanFailure({ ...plan([{ action: "keep", path: "/a" }]), complete: false }),
    ).toBeNull();
    // The server's reason is shown whenever it sends one, even next to download rows.
    const failed = {
      ...plan([{ action: "remove", path: "/a" }]),
      complete: false,
      failed: "The chat list could not be read.",
    };
    expect(storageCleanupPlanFailure(failed)).toEqual({
      reason: "The chat list could not be read.",
    });
    const noReason = { ...plan([]), complete: false, failed: null };
    expect(storageCleanupPlanFailure(noReason)).toEqual({ reason: null });
  });

  it("says the total as a lower bound and what a run removed", () => {
    expect(describeStorageCleanupTotal(plan([], 1_312_000_000))).toBe(
      "At least 1.3 GB would be freed.",
    );
    // A removable folder without a size still leaves the total a lower bound.
    expect(describeStorageCleanupTotal(plan([{ action: "remove", path: "/a" }], 512_000_000))).toBe(
      "At least 512 MB would be freed.",
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
