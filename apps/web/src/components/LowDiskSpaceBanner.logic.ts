import {
  formatStorageFreeSpace,
  type EnvironmentId,
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
    if (storage.level === "ok") continue;
    const key = `${environmentId}:${storage.level}`;
    if (input.dismissed.has(key)) continue;
    const primary = environmentId === input.primaryEnvironmentId;
    const local = primary && input.primaryIsThisMachine;
    const free = formatStorageFreeSpace(storage.freeBytes);
    const subject = local
      ? os === "darwin"
        ? "This Mac"
        : "This computer"
      : (input.labelFor(environmentId)?.trim() ?? "") || "A connected machine";
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
  return notices
    .toSorted((left, right) => Number(right.primary) - Number(left.primary))
    .map(({ primary: _primary, ...notice }) => notice);
}
