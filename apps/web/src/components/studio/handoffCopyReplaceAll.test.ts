import type { FolderCopyStatus } from "@specweave-studio/contracts";
import { expect, it } from "vite-plus/test";
import { replaceAllPointer, replaceAllReady } from "./handoffCopyAuto";
import { copyStatus } from "./HandoffFolderCopy.testkit";

const ready = (overrides: Record<string, unknown> = {}) =>
  copyStatus("previewed", {
    totals: { filesToMove: 1, bytesToMove: 10, bytesPresent: 0, decisionsNeeded: 0 },
    ...overrides,
  }) as unknown as FolderCopyStatus;

it("does not let a Replace all click approve a plan another window mirrored", () => {
  const clicked = ready();
  const saved = replaceAllPointer(
    { operationId: clicked.operationId, environmentId: "m3" } as never,
    clicked,
  );
  expect(saved.replaceAll).toBe(true);
  expect(replaceAllReady(ready(), saved.replaceAllBasis)).toBe(true);
  expect(replaceAllReady(ready({ mirror: true }), saved.replaceAllBasis)).toBe(false);
  // A pointer saved before the click recorded its choices approves as before.
  expect(replaceAllReady(ready({ mirror: true }))).toBe(true);
});

const row = (first: string | null, second: string | null) => ({
  id: "repo",
  path: ".",
  status: "conflict",
  choices: [],
  decision: null,
  needsDecision: second === null,
  clone: false,
  cloneAvailable: false,
  moreConflicts: 0,
  conflicts: [
    { id: "a", path: "a.txt", reason: "differs", choices: ["keep-mine", "take-theirs"], decision: first },
    { id: "b", path: "b.txt", reason: "differs", choices: ["keep-mine", "take-theirs"], decision: second },
  ],
});

it("does not let a Replace all click approve a conflict choice another window made", () => {
  // The click saw Keep mine on a.txt and an open choice on b.txt.
  const clicked = ready({ rows: [row("keep-mine", null)] });
  const { replaceAllBasis: basis } = replaceAllPointer(
    { operationId: clicked.operationId, environmentId: "m3" } as never,
    clicked,
  );
  // The click's answer lands; a.txt keeps what was shown.
  expect(replaceAllReady(ready({ rows: [row("keep-mine", "take-theirs")] }), basis)).toBe(true);
  // Another window turned a.txt to Take theirs meanwhile.
  expect(replaceAllReady(ready({ rows: [row("take-theirs", "take-theirs")] }), basis)).toBe(false);
});
