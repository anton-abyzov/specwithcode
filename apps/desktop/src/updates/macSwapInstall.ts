// @effect-diagnostics-next-line nodeBuiltinImport:off -- The detached native installer must preserve spawn, file-descriptor, and atomic swap semantics.
import { spawn, execFile } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The detached native installer must preserve spawn, file-descriptor, and atomic swap semantics.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The detached native installer must preserve spawn, file-descriptor, and atomic swap semantics.
import * as FS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The detached native installer must preserve spawn, file-descriptor, and atomic swap semantics.
import * as Path from "node:path";

/**
 * Installs a downloaded app bundle on macOS without Squirrel.Mac, which only
 * accepts updates whose code signature matches the running app. Unsigned
 * Studio builds instead download the release zip, check its sha512 against
 * the release's `latest-mac.yml`, unpack it next to the app and swap the
 * bundles after the app exits. Signed builds use electron-updater as usual.
 */

/** Launch Services' registration tool, used to forget a bundle path that no longer exists. */
export const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** `/Applications/Studio.app/Contents/MacOS/Studio` -> `/Applications/Studio.app` */
export function resolveRunningAppBundle(execPath: string): string | null {
  const bundle = Path.posix.resolve(execPath, "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

export function sha512Base64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = FS.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

function run(command: string, args: ReadonlyArray<string>, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

export interface BundleIdentity {
  readonly bundleId: string | null;
  readonly version: string | null;
}

export function parseBundleIdentity(plistJson: string): BundleIdentity {
  try {
    const value = JSON.parse(plistJson) as Record<string, unknown>;
    return {
      bundleId: typeof value.CFBundleIdentifier === "string" ? value.CFBundleIdentifier : null,
      version:
        typeof value.CFBundleShortVersionString === "string"
          ? value.CFBundleShortVersionString
          : null,
    };
  } catch {
    return { bundleId: null, version: null };
  }
}

export async function readBundleIdentity(bundle: string): Promise<BundleIdentity> {
  const plist = Path.join(bundle, "Contents", "Info.plist");
  return parseBundleIdentity(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
}

/**
 * Deletes a folder that may hold an app bundle. Inside Electron, `node:fs`
 * treats `.asar` files as folders, so `fs.rm` cannot delete a bundle: it
 * descends into `Contents/Resources/app.asar`, fails with ENOTEMPTY and leaves
 * the bundle half deleted. `/bin/rm` sees the archive as the plain file it is.
 */
export async function removeTree(target: string): Promise<void> {
  await run("/bin/rm", ["-rf", "--", target], 600_000);
}

/** Unpacks the zip with `ditto` (keeps symlinks and permissions) and returns the one `.app` inside. */
export async function unpackAppZip(zipPath: string, destination: string): Promise<string> {
  await removeTree(destination);
  await FS.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  await run("/usr/bin/ditto", ["-x", "-k", zipPath, destination], 600_000);
  const apps = (await FS.promises.readdir(destination)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1 || apps[0] === undefined) {
    throw new Error("The update archive does not contain exactly one app.");
  }
  const bundle = Path.join(destination, apps[0]);
  const stat = await FS.promises.lstat(bundle);
  if (!stat.isDirectory()) throw new Error("The update archive's app is not a folder.");
  return bundle;
}

/** Fails with a message the user can act on when the app cannot replace itself. */
export function assertReplaceable(currentBundle: string): void {
  if (currentBundle.includes("/AppTranslocation/")) {
    throw new Error(
      "macOS is running SpecWithCode from a temporary copy. Move the app into Applications and open it from there to get updates.",
    );
  }
  if (currentBundle.startsWith("/Volumes/")) {
    throw new Error(
      "SpecWithCode is running from the disk image. Copy it to Applications to get updates.",
    );
  }
  try {
    FS.accessSync(Path.dirname(currentBundle), FS.constants.W_OK);
    FS.accessSync(currentBundle, FS.constants.W_OK);
  } catch {
    throw new Error(
      `SpecWithCode cannot replace itself in ${Path.dirname(currentBundle)}. Move the app to a folder you can write to, such as Applications.`,
    );
  }
}

/**
 * Waits for the app to exit, moves the old bundle aside, moves the new one in
 * and only then deletes the old one. If the second move fails the old bundle
 * goes back, so a failed swap leaves the working app in place.
 *
 * The optional fifth argument puts the new bundle under another name in the
 * same folder, which moves an install off an earlier release's bundle name.
 * A name that is already taken falls back to replacing the bundle in place.
 */
export const SWAP_SCRIPT = `#!/bin/sh
set -u
pid="$1"; current="$2"; staged="$3"; relaunch="$4"; target="\${5:-$2}"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then exit 1; fi
  sleep 0.1
done
if [ "$target" != "$current" ] && { [ -e "$target" ] || [ -L "$target" ]; }; then
  target="$current"
fi
backup="$current.studio-update-old"
launch="$current"
rm -rf "$backup"
if mv "$current" "$backup"; then
  if mv "$staged" "$target"; then
    rm -rf "$backup"
    /usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
    launch="$target"
    if [ "$target" != "$current" ]; then
      ${JSON.stringify(LSREGISTER_PATH)} -u "$current" >/dev/null 2>&1 || true
    fi
  else
    mv "$backup" "$current"
  fi
fi
if [ "$relaunch" = "1" ]; then /usr/bin/open "$launch"; fi
`;

export function startDetachedSwap(input: {
  readonly scriptPath: string;
  readonly pid: number;
  readonly currentBundle: string;
  readonly stagedBundle: string;
  readonly relaunch: boolean;
  /** Where the new bundle goes; defaults to the current bundle's path. */
  readonly targetBundle?: string;
}): void {
  FS.writeFileSync(input.scriptPath, SWAP_SCRIPT, { mode: 0o700 });
  const child = spawn(
    "/bin/sh",
    [
      input.scriptPath,
      String(input.pid),
      input.currentBundle,
      input.stagedBundle,
      input.relaunch ? "1" : "0",
      input.targetBundle ?? input.currentBundle,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
