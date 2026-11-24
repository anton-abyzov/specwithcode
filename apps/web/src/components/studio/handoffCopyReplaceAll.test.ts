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
