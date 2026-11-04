import {
  formatStorageFreeSpace,
  type EnvironmentId,
  type StorageHomeUsage,
  type StorageStatusLevel,
} from "@specweave-studio/contracts";

import type { EnvironmentStorageStatus } from "../state/server";

export interface LowDiskSpaceNotice {
  /** Dismissal key per machine and level: a dismissed `low` notice comes back if the disk turns critical, or runs low again after recovering. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly level: Exclude<StorageStatusLevel, "ok">;
  readonly title: string;
  readonly message: string;
  /** Set when the notice names the app folder's parts: the card offers a way to Storage settings. */
  readonly action?: "review-storage";
}

const PART_LABELS: Readonly<Record<string, string>> = {
  worktrees: "worktrees",
  database: "database",
  backups: "update backups",
  scratch: "scratch folders",
  evidence: "evidence",
  release: "release builds",
  logs: "logs",
  other: "other",
};

/** A part key of an app folder measurement as people read it. */
export const homeUsagePartLabel = (key: string): string => PART_LABELS[key] ?? key;

/** Names the shown categories and explicitly accounts for any omitted bytes. */
export function describeHomeUsageParts(usage: StorageHomeUsage, limit = 3): string {
  const shown = usage.parts.slice(0, limit);
  const descriptions = shown.map(
    (part) => `${homeUsagePartLabel(part.key)} ${formatStorageFreeSpace(part.bytes)}`,
  );
  const remaining = usage.totalBytes - shown.reduce((sum, part) => sum + part.bytes, 0);
  if (remaining > 0) descriptions.push(`remaining categories ${formatStorageFreeSpace(remaining)}`);
  return descriptions.join(", ");
}

/** The app folder size and its largest parts, appended to a low disk notice. */
function describeHomeUsage(usage: StorageHomeUsage, appName: string): string {
  // A check that stopped early measured a lower bound. Sizes are allocated
  // blocks, as du reports them: copy-on-write clones (APFS worktree copies)
  // count in full, so cleaning them up can free less.
  const total = `${usage.complete ? "" : "at least "}${formatStorageFreeSpace(usage.totalBytes)}`;
  const parts = usage.parts.length === 0 ? "" : ` (${describeHomeUsageParts(usage)})`;
  return `The ${appName} folder takes ${total}${parts}, counting cloned files in full.`;
}

/**
 * Drops the dismissals of every machine whose disk has room again, so the
 * next time it runs low its notice shows. Returns the same set when nothing
 * changed.
 */
export function forgetRecoveredDismissals(
  dismissed: ReadonlySet<string>,
  statuses: ReadonlyArray<EnvironmentStorageStatus>,
): ReadonlySet<string> {
  const recovered = statuses
    .filter(({ storage }) => storage.level === "ok")
    .map(({ environmentId }) => `${environmentId}:`);
  const kept = [...dismissed].filter((key) => !recovered.some((prefix) => key.startsWith(prefix)));
  return kept.length === dismissed.size ? dismissed : new Set(kept);
}

/**
 * One notice per machine whose disk is actually running low, the primary
 * environment first. The app folder's size alone never raises a notice; it
 * stays in Settings > Storage. When a disk is low, its notice names the
 * folder's largest parts and offers Review storage, so each machine gets one
 * card, not two.
 *
 * The primary environment is whichever host serves the page, so it reads as
 * "This Mac" only inside the desktop app, where that host is the machine in
 * front of the person. A browser or phone pointed at a machine names it, as
 * does every other machine. Only the primary environment raises a `low`
 * notice; another connected machine raises one only when `critical`.
 */
export function resolveLowDiskSpaceNotices(input: {
  readonly statuses: ReadonlyArray<EnvironmentStorageStatus>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** Whether the primary environment runs on this device (the desktop app). */
  readonly primaryIsThisMachine: boolean;
  readonly labelFor: (environmentId: EnvironmentId) => string | undefined;
  readonly dismissed: ReadonlySet<string>;
  readonly appName: string;
}): ReadonlyArray<LowDiskSpaceNotice> {
  const notices: Array<LowDiskSpaceNotice & { readonly primary: boolean }> = [];
  for (const { environmentId, os, storage } of input.statuses) {
    if (storage.level === "ok") continue;
    const primary = environmentId === input.primaryEnvironmentId;
    if (!primary && storage.level !== "critical") continue;
    const key = `${environmentId}:${storage.level}`;
    if (input.dismissed.has(key)) continue;
    const local = primary && input.primaryIsThisMachine;
    const machine = os === "darwin" ? "Mac" : "computer";
    const named = (input.labelFor(environmentId)?.trim() ?? "") || "A connected machine";
    const subject = local ? `This ${machine}` : named;
    const free = formatStorageFreeSpace(storage.freeBytes);
    const usage = storage.homeUsage;
    const message = `${subject} is almost out of disk space (${free} free). ${input.appName}${
      local ? "" : " on it"
    } may stop responding until you free some space.`;
    notices.push({
      key,
      environmentId,
      level: storage.level,
      primary,
      title: storage.level === "critical" ? "Disk space critically low" : "Low disk space",
      ...(usage === undefined
        ? { message }
        : {
            message: `${message} ${describeHomeUsage(usage, input.appName)}`,
            action: "review-storage" as const,
          }),
    });
  }
  return notices
    .toSorted((left, right) => Number(right.primary) - Number(left.primary))
    .map(({ primary: _primary, ...notice }) => notice);
}
