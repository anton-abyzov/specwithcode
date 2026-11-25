import type { FolderCopySourceStatus } from "@specweave-studio/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { copyNoticeWarnings } from "./handoffCopyNotices";
import { refreshCopyScan } from "./handoffCopyScanRecovery";
import {
  folderCopyStorageKey,
  recordExclusions,
  settledSecrets,
  untickedSecrets,
} from "./handoffFolderCopyPending";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps every window's exclusion in what leaves any window, whatever order their saves land in", () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const key = folderCopyStorageKey("env-a", "project-1");
  const stale = { included: true, out: [] };
  // Window B leaves .env out, then closes before hearing anything back.
  recordExclusions(key, stale, { included: true, out: [".env"] });
  // Window A, still on its stale choice, saves its whole pointer with Refresh's new exclusion.
  recordExclusions(key, stale, { included: true, out: [".env.local"] });
  localStorage.setItem(
    key,
    JSON.stringify({ operationId: "op", secrets: { included: true, out: [".env.local"] } }),
  );
  // What A sends, approves or compares again with still leaves .env out.
  expect(settledSecrets(key, { included: true, out: [".env.local"] })).toEqual({
    included: true,
    out: [".env.local", ".env"],
  });
  // A deliberate re-tick, in any window, takes it back in.
  recordExclusions(
    key,
    { included: true, out: [".env.local", ".env"] },
    { included: true, out: [".env.local"] },
  );
  expect(settledSecrets(key, { included: true, out: [".env.local"] }).out).toEqual([".env.local"]);
  // Leaving every secret out holds the same way, and turning them back on undoes it.
  recordExclusions(key, { included: true, out: [] }, { included: false, out: [] });
  expect(settledSecrets(key, { included: true, out: [] }).included).toBe(false);
  recordExclusions(key, { included: false, out: [] }, { included: true, out: [] });
  expect(settledSecrets(key, { included: true, out: [] }).included).toBe(true);
  // The record is never read as a copy left running.
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  expect(keys.filter((name) => name?.startsWith("specwithcode:folder-copy:"))).toEqual([key]);
});


it("lets Sync again with secrets override only what was left out before, and only on that copy", () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const key = folderCopyStorageKey("env-a", "project-1");
  const now = vi.spyOn(Date, "now");
  // Another window, on a copy to another machine, leaves .env.local out.
  now.mockReturnValue(1_000);
  recordExclusions(key, { included: true, out: [] }, { included: true, out: [".env.local"] });
  // The person asks for every secret on a fresh copy here.
  const again = { included: true, out: [], since: 2_000 };
  expect(settledSecrets(key, again).out).toEqual([]);
  // The other copy, without that request, still leaves it out.
  expect(settledSecrets(key, { included: true, out: [] }).out).toEqual([".env.local"]);
  // A file left out after the request stays out of the fresh copy too.
  now.mockReturnValue(3_000);
  recordExclusions(key, { included: true, out: [] }, { included: true, out: [".env"] });
  expect(settledSecrets(key, again).out).toEqual([".env"]);
  now.mockRestore();
});
