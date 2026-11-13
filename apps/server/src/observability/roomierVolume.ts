// @effect-diagnostics nodeBuiltinImport:off - reads /proc/self/mounts and statfs directly.
/**
 * A Linux machine is often set up with a small system volume and a large
 * data volume (`/srv`, `/data`, a second disk). The app's folder lives in the
 * home folder on the small one by default, and agents fill it with worktrees,
 * builds and app versions. When this disk runs low, this finds a mounted
 * local volume with far more room so the low disk card can say where the
 * folder belongs. It only advises: nothing is moved.
 *
 * @module observability/roomierVolume
 */
import * as NodeFSP from "node:fs/promises";

import { statfsBytes, type StorageRoomierVolume } from "@specweave-studio/contracts";

/** Local file systems worth suggesting; network, overlay and pseudo file systems are not. */
const LOCAL_FILE_SYSTEMS = new Set(["ext4", "ext3", "xfs", "btrfs", "f2fs", "zfs", "bcachefs"]);
/** Mount points that are never a home for app data. */
const SYSTEM_PREFIXES = [
  "/boot",
  "/snap",
  "/run",
  "/proc",
  "/sys",
  "/dev",
  "/var/lib/docker",
  "/var/snap",
  "/tmp",
];
/** A suggestion needs at least this much free room, and this many times the current disk's. */
export const ROOMIER_MIN_FREE_BYTES = 100e9;
export const ROOMIER_FREE_RATIO = 3;
/** File systems with copy-on-write clones, which make worktree and folder copies nearly free. */
const CLONING_FILE_SYSTEMS = new Set(["xfs", "btrfs", "bcachefs", "zfs"]);

export interface MountEntry {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
}

/** `/proc/self/mounts` lines; octal escapes (`\040` for a space) decoded. */
export function parseMounts(text: string): ReadonlyArray<MountEntry> {
  const decode = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
  return text.split("\n").flatMap((line) => {
    const [device, mountPoint, fsType] = line.split(" ");
    return device === undefined || mountPoint === undefined || fsType === undefined
      ? []
      : [{ device: decode(device), mountPoint: decode(mountPoint), fsType }];
  });
}

/** The mount holding `path`: the longest mount point it lies under. */
export function mountOf(mounts: ReadonlyArray<MountEntry>, path: string): MountEntry | undefined {
  return mounts
    .filter(
      (mount) =>
        mount.mountPoint === "/" ||
        path === mount.mountPoint ||
        path.startsWith(`${mount.mountPoint}/`),
    )
    .toSorted((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
}

/** The best volume to suggest, or undefined when none has clearly more room. */
export function pickRoomierVolume(input: {
  readonly home: MountEntry;
  readonly homeFreeBytes: number;
  readonly candidates: ReadonlyArray<MountEntry & { readonly freeBytes: number }>;
}): StorageRoomierVolume | undefined {
  const best = input.candidates
    .filter(
      (candidate) =>
        LOCAL_FILE_SYSTEMS.has(candidate.fsType) &&
        candidate.device !== input.home.device &&
        candidate.mountPoint !== input.home.mountPoint &&
        !SYSTEM_PREFIXES.some(
          (prefix) =>
            candidate.mountPoint === prefix || candidate.mountPoint.startsWith(`${prefix}/`),
        ) &&
        candidate.freeBytes >= ROOMIER_MIN_FREE_BYTES &&
        candidate.freeBytes >= ROOMIER_FREE_RATIO * input.homeFreeBytes,
    )
    .toSorted((left, right) => right.freeBytes - left.freeBytes)[0];
  return best === undefined
    ? undefined
    : {
        path: best.mountPoint,
        freeBytes: best.freeBytes,
        fileSystem: best.fsType,
        clones: CLONING_FILE_SYSTEMS.has(best.fsType),
      };
}

const freeBytesOf = async (path: string) => {
  const stats = await NodeFSP.statfs(path, { bigint: true });
  return statfsBytes(stats.bavail, stats.bsize);
};

/** Reads the mounts and their free space. Undefined off Linux or on any read failure. */
export async function findRoomierVolume(input: {
  readonly platform: NodeJS.Platform;
  readonly dataDir: string;
  readonly homeFreeBytes: number;
  readonly mountsFile?: string;
}): Promise<StorageRoomierVolume | undefined> {
  if (input.platform !== "linux") return undefined;
  try {
    const mounts = parseMounts(
      await NodeFSP.readFile(input.mountsFile ?? "/proc/self/mounts", "utf8"),
    );
    const home = mountOf(mounts, await NodeFSP.realpath(input.dataDir));
    if (home === undefined) return undefined;
    const candidates = await Promise.all(
      mounts
        .filter((mount) => LOCAL_FILE_SYSTEMS.has(mount.fsType) && mount.device !== home.device)
        .map(async (mount) => ({
          ...mount,
          freeBytes: await freeBytesOf(mount.mountPoint).catch(() => 0),
        })),
    );
    return pickRoomierVolume({ home, homeFreeBytes: input.homeFreeBytes, candidates });
  } catch {
    return undefined;
  }
}
