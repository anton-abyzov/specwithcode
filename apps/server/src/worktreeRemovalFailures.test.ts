// @effect-diagnostics nodeBuiltinImport:off - reads and writes one record file in a private temporary folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  describeRemovalFailure,
  leftBehind,
  openFileHolders,
  parseLsofHolders,
  REMOVAL_RETRY_AFTER_MS,
  removalFailureDetail,
  removalFailureStands,
  WORKTREE_REMOVAL_FAILURES_FILE,
  type WorktreeRemovalFailure,
  WorktreeRemovalFailures,
} from "./worktreeRemovalFailures.ts";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");

const failure = (overrides: Partial<WorktreeRemovalFailure> = {}): WorktreeRemovalFailure => ({
  folder: "/worktrees/app/feature",
  member: "the folder",
  at: new Date(NOW).toISOString(),
  what: "Git forgot the worktree but could not delete every file (Directory not empty): .DS_Store",
  holders: ["Finder (pid 412)"],
  removedBefore: 0,
  ...overrides,
});

const temporary: Array<string> = [];
const scratch = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "removal-failures-"));
  temporary.push(folder);
  return folder;
};

afterEach(() => {
  for (const folder of temporary.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

describe("worktree removal failures", () => {
  it("reads each process once from lsof field output", () => {
    expect(parseLsofHolders("p412\ncFinder\nfcwd\np412\ncFinder\np77\ncnode\np9\nc\n")).toEqual([
      "Finder (pid 412)",
      "node (pid 77)",
      "a process (pid 9)",
    ]);
    expect(parseLsofHolders("")).toEqual([]);
    expect(parseLsofHolders("pnot-a-pid\ncFinder\n")).toEqual([]);
  });

  it("does not ask which process holds a folder on Windows", async () => {
    expect(await openFileHolders("C:\\worktrees\\feature", "win32")).toBeNull();
  });

  it("says what Git did from what is left", () => {
    expect(describeRemovalFailure({ stillRegistered: true, left: ["src"] })).toBe(
      "Git refused and changed nothing (it found changed or new files, or a lock)",
    );
    expect(describeRemovalFailure({ stillRegistered: false, left: null })).toBe(
      "Git forgot the worktree and its files could not be listed",
    );
    expect(describeRemovalFailure({ stillRegistered: false, left: [] })).toBe(
      "Git forgot the worktree and left its empty folder",
    );
    expect(describeRemovalFailure({ stillRegistered: false, left: ["a", "b", "c", "d", "e"] })).toBe(
      "Git forgot the worktree but could not delete every file (Directory not empty): a, b, c and 2 more",
    );
  });

  it("lists what is left without reading into it", () => {
    const folder = scratch();
    NodeFS.writeFileSync(NodePath.join(folder, ".DS_Store"), "");
    NodeFS.mkdirSync(NodePath.join(folder, "apps"));
    expect(leftBehind(folder)).toEqual([".DS_Store", "apps"]);
    expect(leftBehind(NodePath.join(folder, "missing"))).toBeNull();
  });

  it("writes the sentence Settings shows, naming the holders and that nothing was forced", () => {
    expect(removalFailureDetail(failure())).toBe(
      "Git could not remove it (the folder): Git forgot the worktree but could not delete every file (Directory not empty): .DS_Store. Open in Finder (pid 412). It was left as it is; nothing was deleted by force.",
    );
    expect(removalFailureDetail(failure({ holders: null, removedBefore: 2 }))).toContain(
      "Which process holds it open is not known. 2 of its worktrees were removed before it.",
    );
    expect(removalFailureDetail(failure({ holders: [] }))).toContain(
      "No process holds a file open in it.",
    );
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `${name} (pid 1)`);
    expect(removalFailureDetail(failure({ holders: many }))).toContain("e (pid 1) and 2 more.");
  });

  it("stands while the registration is gone, and for six hours after a refusal", () => {
    const old = failure({ at: new Date(NOW - REMOVAL_RETRY_AFTER_MS).toISOString() });
    expect(removalFailureStands(old, { registrationBroken: true, now: NOW })).toBe(true);
    expect(removalFailureStands(old, { registrationBroken: false, now: NOW })).toBe(false);
    expect(removalFailureStands(failure(), { registrationBroken: false, now: NOW + 1 })).toBe(true);
    // A time that cannot be read, or one in the future, is never old.
    expect(
      removalFailureStands(failure({ at: "soon" }), { registrationBroken: false, now: NOW }),
    ).toBe(true);
    expect(
      removalFailureStands(failure({ at: new Date(NOW + 1).toISOString() }), {
        registrationBroken: false,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("keeps the record across restarts and forgets a folder that was cleared", () => {
    const stateDir = scratch();
    const first = new WorktreeRemovalFailures(stateDir);
    first.record("/real/feature", failure());
    first.record("/real/other", failure({ folder: "/worktrees/app/other" }));
    expect(new WorktreeRemovalFailures(stateDir).get("/real/feature")).toEqual(failure());

    first.clear("/real/feature");
    const again = new WorktreeRemovalFailures(stateDir);
    expect(again.get("/real/feature")).toBeUndefined();
    expect(again.get("/real/other")?.folder).toBe("/worktrees/app/other");
  });

  it("reads a record it cannot parse as empty, and skips entries of another shape", () => {
    const stateDir = scratch();
    const file = NodePath.join(stateDir, WORKTREE_REMOVAL_FAILURES_FILE);
    NodeFS.writeFileSync(file, "{not json");
    expect(new WorktreeRemovalFailures(stateDir).get("/real/feature")).toBeUndefined();

    NodeFS.writeFileSync(
      file,
      JSON.stringify({ failures: { "/real/feature": failure(), "/real/bad": { folder: 1 } } }),
    );
    const record = new WorktreeRemovalFailures(stateDir);
    expect(record.get("/real/feature")).toEqual(failure());
    expect(record.get("/real/bad")).toBeUndefined();
  });
});
