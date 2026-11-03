import {
  formatStorageFreeSpace,
  type EnvironmentId,
  type StorageHomeUsage,
  type StorageStatusLevel,
} from "@specweave-studio/contracts";

import type { EnvironmentStorageStatus } from "../state/server";

export interface LowDiskSpaceNotice {
  /** Dismissal key: a dismissed `low` notice comes back if the disk turns critical. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly level: Exclude<StorageStatusLevel, "ok">;
  readonly title: string;
  readonly message: string;
  /** Set on app folder notices: the card offers a way to Storage settings. */
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

/** "worktrees 102 GB, database 23 GB, update backups 21 GB": the largest parts first. */
export function describeHomeUsageParts(usage: StorageHomeUsage, limit = 3): string {
  return usage.parts
    .slice(0, limit)
    .map((part) => `${homeUsagePartLabel(part.key)} ${formatStorageFreeSpace(part.bytes)}`)
    .join(", ");
}

function homeUsageNotice(
  usage: StorageHomeUsage,
  subject: string,
  appName: string,
): Pick<LowDiskSpaceNotice, "title" | "message"> | null {
  const total = formatStorageFreeSpace(usage.totalBytes);
  if (usage.level === "large")
    return {
      title: `${appName} folder is large`,
      // Sizes are allocated blocks, as du reports them: copy-on-write clones
      // (APFS worktree copies) count in full, so the disk can hold less.
      message: `The ${appName} folder on ${subject} takes ${total} (${describeHomeUsageParts(usage)}). Cloned files count in full, so the disk may hold less. Review storage to clean up what is safe.`,
    };
  if (usage.level === "growing") {
    const grown = usage.parts
      .filter((part) => part.grewBytes !== undefined)
      .map(
        (part) =>
          `${homeUsagePartLabel(part.key)} grew ${formatStorageFreeSpace(part.grewBytes ?? 0)}`,
      )
      .join(", ");
    return {
      title: `${appName} folder is growing fast`,
      message: `The ${appName} folder on ${subject} takes ${total}: ${grown} since the last check. Review storage to clean up what is safe.`,
    };
  }
  return null;
}

/**
 * One notice per machine whose disk is low, the primary environment first.
 * The primary environment is whichever host serves the page, so it reads as
 * "This Mac" only inside the desktop app, where that host is the machine in
 * front of the person. A browser or phone pointed at a machine names it, as
 * does every other machine.
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
    const primary = environmentId === input.primaryEnvironmentId;
    const local = primary && input.primaryIsThisMachine;
    const machine = os === "darwin" ? "Mac" : "computer";
    const named = (input.labelFor(environmentId)?.trim() ?? "") || "A connected machine";
    const subject = local ? `This ${machine}` : named;
    const key = `${environmentId}:${storage.level}`;
    if (storage.level !== "ok" && !input.dismissed.has(key)) {
      const free = formatStorageFreeSpace(storage.freeBytes);
      notices.push({
        key,
        environmentId,
        level: storage.level,
        primary,
        title: storage.level === "critical" ? "Disk space critically low" : "Low disk space",
        message: `${subject} is almost out of disk space (${free} free). ${input.appName}${
          local ? "" : " on it"
        } may stop responding until you free some space.`,
      });
    }
    // The app folder: a dismissed notice comes back when its level changes.
    const usage = storage.homeUsage;
    if (usage === undefined) continue;
    const homeKey = `${environmentId}:home-${usage.level}`;
    if (input.dismissed.has(homeKey)) continue;
    const home = homeUsageNotice(usage, local ? `this ${machine}` : named, input.appName);
    if (home !== null)
      notices.push({
        key: homeKey,
        environmentId,
        level: "low",
        primary,
        action: "review-storage",
        ...home,
      });
  }
  return notices
    .toSorted((left, right) => Number(right.primary) - Number(left.primary))
    .map(({ primary: _primary, ...notice }) => notice);
}
