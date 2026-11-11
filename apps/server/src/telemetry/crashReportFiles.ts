// @effect-diagnostics nodeBuiltinImport:off globalDate:off - fatal reports are written synchronously while the process dies, before or after Effect services exist.
/**
 * Synchronous crash report helpers shared by the process-level fatal hook in
 * `bin.ts`, the fatal tap on the server program and the {@link CrashReporter}
 * service.
 *
 * Files:
 * - `<STUDIO_HOME>/crash-install-id`: random UUIDv4 for this installation.
 *   The desktop app reads and writes the same file, so both surfaces report
 *   one install id. It is never an account id.
 * - `<stateDir>/crash-reports/pending-<epoch ms>-<rand>.json`: an already
 *   sanitized report written when the process dies. The next server start
 *   sends it and deletes it.
 *
 * Nothing here runs when reports are off (`STUDIO_CRASH_REPORTS=false` or the
 * `crashReportsEnabled` server setting is false): no network, no files.
 *
 * @module crashReportFiles
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildCrashReport,
  CRASH_REPORTS_ENV,
  crashReportMachineLabel,
  crashReportsEnabledFromEnv,
  type CrashReport,
  type CrashReportKind,
} from "@specweave-studio/shared/crashReport";
import { studioDefaultHome } from "@specweave-studio/shared/studioIdentity";

import packageJson from "../../package.json" with { type: "json" };

export const CRASH_INSTALL_ID_FILE = "crash-install-id";
export const PENDING_CRASH_REPORTS_DIR = "crash-reports";
export const MAX_PENDING_CRASH_REPORTS = 20;
export const PENDING_CRASH_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_CRASH_REPORT_PATTERN = /^pending-(\d{10,16})(?:-[a-z0-9]{1,12})?\.json$/u;

// The fatal hook runs outside any Effect runtime, so it reads the real host once here.
// oxlint-disable-next-line studio/no-global-process-runtime -- no Effect runtime in the fatal hook.
const HOST_PLATFORM: string = process.platform;
// oxlint-disable-next-line studio/no-global-process-runtime -- as above.
const HOST_ARCH: string = process.arch;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const crashInstallIdPath = (baseDir: string): string =>
  NodePath.join(baseDir, CRASH_INSTALL_ID_FILE);

export const pendingCrashReportsDir = (stateDir: string): string =>
  NodePath.join(stateDir, PENDING_CRASH_REPORTS_DIR);

function readInstallId(filePath: string): string | null {
  try {
    const value = NodeFS.readFileSync(filePath, "utf8").trim().toLowerCase();
    return UUID_V4_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reads the installation's crash report id, creating it on first use. The
 * exclusive create lets the desktop app and the server race safely: the
 * loser reads the winner's id. Returns null when the file cannot be written.
 */
export function readOrCreateCrashInstallId(baseDir: string): string | null {
  const filePath = crashInstallIdPath(baseDir);
  const existing = readInstallId(filePath);
  if (existing) return existing;
  const fresh = NodeCrypto.randomUUID();
  try {
    NodeFS.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(filePath, `${fresh}\n`, { flag: "wx", mode: 0o600 });
    return fresh;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      const raced = readInstallId(filePath);
      if (raced) return raced;
      // A corrupt file: replace it rather than reporting without an id.
      try {
        NodeFS.writeFileSync(filePath, `${fresh}\n`, { mode: 0o600 });
        return fresh;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function safeHostname(): string | null {
  try {
    return NodeOS.hostname();
  } catch {
    return null;
  }
}

/** `<os>-<arch>-<12 hex of sha256(hostname)>`; the hostname itself never leaves. */
export function serverCrashMachineLabel(): string {
  let hostname = "";
  try {
    hostname = NodeOS.hostname();
  } catch {
    hostname = "";
  }
  const hash = NodeCrypto.createHash("sha256").update(hostname).digest("hex");
  return crashReportMachineLabel(HOST_PLATFORM, HOST_ARCH, hash);
}

function safeOsRelease(): string | null {
  try {
    return NodeOS.release();
  } catch {
    return null;
  }
}

function safeHomeDir(): string | null {
  try {
    return NodeOS.homedir();
  } catch {
    return null;
  }
}

export interface ServerCrashReportInput {
  readonly installId: string;
  readonly kind: CrashReportKind;
  readonly category?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly error?: unknown;
  readonly detail?: Readonly<Record<string, unknown>> | null;
  readonly count?: number | null;
}

/** A sanitized server report: product metadata plus the sanitized error only. */
export function buildServerCrashReport(input: ServerCrashReportInput): CrashReport {
  return buildCrashReport({
    installId: input.installId,
    machine: serverCrashMachineLabel(),
    surface: "server",
    kind: input.kind,
    category: input.category ?? null,
    appVersion: packageJson.version,
    os: HOST_PLATFORM,
    osVersion: safeOsRelease(),
    arch: HOST_ARCH,
    provider: input.provider ?? null,
    model: input.model ?? null,
    error: input.error,
    detail: input.detail ?? null,
    count: input.count ?? null,
    homeDir: safeHomeDir(),
    hostname: safeHostname(),
  });
}

/**
 * Reads only `crashReportsEnabled` from `settings.json`. A missing or broken
 * file means the default, which is on; only an explicit `false` turns it off.
 */
export function settingsFileAllowsCrashReports(settingsPath: string): boolean {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(settingsPath, "utf8");
  } catch {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
    return (parsed as Record<string, unknown>).crashReportsEnabled !== false;
  } catch {
    // A file being rewritten may be cut short; fall back to the raw field.
    return !/"crashReportsEnabled"\s*:\s*false/u.test(raw);
  }
}

export function crashReportsEnabledSync(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly settingsPath: string;
}): boolean {
  return (
    crashReportsEnabledFromEnv(input.env[CRASH_REPORTS_ENV]) &&
    settingsFileAllowsCrashReports(input.settingsPath)
  );
}

/**
 * Writes one pending report for the next start to send. At most
 * {@link MAX_PENDING_CRASH_REPORTS} files wait at once; past that the new
 * report is dropped. Never throws.
 */
export function writePendingCrashReportSync(
  stateDir: string,
  report: CrashReport,
  now: number = Date.now(),
): boolean {
  try {
    const dir = pendingCrashReportsDir(stateDir);
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const waiting = NodeFS.readdirSync(dir).filter((name) =>
      PENDING_CRASH_REPORT_PATTERN.test(name),
    );
    if (waiting.length >= MAX_PENDING_CRASH_REPORTS) return false;
    const suffix = NodeCrypto.randomBytes(3).toString("hex");
    const filePath = NodePath.join(dir, `pending-${String(Math.trunc(now))}-${suffix}.json`);
    NodeFS.writeFileSync(filePath, JSON.stringify(report), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export interface CrashReportPaths {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly settingsPath: string;
}

function flagValue(argv: ReadonlyArray<string>, name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === `--${name}`) return argv[index + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(homeDir, value.slice(2));
  }
  return value;
}

/**
 * The same base and state folders `cli/config.ts` resolves, computed without
 * Effect so the fatal hook can run before the CLI loads: `--base-dir`, else
 * `STUDIO_HOME`, else the default home; state lives in `dev` for a dev server
 * without an explicit base folder and in `userdata` otherwise.
 */
export function resolveCrashReportPathsSync(input: {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}): CrashReportPaths {
  const explicit = flagValue(input.argv, "base-dir")?.trim();
  const fromEnv = input.env.STUDIO_HOME?.trim();
  const raw = explicit && explicit.length > 0 ? explicit : fromEnv;
  const baseDir =
    raw && raw.length > 0
      ? NodePath.resolve(expandHome(raw, input.homeDir))
      : studioDefaultHome(input.homeDir);
  const devUrl = flagValue(input.argv, "dev-url") ?? input.env.VITE_DEV_SERVER_URL;
  // Matches cli/config.ts: --base-dir and STUDIO_HOME are both explicit.
  const isDev = devUrl !== undefined && devUrl.trim().length > 0 && !(raw && raw.length > 0);
  const stateDir = NodePath.join(baseDir, isDev ? "dev" : "userdata");
  return { baseDir, stateDir, settingsPath: NodePath.join(stateDir, "settings.json") };
}

/**
 * Builds and stores a fatal report when reports are enabled. Synchronous so
 * it finishes before the process exits. Never throws.
 */
export function recordFatalCrashReportSync(input: {
  readonly kind: CrashReportKind;
  readonly error: unknown;
  readonly paths: CrashReportPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly category?: string;
}): boolean {
  try {
    if (!crashReportsEnabledSync({ env: input.env, settingsPath: input.paths.settingsPath })) {
      return false;
    }
    const installId = readOrCreateCrashInstallId(input.paths.baseDir);
    if (!installId) return false;
    const report = buildServerCrashReport({
      installId,
      kind: input.kind,
      category: input.category ?? input.kind,
      error: input.error,
    });
    return writePendingCrashReportSync(input.paths.stateDir, report);
  } catch {
    return false;
  }
}

let fatalMonitorInstalled = false;

/**
 * Stores a report for an uncaught exception or unhandled rejection that is
 * about to end the process. `uncaughtExceptionMonitor` only observes: Node
 * still crashes the process exactly as before, and no `unhandledRejection`
 * listener is added (see `provider/cursorSdk.ts`, which relies on counting
 * those listeners).
 */
export function installFatalCrashReportMonitor(
  proc: NodeJS.Process = process,
  homeDir: string = NodeOS.homedir(),
): void {
  if (fatalMonitorInstalled) return;
  fatalMonitorInstalled = true;
  proc.on("uncaughtExceptionMonitor", (error, origin) => {
    try {
      const paths = resolveCrashReportPathsSync({ argv: proc.argv, env: proc.env, homeDir });
      recordFatalCrashReportSync({
        kind: origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
        error,
        paths,
        env: proc.env,
      });
    } catch {
      // A crash report must never change how the process dies.
    }
  });
}
