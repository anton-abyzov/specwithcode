import type { FolderCopySourceStatus } from "@specweave-studio/contracts";
import { expect, it, vi } from "vite-plus/test";
import { copyNoticeWarnings } from "./handoffCopyNotices";
import { refreshCopyScan } from "./handoffCopyScanRecovery";
import { untickedSecrets } from "./handoffFolderCopyPending";

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

it("leaves Refresh's new secret out without ticking again one another window left out", () => {
  // Window B left .env out and saved it; window A still holds the older choice.
  const saved = { included: true, out: [".env"] };
  const stale = { included: true, out: [] };
  expect(untickedSecrets(saved, stale, [".env.local"])).toEqual({
    included: true,
    out: [".env", ".env.local"],
  });
  // Secrets left out entirely there stay out.
  expect(untickedSecrets({ included: false, out: [] }, stale, [".env.local"]).included).toBe(false);
  // Nothing saved yet: this window's own choice is the base.
  expect(untickedSecrets(null, { included: true, out: ["a"] }, ["b"])).toEqual({
    included: true,
    out: ["a", "b"],
  });
});
