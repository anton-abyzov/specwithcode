// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Roots the workspace search index must never walk.
 *
 * The index is native code (fff) that opens and reads every file under its
 * root, so two kinds of root are refused outright:
 *
 * - The filesystem root, the home folder or any folder above it. A walk of the
 *   home folder reaches `~/Library`, where FSKit mounts such as
 *   `Library/Developer/CoreDevice/DeviceFS` (a connected iPhone) can block a
 *   read in the kernel forever, and iCloud or network folders stall the same
 *   way. `~/Library` itself is refused on macOS for the same reason.
 * - Any root that holds the service's state folder. SQLite
 *   keeps its locks as POSIX locks, which the process loses as soon as any
 *   descriptor to the database file is closed, so a walk that opens and closes
 *   `statev2.sqlite` drops the live database's locks (see
 *   docs/operations/live-database.md). `liveDatabaseGuard.ts` only guards
 *   node:fs, never native readers.
 *
 * fff 0.9.4 has no ignore or exclude option for its walk, so refusing the
 * root is the supported way to keep it out of these folders: every folder
 * above them is refused, and an allowed root is always below them.
 *
 * Below an allowed root the walk skips only what `.gitignore`, `.ignore` and
 * `.git/info/exclude` name (0.11.0 is the same). A folder that is neither
 * tracked nor ignored, such as a clone left in an un-ignored `scratch/`, is
 * still walked on every scan; WorkspaceSearchRefresh only keeps changes in
 * such folders from starting one.
 */
export interface SearchRootGuardOptions {
  readonly homeDir?: string;
  /** The folder holding the live database (ServerConfig `stateDir`). */
  readonly stateDir?: string;
  readonly platform: NodeJS.Platform;
}

// macOS reaches every user folder twice: as `/Users/...` and through the data
// volume's firmlink, `/System/Volumes/Data/Users/...`.
const DARWIN_DATA_VOLUME = "/System/Volumes/Data";

function pathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function comparable(input: string, platform: NodeJS.Platform): string {
  const path = pathModule(platform);
  let resolved = path.resolve(input);
  if (platform === "darwin") {
    if (resolved === DARWIN_DATA_VOLUME) resolved = "/";
    else if (resolved.startsWith(`${DARWIN_DATA_VOLUME}/`)) {
      resolved = resolved.slice(DARWIN_DATA_VOLUME.length);
    }
  }
  // The default macOS and Windows filesystems ignore case.
  return platform === "darwin" || platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether `inner` is `outer` or sits below it; both already comparable. */
function isSameOrInside(inner: string, outer: string, platform: NodeJS.Platform): boolean {
  const relative = pathModule(platform).relative(outer, inner);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathModule(platform).sep}`) &&
      !pathModule(platform).isAbsolute(relative))
  );
}

/**
 * Why `root` must not be indexed, or undefined when it may be. Purely lexical:
 * callers that can resolve symlinks also check the real path (see
 * {@link unsafeSearchRootReasonResolved}).
 */
export function unsafeSearchRootReason(
  root: string,
  options: SearchRootGuardOptions,
): string | undefined {
  const platform = options.platform;
  const path = pathModule(platform);
  const candidate = comparable(root, platform);
  if (path.parse(candidate).root === candidate) {
    return "it is the filesystem root";
  }
  const homeDir = options.homeDir ?? NodeOS.homedir();
  if (homeDir) {
    const home = comparable(homeDir, platform);
    if (isSameOrInside(home, candidate, platform)) {
      return candidate === home ? "it is the home folder" : "it holds the home folder";
    }
    if (platform === "darwin" && isSameOrInside(candidate, path.join(home, "library"), platform)) {
      return "it is inside ~/Library, which holds device and cloud mounts that can block reads";
    }
  }
  if (options.stateDir) {
    const stateDir = comparable(options.stateDir, platform);
    // Folders inside it stay allowed: received machine-handoff worktrees live
    // there and are ordinary projects, and none of them holds the database.
    if (isSameOrInside(stateDir, candidate, platform)) {
      return "it holds the service's database folder";
    }
  }
  return undefined;
}

/**
 * {@link unsafeSearchRootReason} for the root as given and, when they
 * resolve, for the real paths of the root, home folder and state folder, so a
 * symlink cannot lead the index into a refused folder. A lexically refused
 * root is refused before anything is resolved.
 */
export async function unsafeSearchRootReasonResolved(
  root: string,
  options: SearchRootGuardOptions,
): Promise<string | undefined> {
  const lexical = unsafeSearchRootReason(root, options);
  if (lexical !== undefined) return lexical;
  const realpath = (input: string | undefined) =>
    input === undefined ? Promise.resolve(undefined) : NodeFSP.realpath(input).catch(() => input);
  const homeDir = options.homeDir ?? NodeOS.homedir();
  const [realRoot, realHome, realState] = await Promise.all([
    realpath(root),
    realpath(homeDir),
    realpath(options.stateDir),
  ]);
  return unsafeSearchRootReason(realRoot ?? root, {
    ...options,
    homeDir: realHome ?? homeDir,
    ...(realState !== undefined ? { stateDir: realState } : {}),
  });
}
