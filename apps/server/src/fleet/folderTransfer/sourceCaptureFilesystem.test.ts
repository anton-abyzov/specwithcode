// @effect-diagnostics nodeBuiltinImport:off - filesystem admission stubs never inspect real credentials.
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  sourceFilesystemAdmission,
  verifyCaptureFilesystem,
  admitAncestorDevices,
} from "./sourceCaptureFilesystem.ts";
it("admits only a positively identified APFS device", async () => {
  const command = vi
    .fn()
    .mockResolvedValueOnce("Filesystem blocks mounted\n/dev/disk3s5 10 /System/Volumes/Data\n")
    .mockResolvedValueOnce("<key>FilesystemType</key><string>apfs</string>");
  await expect(
    verifyCaptureFilesystem("/Users/fixture", "darwin", command),
  ).resolves.toBeUndefined();
  expect(command).toHaveBeenNthCalledWith(2, "/usr/sbin/diskutil", [
    "info",
    "-plist",
    "/dev/disk3s5",
  ]);
  await expect(
    verifyCaptureFilesystem(
      "/Volumes/share",
      "darwin",
      vi.fn().mockResolvedValue("Filesystem blocks mounted\nserver:/share 10 /Volumes/share"),
    ),
  ).rejects.toThrow(/supported local filesystem/);
});
it.each(["ext4", "xfs", "btrfs", "tmpfs"])("admits Linux %s", async (type) => {
  await expect(
    verifyCaptureFilesystem("/source", "linux", vi.fn().mockResolvedValue(type)),
  ).resolves.toBeUndefined();
});
it.each(["nfs", "cifs", "fuse.sshfs", "vfat", "exfat", "ext2", "ext3", "overlay", "", "unknown"])(
  "refuses Linux %s",
  async (type) => {
    await expect(
      verifyCaptureFilesystem("/source", "linux", vi.fn().mockResolvedValue(type)),
    ).rejects.toThrow(/supported local filesystem/);
  },
);
it("uses a constant PowerShell command and admits only ready local NTFS", async () => {
  const command = vi
    .fn()
    .mockResolvedValue(JSON.stringify({ format: "NTFS", type: "Fixed", ready: true }));
  await expect(verifyCaptureFilesystem("C:\\fixture", "win32", command)).resolves.toBeUndefined();
  expect(command.mock.calls[0]?.[2]?.SWC_CAPTURE_VOLUME).toBe("C:\\");
  expect(command.mock.calls[0]?.[1][3]).not.toContain("fixture");
  for (const answer of [
    { format: "NTFS", type: "Network", ready: true },
    { format: "FAT32", type: "Fixed", ready: true },
    { format: "NTFS", type: "Fixed", ready: false },
    {},
  ])
    await expect(
      verifyCaptureFilesystem(
        "C:\\fixture",
        "win32",
        vi.fn().mockResolvedValue(JSON.stringify(answer)),
      ),
    ).rejects.toThrow(/supported local filesystem/);
  const never = vi.fn();
  await expect(verifyCaptureFilesystem("\\\\server\\share", "win32", never)).rejects.toThrow(
    /supported local filesystem/,
  );
  expect(never).not.toHaveBeenCalled();
});
it("refuses unknown platforms and propagates unavailable admission instead of guessing", async () => {
  await expect(verifyCaptureFilesystem("/source", "freebsd", vi.fn())).rejects.toThrow(
    /supported local filesystem/,
  );
  await expect(
    verifyCaptureFilesystem(
      "/source",
      "linux",
      vi.fn().mockRejectedValue(new Error("missing probe")),
    ),
  ).rejects.toThrow("missing probe");
});
it("admits this real local fixture and rejects a different device", async () => {
  const root = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-local-fs-")));
  try {
    const device = (await FSP.stat(root, { bigint: true })).dev;
    const admit = sourceFilesystemAdmission();
    await expect(admit(root, device)).resolves.toBeUndefined();
    await expect(admit(root, device + 1n)).rejects.toThrow(/filesystem boundary/);
  } finally {
    await FSP.rm(root, { recursive: true, force: true });
  }
});

it("requires every ancestor device, including above the source, without duplicate probes", async () => {
  const ancestors = [
    { path: "/", stat: { dev: 1n } },
    { path: "/mount", stat: { dev: 2n } },
    { path: "/mount/source", stat: { dev: 3n } },
    { path: "/mount/source/nested", stat: { dev: 2n } },
  ];
  const admit = vi.fn().mockResolvedValue(undefined);
  await admitAncestorDevices(ancestors, admit);
  expect(admit.mock.calls).toEqual([
    ["/", 1n],
    ["/mount", 2n],
    ["/mount/source", 3n],
  ]);
  const unsupportedAncestor = vi.fn(async (_path: string, device: bigint) => {
    if (device === 2n) throw new Error("unsupported ancestor");
  });
  await expect(admitAncestorDevices(ancestors, unsupportedAncestor)).rejects.toThrow(
    "unsupported ancestor",
  );
  expect(unsupportedAncestor).toHaveBeenCalledTimes(2);
});
it("caches positive capability once per device across distinct roots", async () => {
  const root = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-device-cache-")));
  try {
    const child = Path.join(root, "child");
    await FSP.mkdir(child);
    const device = (await FSP.stat(root, { bigint: true })).dev;
    const verify = vi.fn(async () => {});
    const admit = sourceFilesystemAdmission(verify);
    await admit(root, device);
    await admit(child, device);
    expect(verify).toHaveBeenCalledTimes(1);
  } finally {
    await FSP.rm(root, { recursive: true, force: true });
  }
});
