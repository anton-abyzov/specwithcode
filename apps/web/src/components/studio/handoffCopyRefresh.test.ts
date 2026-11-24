import type { FolderCopySourceStatus } from "@specweave-studio/contracts";
import { expect, it, vi } from "vite-plus/test";
import { copyNoticeWarnings } from "./handoffCopyNotices";
import { refreshCopyScan } from "./handoffCopyScanRecovery";

const summary = (secrets: ReadonlyArray<string>, warnings: ReadonlyArray<string> = []) =>
  ({
    secretFiles: secrets.map((path) => ({ path, size: 10 })),
    warnings,
  }) as never;

const status = (saved: ReadonlyArray<string>, fresh: ReadonlyArray<string>) =>
  ({
    operationId: "op",
    state: "ready",
    summary: summary(saved),
    freshness: { checkedAt: 1, current: false, summary: summary(fresh) },
  }) as unknown as FolderCopySourceStatus;

it("hands Refresh's newly found secret files back to be left unticked", async () => {
  const added = vi.fn();
  const setSummary = vi.fn();
  await refreshCopyScan(
    async () => status([".env"], [".env", ".env.local"]),
    () => {},
    setSummary,
    added,
  );
  expect(added).toHaveBeenCalledWith([".env.local"]);
  // Unticked before the new list is shown, so no render ever offers it ticked.
  expect(added.mock.invocationCallOrder[0]).toBeLessThan(setSummary.mock.invocationCallOrder[0]!);
});

it("reports no new secret files when Refresh finds the same list", async () => {
  const added = vi.fn();
  await refreshCopyScan(
    async () => status([".env"], [".env"]),
    () => {},
    () => {},
    added,
  );
  expect(added).not.toHaveBeenCalled();
});

it("drops the saved missing-worktree notice once Refresh reports current inventory", () => {
  const missing =
    "repo: 1 missing worktree registration(s), not current folders: gone-wt. No registrations were removed.";
  const destination = "The destination folder already has files.";
  const fresh = summary([], []) as { warnings: ReadonlyArray<string> };
  expect(copyNoticeWarnings(fresh, { warnings: [missing, destination] }, true)).toEqual([
    destination,
  ]);
  // Without a refresh the saved notice stays.
  expect(copyNoticeWarnings(null, { warnings: [missing] }, false)).toEqual([missing]);
});
