// Pure helpers for attaching the desktop app to a Studio server that already
// owns this machine's Studio home (normally the installed launchd/systemd
// service). Two servers on one `userdata` directory would both write the same
// SQLite store, so the desktop discovers the running owner and talks to it as
// its local environment instead of starting a second backend.

import { canonicalStudioPath } from "@specweave-studio/shared/studioIdentity";

export interface RunningServerRuntimeState {
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly serviceManaged: boolean;
}

/** Parses the `server-runtime.json` a live server writes next to its database. */
export function parseServerRuntimeState(text: string): RunningServerRuntimeState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { pid, port, origin } = record;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    typeof origin !== "string"
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { pid, port, origin: url.origin, serviceManaged: record.serviceManaged === true };
}

/**
 * A Studio home the fleet installer created under `~/.specwithcode/<identity>`
 * (or an unmigrated `~/.specweave-studio/<identity>`).
 */
export interface StudioInstallation {
  readonly identity: string;
  readonly studioHome: string;
  readonly stateDir: string;
  readonly serviceInstalled: boolean;
}

/**
 * Parses `<root>/<identity>/installation.json`, where `<root>` is `~/.specwithcode`
 * or an unmigrated `~/.specweave-studio`. The installed launchd service runs with its
 * own home (`STUDIO_HOME=<root>/<identity>`), so the desktop finds it here rather than
 * in the default home. A receipt that points anywhere but its own folder is ignored;
 * `canonical` maps a path recorded under a since-migrated legacy root to the branded one.
 */
export function parseStudioInstallation(
  text: string,
  expected: {
    readonly studioRoot: string;
    readonly directoryName: string;
    readonly join: (first: string, ...segments: string[]) => string;
    readonly canonical?: (path: string) => string;
  },
): StudioInstallation | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const studioHome = expected.join(expected.studioRoot, expected.directoryName);
  const stateDir = expected.join(studioHome, "userdata");
  // By default a receipt written under the legacy root before it became a link to the
  // branded root still describes the same folder.
  const userHome = expected.studioRoot.replace(/[\\/]+[^\\/]+[\\/]*$/, "");
  const canonical = expected.canonical ?? ((path: string) => canonicalStudioPath(path, userHome));
  if (
    record.schemaVersion !== 1 ||
    typeof record.studioHome !== "string" ||
    typeof record.stateDir !== "string" ||
    canonical(record.studioHome) !== canonical(studioHome) ||
    canonical(record.stateDir) !== canonical(stateDir)
  ) {
    return null;
  }
  const service = record.service as { readonly installed?: unknown } | null | undefined;
  return {
    identity: typeof record.identity === "string" ? record.identity : expected.directoryName,
    studioHome,
    stateDir,
    serviceInstalled: service?.installed === true,
  };
}

/**
 * Signal 0 delivers nothing; it reports whether the pid exists. EPERM means it
 * exists under another user, which still counts as alive.
 */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (target, signal) => process.kill(target, signal),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** Reads the one-time pairing token from `specweave-studio pair` output (JSON or text). */
export function parsePairToken(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { readonly token?: unknown };
      return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
    } catch {
      return null;
    }
  }
  const match = /^Token:\s*(\S+)\s*$/m.exec(stdout);
  return match?.[1] ?? null;
}

export interface ServiceCliCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Set when the command runs a script through a Node-compatible runtime. */
  readonly viaRuntime: boolean;
}

const SCRIPT_ENTRY = /\.(?:mjs|cjs|js)$/;
const MAX_WORDS_PER_PATH = 8;
const NODE_LIKE = /(?:^|[\\/])(?:node|node\.exe|electron|electron\.exe|Electron)$/;

/**
 * Turns a running server's command line into a command that runs the same
 * installation's CLI. Minting a pairing token through the owner's own build
 * keeps a newer desktop from writing an older server's database.
 *
 * `argv` is the process argument vector when the platform exposes it
 * NUL-separated (Linux `/proc/<pid>/cmdline`). On macOS only the joined
 * `ps` string exists, so `joinedArgs` is split on spaces and paths that
 * contain spaces are rebuilt with `exists`.
 */
export function resolveServiceCliCommand(input: {
  readonly argv?: ReadonlyArray<string>;
  readonly executable?: string;
  readonly joinedArgs?: string;
  readonly exists: (path: string) => boolean;
}): ServiceCliCommand | null {
  const argv =
    input.argv && input.argv.length > 0
      ? input.argv
      : input.joinedArgs !== undefined
        ? rebuildArgv(input.joinedArgs, input.executable, input.exists)
        : [];
  const executable = input.executable ?? argv[0];
  if (!executable || !input.exists(executable)) return null;

  if (NODE_LIKE.test(executable)) {
    const script = argv.slice(1).find((arg) => SCRIPT_ENTRY.test(arg) && input.exists(arg));
    return script ? { command: executable, args: [script], viaRuntime: true } : null;
  }
  return { command: executable, args: [], viaRuntime: false };
}

function rebuildArgv(
  joined: string,
  executable: string | undefined,
  exists: (path: string) => boolean,
): string[] {
  let rest = joined.trim();
  const argv: string[] = [];
  if (executable && rest.startsWith(executable)) {
    argv.push(executable);
    rest = rest.slice(executable.length).trim();
  }
  const words = rest.length > 0 ? rest.split(" ") : [];
  let index = 0;
  while (index < words.length) {
    // Prefer the longest run of words (a path with spaces) that names a file.
    let taken = 1;
    for (let count = Math.min(MAX_WORDS_PER_PATH, words.length - index); count > 1; count -= 1) {
      if (exists(words.slice(index, index + count).join(" "))) {
        taken = count;
        break;
      }
    }
    argv.push(words.slice(index, index + taken).join(" "));
    index += taken;
  }
  return argv;
}

export function buildPairArgs(input: { readonly baseDir: string; readonly label: string }) {
  return ["pair", "--base-dir", input.baseDir, "--ttl", "2m", "--label", input.label];
}
