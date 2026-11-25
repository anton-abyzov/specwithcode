import type { FolderCopySourceStatus } from "@specweave-studio/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { copyNoticeWarnings } from "./handoffCopyNotices";
import { refreshCopyScan } from "./handoffCopyScanRecovery";
import {
  clearExclusions,
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

it("takes back only one window's own exclusions for one machine", () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const key = folderCopyStorageKey("env-a", "project-1");
  const none = { included: true, out: [] };
  recordExclusions(key, none, { included: false, out: [] }, "w1|machine-x");
  recordExclusions(key, none, { included: true, out: [".env.local"] }, "w3|machine-y");
  recordExclusions(key, none, { included: true, out: ["app.env"] }, "w1|machine-y");
  recordExclusions(key, none, { included: true, out: [".env.x"] }, "w2|machine-x");
  clearExclusions(key, (by) => by === "w1|machine-x" || by === "w1|");
  // Window 1's "secrets off" for machine X is gone; everything else stays recorded.
  expect(settledSecrets(key, none)).toEqual({
    included: true,
    out: [".env.local", ".env.x", "app.env"],
  });
});

it("keeps another owner's exclusion of the same file when one owner takes its own back", () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const key = folderCopyStorageKey("env-a", "project-1");
  const none = { included: true, out: [] };
  // B leaves .env.local out for machine Y; later A leaves the same file out for machine X.
  recordExclusions(key, none, { included: true, out: [".env.local"] }, "wb|machine-y");
  recordExclusions(key, none, { included: true, out: [".env.local"] }, "wa|machine-x");
  recordExclusions(key, none, { included: false, out: [] }, "wb|machine-y");
  recordExclusions(key, none, { included: false, out: [] }, "wa|machine-x");
  // A's Sync again with secrets on X takes back only A's notes.
  clearExclusions(key, (by) => by === "wa|machine-x");
  expect(settledSecrets(key, none)).toEqual({ included: false, out: [".env.local"] });
  // A person re-ticking the file, in any window, takes it back for every owner.
  recordExclusions(key, { included: true, out: [".env.local"] }, none, "wc|machine-y");
  expect(settledSecrets(key, none).out).toEqual([]);
});

it("keeps applying exclusions saved before owners were recorded", () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const key = folderCopyStorageKey("env-a", "project-1");
  const none = { included: true, out: [] };
  const prefix = "specwithcode:folder-copy-exclusion:env-a:project-1:";
  localStorage.setItem(`${prefix}file:.env.local`, "1");
  localStorage.setItem(`${prefix}off`, "wa|machine-x");
  expect(settledSecrets(key, none)).toEqual({ included: false, out: [".env.local"] });
  // No owner's Sync again with secrets takes them back.
  clearExclusions(key, (by) => by === "wa|machine-x");
  expect(settledSecrets(key, none)).toEqual({ included: false, out: [".env.local"] });
  // A re-tick and turning secrets on still do.
  recordExclusions(key, { included: false, out: [".env.local"] }, none, "wc|machine-y");
  expect(settledSecrets(key, none)).toEqual(none);
});
