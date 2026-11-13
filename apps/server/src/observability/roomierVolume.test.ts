import { describe, expect, it } from "vite-plus/test";

import { mountOf, parseMounts, pickRoomierVolume } from "./roomierVolume.ts";

// Ministorm on November 13, 2026: a 157 GB ext4 system volume and a 1.5 TB XFS work volume.
const MOUNTS = `/dev/mapper/ubuntu--vg-ubuntu--lv / ext4 rw,relatime 0 0
/dev/nvme0n1p6 /boot ext4 rw,relatime 0 0
/dev/nvme0n1p1 /boot/efi vfat rw 0 0
/dev/mapper/ubuntu--vg-work /srv xfs rw,noatime 0 0
/dev/loop1 /snap/blender/7998 squashfs ro 0 0
tmpfs /run tmpfs rw 0 0
server:/share /mnt/nas nfs rw 0 0
/dev/sdb1 /media/anton/My\\040Disk ext4 rw 0 0`;

describe("roomier volume", () => {
  const mounts = parseMounts(MOUNTS);
  const home = mountOf(mounts, "/home/anton/.specwithcode/ministorm/userdata")!;
  const free = (mountPoint: string, freeBytes: number) => ({
    ...mounts.find((mount) => mount.mountPoint === mountPoint)!,
    freeBytes,
  });

  it("finds the volume holding the app data, decoding escaped mount points", () => {
    expect(home.mountPoint).toBe("/");
    expect(mounts.at(-1)?.mountPoint).toBe("/media/anton/My Disk");
    expect(mountOf(mounts, "/srv/work/x")?.mountPoint).toBe("/srv");
  });

  it("suggests the large local volume and says it clones", () => {
    expect(
      pickRoomierVolume({
        home,
        homeFreeBytes: 4.4e9,
        candidates: [
          free("/srv", 1.4e12),
          free("/boot", 1.6e9),
          free("/media/anton/My Disk", 2e11),
        ],
      }),
    ).toEqual({ path: "/srv", freeBytes: 1.4e12, fileSystem: "xfs", clones: true });
  });

  it("never suggests system, network or snap mounts, or a volume without clearly more room", () => {
    expect(
      pickRoomierVolume({
        home,
        homeFreeBytes: 4.4e9,
        candidates: [free("/boot", 5e11), free("/mnt/nas", 9e12), free("/snap/blender/7998", 5e11)],
      }),
    ).toBeUndefined();
    expect(
      pickRoomierVolume({ home, homeFreeBytes: 80e9, candidates: [free("/srv", 200e9)] }),
    ).toBeUndefined();
    expect(
      pickRoomierVolume({ home, homeFreeBytes: 1e9, candidates: [free("/srv", 50e9)] }),
    ).toBeUndefined();
  });
});
