import type { FolderCopyStatus } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  changedRows,
  replaceAllDecisions,
  replaceAllLeftText,
  replaceAllOutcome,
  replaceAllReady,
  replacementText,
  replacesNothing,
  replacingCount,
  secretsLeft,
  secretsLeftText,
} from "./handoffCopyAuto";
import {
  copyProblem,
  groupCopyNotices,
  hasNotCopied,
  skippedWorktreeParts,
} from "./handoffCopyNotices";
import { nextStepText, sourceProgressText, workingLine } from "./handoffCopySteps";

const row = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "repo:app",
    kind: "repository",
    path: "app",
    status: "new",
    detail: "",
    filesToMove: 1,
    bytesToMove: 1,
    bytesPresent: 0,
    choices: [],
    decision: null,
    needsDecision: false,
    conflicts: [],
    moreConflicts: 0,
    cloneAvailable: false,
    clone: false,
    ...overrides,
  }) as never;
const plan = (rows: unknown[], overrides: Record<string, unknown> = {}) =>
  ({
    state: "previewed",
    rows,
    disk: null,
    totals: { filesToMove: 1, bytesToMove: 1, bytesPresent: 0, decisionsNeeded: 0 },
    ...overrides,
  }) as never;

describe("one-click approval", () => {
  it("approves only plans that leave everything on the destination as it is", () => {
    expect(replacesNothing(plan([row(), row({ status: "only-here" })]))).toBe(true);
    // Moving a repository forward, a diverged one, a full disk or open choices all ask first.
    expect(replacesNothing(plan([row({ status: "fast-forward" })]))).toBe(false);
    expect(replacesNothing(plan([row({ status: "fast-forward", replacing: 0 })]))).toBe(false);
    expect(replacesNothing(plan([row({ status: "diverged", choices: ["take-theirs"] })]))).toBe(
      false,
    );
    expect(replacesNothing(plan([row()], { disk: { needed: 2, free: 1 } }))).toBe(false);
    expect(
      replacesNothing(
        plan([row()], {
          totals: { filesToMove: 1, bytesToMove: 1, bytesPresent: 0, decisionsNeeded: 1 },
        }),
      ),
    ).toBe(false);
    expect(replacesNothing(plan([row()], { state: "planned" }))).toBe(false);
    expect(replacesNothing(plan([row()], { totals: null }))).toBe(false);
    // A plan without rows tells nothing about the destination.
    expect(replacesNothing(plan([]))).toBe(false);
  });

  it("uses the destination's replacing counts and is conservative without them", () => {
    // An older destination sends no counts: an unchanged-looking row may still overwrite.
    expect(replacesNothing(plan([row(), row({ status: "same" })]))).toBe(false);
    // A newer one counts what each row replaces.
    expect(
      replacesNothing(plan([row({ replacing: 0 }), row({ status: "same", replacing: 0 })])),
    ).toBe(true);
    expect(replacesNothing(plan([row({ status: "same", replacing: 3 })]))).toBe(false);
    expect(
      replacesNothing(
        plan([row({ replacing: 0 })], {
          totals: {
            filesToMove: 1,
            bytesToMove: 1,
            bytesPresent: 0,
            decisionsNeeded: 0,
            replacing: 2,
          },
        }),
      ),
    ).toBe(false);
    expect(
      replacingCount(plan([row({ replacing: 1 }), row({ status: "same", replacing: 2 })])),
    ).toBe(3);
    expect(replacingCount(plan([row({ replacing: 1 }), row()]))).toBeNull();
    expect(
      replacingCount(
        plan([row()], {
          totals: {
            filesToMove: 1,
            bytesToMove: 1,
            bytesPresent: 0,
            decisionsNeeded: 0,
            replacing: 4,
          },
        }),
      ),
    ).toBe(4);
    // The reduced preview lists a "same" row that overwrites, or that might.
    expect(changedRows([row({ status: "same", replacing: 2 })])).toHaveLength(1);
    expect(changedRows([row({ status: "same" })])).toHaveLength(1);
    expect(
      changedRows([row({ status: "same", replacing: 0 }), row({ status: "only-here" })]),
    ).toHaveLength(0);
  });

  it("approves a Replace all plan only once nothing is open and the destination has room", () => {
    expect(replaceAllReady(plan([row({ status: "diverged", decision: "take-theirs" })]))).toBe(
      true,
    );
    expect(replaceAllReady(plan([row()], { disk: { needed: 2, free: 1 } }))).toBe(false);
    expect(
      replaceAllReady(
        plan([row()], {
          totals: { filesToMove: 1, bytesToMove: 1, bytesPresent: 0, decisionsNeeded: 1 },
        }),
      ),
    ).toBe(false);
    expect(replaceAllReady(plan([row()], { state: "scanning" }))).toBe(false);
  });

  it("says which secret-like files stayed on the source", () => {
    expect(secretsLeft([{ path: ".env" }, { path: "key.pem" }], [{ path: ".env" }])).toBe(1);
    expect(secretsLeft(null, [])).toBe(0);
    expect(secretsLeftText(2, "M4")).toBe(
      "2 secret-like files (.env and similar) stayed on M4. Copy them yourself, or run the copy again with “Let me choose file types first” to send them.",
    );
    expect(secretsLeftText(0, "M4")).toBeNull();
  });

  it("counts only what Replace all would still replace", () => {
    const conflicts = (decision: string | null) => [
      { id: "f1", path: "x", reason: "differs", choices: ["keep-mine", "take-theirs"], decision },
    ];
    const kept = [
      row({
        id: "repo:a",
        status: "dirty",
        choices: ["keep-mine", "take-theirs"],
        decision: "keep-mine",
      }),
      row({
        id: "files",
        kind: "files",
        status: "conflict",
        conflicts: conflicts("keep-mine"),
        moreConflicts: 4,
      }),
    ];
    // Every item keeps the destination's version: nothing left to replace.
    expect(replacementText(kept)).toBeNull();
    expect(replaceAllDecisions(kept)).toEqual({});
    const mixed = [
      row({
        id: "repo:a",
        status: "dirty",
        choices: ["keep-mine", "take-theirs"],
        decision: "keep-mine",
      }),
      row({ id: "repo:b", status: "dirty", choices: ["keep-mine", "take-theirs"] }),
      row({
        id: "files",
        kind: "files",
        status: "conflict",
        conflicts: conflicts(null),
        moreConflicts: 2,
      }),
    ];
    expect(replacementText(mixed)).toBe("3 files and 1 repository");
    // The person's own answers stay; only open items take the source version.
    expect(replaceAllDecisions(mixed)).toEqual({
      "repo:b": "take-theirs",
      "all:files": "take-theirs",
    });
  });

  it("counts replacements and answers them all with the source version", () => {
    const rows = [
      row({ status: "same", replacing: 0 }),
      row({ id: "repo:a", status: "dirty", choices: ["keep-mine", "take-theirs"] }),
      row({
        id: "files",
        kind: "files",
        status: "conflict",
        conflicts: [
          { id: "f1", path: "x", reason: "differs", choices: ["keep-mine", "take-theirs"] },
          { id: "f2", path: "y", reason: "type-differs", choices: ["keep-mine"] },
        ],
      }),
    ];
    expect(replacementText(rows)).toBe("1 file and 1 repository");
    expect(changedRows(rows)).toHaveLength(2);
    // Not every listed conflict can take the source version, so each one is answered alone.
    expect(replaceAllDecisions(rows)).toEqual({ "repo:a": "take-theirs", f1: "take-theirs" });
    expect(replacementText([row()])).toBeNull();
  });
});

describe("what Replace all sends", () => {
  const conflict = (
    id: string,
    decision: string | null,
    choices = ["keep-mine", "take-theirs"],
  ) => ({
    id,
    path: id,
    reason: "differs",
    choices,
    decision,
  });
  const files = (conflicts: unknown[], moreConflicts: number, needsDecision = true) =>
    row({
      id: "files",
      kind: "files",
      path: ".",
      status: "conflict",
      conflicts,
      moreConflicts,
      needsDecision,
    });

  it("does not count unlisted conflicts Replace all leaves open after one listed one was kept", () => {
    const rows = [files([conflict("kept", "keep-mine"), conflict("open", null)], 4)];
    // Replace all answers only the open listed conflict; no "all:" key goes out.
    expect(replaceAllDecisions(rows)).toEqual({ open: "take-theirs" });
    expect(replacementText(rows)).toBe("1 file");
    expect(replaceAllLeftText(rows)).toBe("4 more conflicts in Other files still need a choice.");
    expect(replaceAllOutcome(rows)).toBe("ask");
    const repo = [
      row({
        path: "app",
        status: "conflict",
        needsDecision: true,
        conflicts: [conflict("kept", "keep-mine"), conflict("open", null)],
        moreConflicts: 1,
      }),
    ];
    expect(replaceAllLeftText(repo, "Umbrella root")).toBe(
      "1 more conflict in app still needs a choice.",
    );
  });

  it("counts unlisted conflicts only when the row's one key answers them", () => {
    const open = [files([conflict("a", null), conflict("b", "take-theirs")], 3)];
    expect(replaceAllDecisions(open)).toEqual({ "all:files": "take-theirs" });
    expect(replacementText(open)).toBe("5 files");
    expect(replaceAllLeftText(open)).toBeNull();
    expect(replaceAllOutcome(open)).toBe("copy");
    // Every listed conflict kept through an "All" choice: the unlisted ones are kept too.
    const kept = [files([conflict("a", "keep-mine")], 3, false)];
    expect(replacementText(kept)).toBeNull();
    expect(replaceAllLeftText(kept)).toBeNull();
    // An "All: keep" answer, then one listed conflict switched back: nothing left open.
    const switched = [files([conflict("a", "keep-mine"), conflict("b", "take-theirs")], 3, false)];
    expect(replacementText(switched)).toBe("1 file");
    expect(replaceAllLeftText(switched)).toBeNull();
    expect(replaceAllOutcome(switched)).toBe("copy-kept");
  });

  it("counts unlisted conflicts as open while the row's own choice is open and no key covers them", () => {
    // Every listed conflict kept, the repository's own choice still open: Replace all answers
    // the repository but sends no "all:" key, so the unlisted conflicts stay open.
    const rows = [
      row({
        path: "app",
        status: "diverged",
        choices: ["keep-mine", "take-theirs"],
        decision: null,
        needsDecision: true,
        conflicts: [conflict("kept", "keep-mine")],
        moreConflicts: 2,
      }),
    ];
    expect(replaceAllDecisions(rows)).toEqual({ "repo:app": "take-theirs" });
    expect(replaceAllLeftText(rows)).toBe("2 more conflicts in app still need a choice.");
    expect(replaceAllOutcome(rows)).toBe("ask");
  });

  it("asks when an open item cannot take the source version", () => {
    expect(
      replaceAllOutcome([row({ status: "diverged", choices: ["keep-mine"], needsDecision: true })]),
    ).toBe("ask");
    expect(replaceAllOutcome([files([conflict("a", null, ["keep-mine"])], 0)])).toBe("ask");
    expect(
      replaceAllOutcome([row({ status: "dirty", choices: ["keep-mine", "take-theirs"] })]),
    ).toBe("copy");
  });
});

describe("problems after a copy", () => {
  it("names files changed while copying first, then failed checks", () => {
    const failed = (repo: string) => ({ repo, ok: false, problems: [] });
    expect(
      copyProblem({ unstable: [], checks: [{ repo: ".", ok: true, problems: [] }] }, "M4"),
    ).toBeNull();
    expect(copyProblem({ unstable: ["a.ts"], checks: [failed("app")] }, "M4")).toBe(
      "some files changed on M4 while copying",
    );
    expect(copyProblem({ unstable: [], checks: [failed(".")] }, "M4")).toBe(
      "the check of Root failed",
    );
    expect(copyProblem({ unstable: [], checks: [failed("a"), failed("b")] }, "M4")).toBe(
      "the checks of 2 repositories failed",
    );
  });
});

describe("grouped notices", () => {
  it("reads worktree names from an older source's notice and names the root", () => {
    const notices = groupCopyNotices({
      warnings: [
        "3 linked worktree(s) inside this folder are not copied: a, b and 1 more. Their committed branches are copied with the main repository; uncommitted changes in them stay on this machine.",
        "repos/x: 2 worktree(s) outside this folder are not copied: one, two. Copy those working folders separately to preserve their uncommitted changes.",
        "repos/y: this worktree will become an independent Git repository, preserving its branch, staged changes, history and stashes. Other working folders are not copied.",
        ".: something about the root",
      ],
      rootLabel: "Umbrella root",
    });
    expect(notices.worktrees).toEqual(["a", "b"]);
    expect(notices.outsideWorktrees).toEqual(["one (repos/x)", "two (repos/x)"]);
    expect(notices.separateRepositories).toEqual(["repos/y"]);
    expect(notices.lines).toEqual(["Umbrella root: something about the root"]);
  });

  it("keeps unchecked and stranded worktrees and the true totals from a newer source", () => {
    const notices = groupCopyNotices({
      skipped: {
        rebuildableFolders: 0,
        worktrees: ["a", "b"],
        dirtyWorktrees: ["a"],
        uncheckedWorktrees: ["b"],
        strandedWorktrees: ["c"],
        worktreeCount: 40,
        dirtyCount: 5,
      } as never,
      warnings: [],
      rootLabel: "Project root",
    });
    expect(notices).toMatchObject({
      uncheckedWorktrees: ["b"],
      strandedWorktrees: ["c"],
      worktreeCount: 40,
      dirtyCount: 5,
    });
    expect(hasNotCopied(notices)).toBe(true);
    expect(skippedWorktreeParts(notices, "M4")).toEqual([
      "5 worktrees with uncommitted changes stayed on M4",
      "1 worktree could not be checked and may hold uncommitted changes on M4",
      "1 worktree on M4 has commits on no branch that did not travel",
    ]);
    // An older source: counts come from the lists.
    const older = groupCopyNotices({
      skipped: { rebuildableFolders: 0, worktrees: ["a"], dirtyWorktrees: ["a"] },
      warnings: [],
      rootLabel: "Project root",
    });
    expect([older.worktreeCount, older.dirtyCount, older.uncheckedWorktrees]).toEqual([1, 1, []]);
  });

  it("says running work in plain words before Apply only, from any source version", () => {
    const warnings = [
      "Work is still running in this folder. You can copy now, but files may change during the copy and later edits are not included. Transferring coordinator context waits until this work stops.",
      "Work is still running here. Files that change during the copy won't be included, and the project moves once that work stops.",
    ];
    const lines = (activeWork: "copy-only" | "copy-and-move" | null) =>
      groupCopyNotices({ warnings, rootLabel: "Project root", activeWork }).lines;
    expect(lines("copy-and-move")).toEqual([
      "Work is still running here. Files that change during the copy won't be included, and the project moves once that work stops.",
    ]);
    expect(lines("copy-only")).toEqual([
      "Work is still running here. Files that change during the copy won't be included.",
    ]);
    // Copying started: Done and Failed never repeat it.
    expect(lines(null)).toEqual([]);
  });
});

describe("steps and what happens next", () => {
  const base = {
    auto: true,
    targetLabel: "ministorm",
    approveLabel: "Copy to ministorm",
    failedBeforeApply: false,
  };
  it("says what happens next only while choosing file types or after a copy stopped", () => {
    for (const stage of [
      "setup",
      "scanning",
      "planning",
      "preview",
      "copying",
      "moving",
      "done",
      "undone",
    ] as const)
      expect(nextStepText({ ...base, stage })).toBeNull();
    expect(nextStepText({ ...base, stage: "select", auto: false })).toBe(
      "Preview compares with ministorm's folder. Nothing is written until you approve.",
    );
    expect(nextStepText({ ...base, stage: "failed", held: true })).toContain(
      "Move anyway moves the coordinator with these differences.",
    );
  });

  it("says Retry before Apply starts the copy again from measuring", () => {
    const failed = { ...base, stage: "failed" as const, failedBeforeApply: true };
    expect(nextStepText(failed)).toBe(
      "Retry starts the copy again: it measures and compares again, then copies unless it needs you. Nothing on ministorm changed, so Stop copy leaves it as it was.",
    );
    expect(nextStepText({ ...failed, auto: false })).toBe(
      "Retry starts the copy again: it measures again, then you choose what to copy and preview it. Nothing on ministorm changed, so Stop copy leaves it as it was.",
    );
    // After Apply the destination resumes the same copy.
    expect(nextStepText({ ...failed, failedBeforeApply: false })).toBe(
      "Retry continues where the copy stopped.",
    );
  });

  const working = {
    targetLabel: "ministorm",
    measured: null,
    copy: null,
    recompare: null,
  } as const;
  it("shows one progress line: measuring, comparing, then copying with the size", () => {
    expect(workingLine({ ...working, stage: "scanning" })).toBe("Measuring…");
    expect(
      workingLine({ ...working, stage: "scanning", measured: { files: 1204, bytes: 3_000_000 } }),
    ).toBe("Measuring… 1,204 files, 3.0 MB");
    expect(workingLine({ ...working, stage: "planning" })).toBe("Comparing with ministorm…");
    expect(
      workingLine({
        ...working,
        stage: "copying",
        copy: {
          state: "transferring",
          progress: null,
          totals: {
            filesToMove: 1,
            bytesToMove: 1_200_000_000,
            bytesPresent: 0,
            decisionsNeeded: 0,
          },
        } as unknown as FolderCopyStatus,
      }),
    ).toBe("Copying 1.2 GB…");
    expect(workingLine({ ...working, stage: "copying" })).toBe("Copying…");
    expect(workingLine({ ...working, stage: "moving" })).toBe(
      "Starting the coordinator on ministorm…",
    );
    for (const stage of ["setup", "select", "preview", "done", "failed", "undone"] as const)
      expect(workingLine({ ...working, stage })).toBeNull();
  });

  it("promises copying on its own only for the first automatic compare", () => {
    const planning = { ...working, stage: "planning" as const };
    expect(workingLine({ ...planning, recompare: "choices" })).toBe(
      "Comparing again with your choices…",
    );
    expect(workingLine({ ...planning, recompare: "replace-all" })).toBe(
      "Comparing again, then copying with every conflict replaced…",
    );
    expect(workingLine({ ...planning, recompare: "replace-kept" })).toBe(
      "Comparing again, then copying with your choices kept and the rest replaced…",
    );
  });

  it("names what the source is doing while it builds the copy", () => {
    expect(
      sourceProgressText({ files: 10, bytes: 1_200_000_000, step: "git-snapshot" }, "M4"),
    ).toBe("Copying Git data on M4… 1.2 GB");
    expect(
      sourceProgressText(
        { files: 3, bytes: 3000, step: "hashing", totalFiles: 10, totalBytes: 10_000 },
        "M4",
      ),
    ).toBe("Reading the selected files on M4… 3 of 10 files, 3.0 KB of 10.0 KB");
    expect(sourceProgressText({ files: 1, bytes: 5 }, "M4")).toBe("Measuring… 1 file, 5 B");
  });
});
