// @effect-diagnostics nodeBuiltinImport:off - bounded native filesystem identification; no source contents or credentials are read.
import { execFile } from "node:child_process";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

/** The source filesystem cannot prove a captured copy; a moving copy falls back to live checks. */
export class CaptureFilesystemRefused extends Error {}
const unsupported = () =>
  new CaptureFilesystemRefused(
    "Captured copies need a supported local filesystem (APFS, ext4, XFS, Btrfs, tmpfs or local NTFS). This source filesystem could not be verified. Nothing was copied.",
  );
const run = (command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      {
        // A cold PowerShell start on a loaded Windows machine can take
        // seconds; the probe stays bounded well under any copy deadline.
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        ...(env ? { env } : {}),
      },
      (error, stdout) => (error ? reject(unsupported()) : resolve(stdout)),
    ),
  );

/** A closed set: a missing tool, network drive or unknown answer never enables captured copies. */
export async function verifyCaptureFilesystem(
  root: string,
  platform: NodeJS.Platform = process.platform,
  command: typeof run = run,
): Promise<void> {
  if (platform === "darwin") {
    const listing = await command("/bin/df", ["-P", root]);
    const device = listing.trim().split("\n").at(-1)?.trim().split(/\s+/)[0];
    if (!device || !/^\/dev\/disk\d+(?:s\d+)*$/.test(device)) throw unsupported();
    const info = await command("/usr/sbin/diskutil", ["info", "-plist", device]);
    if (!/<key>FilesystemType<\/key>\s*<string>apfs<\/string>/.test(info)) throw unsupported();
    return;
  }
  if (platform === "linux") {
    const type = (
      await command("findmnt", [
        "--target",
        root,
        "--noheadings",
        "--first-only",
        "--output",
        "FSTYPE",
      ])
    ).trim();
    if (!["ext4", "xfs", "btrfs", "tmpfs"].includes(type)) throw unsupported();
    return;
  }
  if (platform === "win32") {
    const drive = Path.win32.parse(root).root;
    if (!/^[A-Za-z]:\\$/.test(drive)) throw unsupported();
    // Only the validated drive letter crosses as data. The PowerShell program is constant.
    const script =
      "$ErrorActionPreference='Stop'; $d=[System.IO.DriveInfo]::new($env:SWC_CAPTURE_VOLUME); @{format=$d.DriveFormat; type=$d.DriveType.ToString(); ready=$d.IsReady} | ConvertTo-Json -Compress";
    const answer = JSON.parse(
      await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        ...process.env,
        SWC_CAPTURE_VOLUME: drive,
      }),
    ) as { format?: unknown; type?: unknown; ready?: unknown };
    if (
      answer.ready !== true ||
      answer.format !== "NTFS" ||
      !["Fixed", "Removable"].includes(String(answer.type))
    )
      throw unsupported();
    return;
  }
  throw unsupported();
}

/** Cache positive native admission; opened files must stay on that exact source device. */
export function sourceFilesystemAdmission(
  verify: (root: string) => Promise<void> = verifyCaptureFilesystem,
) {
  const roots = new Map<string, Promise<bigint>>();
  const devices = new Map<bigint, Promise<void>>();
  return async (root: string, device: bigint) => {
    let admitted = roots.get(root);
    if (!admitted) {
      admitted = (async () => {
        const before = await FSP.stat(root, { bigint: true });
        let verified = devices.get(before.dev);
        if (!verified) {
          verified = verify(root);
          devices.set(before.dev, verified);
        }
        await verified;
        const after = await FSP.stat(root, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino) throw unsupported();
        if (
          process.platform === "win32" &&
          (await FSP.stat(Path.parse(root).root, { bigint: true })).dev !== after.dev
        )
          throw unsupported();
        return after.dev;
      })();
      roots.set(root, admitted);
    }
    if ((await admitted) !== device)
      throw new CaptureFilesystemRefused(
        "This copy crosses a source filesystem boundary. Copy that mounted folder separately from a supported local filesystem.",
      );
  };
}

/** The timestamp proof depends on every ancestor device, even above the chosen source root. */
export async function admitAncestorDevices(
  ancestors: ReadonlyArray<{ readonly path: string; readonly stat: { readonly dev: bigint } }>,
  admit: ReturnType<typeof sourceFilesystemAdmission>,
): Promise<void> {
  const devices = new Set<bigint>();
  for (const { path, stat } of ancestors) {
    if (!devices.has(stat.dev)) await admit(path, stat.dev);
    devices.add(stat.dev);
  }
}
