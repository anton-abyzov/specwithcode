// @effect-diagnostics nodeBuiltinImport:off - crash capture runs inside process hooks that must read and write synchronously.
/**
 * Automatic crash reports from the desktop main process.
 *
 * On by default. Off when `STUDIO_CRASH_REPORTS=false` or when the server
 * settings file has `crashReportsEnabled: false`. When off, nothing is read
 * beyond the settings file, nothing is written and nothing is sent.
 *
 * Captured: main-process uncaught exceptions and unhandled rejections,
 * renderer and child process exits, and unexpected server child exits.
 * Reports carry product metadata and a sanitized error only (see
 * `@specweave-studio/shared/crashReport`). Sending is best effort: one short
 * attempt, no retry loop, never blocking startup or quit. An uncaught
 * exception is also written to a pending file so the next launch can send it
 * if this process dies first.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildCrashReport,
  crashReportEndpoint,
  crashReportFingerprint,
  crashReportMachineLabel,
  crashReportsEnabledFromEnv,
  encodeCrashReport,
  parseCrashReport,
  CRASH_REPORT_URL_ENV,
  CRASH_REPORTS_ENV,
  type CrashReport,
  type CrashReportKind,
} from "@specweave-studio/shared/crashReport";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { rendererSurfaceOf } from "./DesktopRendererHistory.ts";

/** File (under the Studio home base dir) shared with the server for the install id. */
export const CRASH_INSTALL_ID_FILE = "crash-install-id";
/** Pending reports live in `<logDir>/crash-reports/desktop-*.json`. */
export const CRASH_PENDING_DIR = "crash-reports";
export const CRASH_PENDING_PREFIX = "desktop-";
export const CRASH_REPORT_SELF_TEST_ENV = "STUDIO_CRASH_REPORT_SELF_TEST";

export const SEND_TIMEOUT = Duration.seconds(5);
export const SETTINGS_CACHE_MS = 30_000;
export const FOLD_WINDOW_MS = 10 * 60_000;
export const HOURLY_CAP = 20;
const HOUR_MS = 60 * 60_000;
const MAX_PENDING_FILES = 20;
const PENDING_MAX_AGE_MS = 7 * 24 * HOUR_MS;
const PENDING_FLUSH_DELAY = Duration.seconds(10);
const SELF_TEST_DELAY = Duration.seconds(3);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface DesktopCrashEvent {
  readonly kind: CrashReportKind;
  readonly category?: string;
  readonly error?: unknown;
  readonly detail?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly provider?: string;
  readonly model?: string;
}

export interface DesktopCrashReporterShape {
  /** Builds, folds and sends one report. Never fails; a no-op when reports are off. */
  readonly report: (event: DesktopCrashEvent) => Effect.Effect<void>;
  /** The server child exited without being asked to stop. */
  readonly reportServerExit: (input: {
    readonly reason: string;
    readonly instanceId?: string;
  }) => Effect.Effect<void>;
}

const noopReporter: DesktopCrashReporterShape = {
  report: () => Effect.void,
  reportServerExit: () => Effect.void,
};

/**
 * A reference with a no-op default, so modules that report (the backend
 * manager) need no extra requirement and their tests stay unchanged.
 */
export const DesktopCrashReporter = Context.Reference<DesktopCrashReporterShape>(
  "@specweave-studio/desktop/telemetry/DesktopCrashReporter",
  { defaultValue: () => noopReporter },
);

// ---------------------------------------------------------------------------
// Pure helpers

/** Folds repeats of one fingerprint and caps sends per hour. */
export class CrashReportLimiter {
  private readonly sentAt: number[] = [];
  private readonly byFingerprint = new Map<string, { lastSentAt: number; suppressed: number }>();
  private readonly foldWindowMs: number;
  private readonly hourlyCap: number;

  constructor(foldWindowMs = FOLD_WINDOW_MS, hourlyCap = HOURLY_CAP) {
    this.foldWindowMs = foldWindowMs;
    this.hourlyCap = hourlyCap;
  }

  /** Returns the count to send with, or null when this report is folded or capped. */
  admit(fingerprint: string, now: number): number | null {
    while (this.sentAt.length > 0 && now - this.sentAt[0]! >= HOUR_MS) this.sentAt.shift();
    const entry = this.byFingerprint.get(fingerprint);
    if (entry !== undefined && now - entry.lastSentAt < this.foldWindowMs) {
      entry.suppressed += 1;
      return null;
    }
    if (this.sentAt.length >= this.hourlyCap) {
      if (entry !== undefined) entry.suppressed += 1;
      else this.byFingerprint.set(fingerprint, { lastSentAt: -Infinity, suppressed: 1 });
      return null;
    }
    const count = 1 + (entry?.suppressed ?? 0);
    this.byFingerprint.set(fingerprint, { lastSentAt: now, suppressed: 0 });
    if (this.byFingerprint.size > 500) {
      const oldest = this.byFingerprint.keys().next().value;
      if (oldest !== undefined) this.byFingerprint.delete(oldest);
    }
    this.sentAt.push(now);
    return count;
  }
}

/** `code=N` becomes `exit_code_N`; a signal becomes its lowercase name. */
export function serverExitCategory(reason: string): string {
  const signal = /\b(SIG[A-Z0-9]{2,10})\b/u.exec(reason)?.[1];
  if (signal !== undefined) return signal.toLowerCase();
  const code = /code=(-?\d{1,6})/u.exec(reason)?.[1];
  if (code !== undefined) return `exit_code_${code}`;
  return "exit_unknown";
}

/** True when Node is told to crash on unhandled rejections; a listener would stop that. */
export function unhandledRejectionsThrow(
  execArgv: ReadonlyArray<string>,
  nodeOptions: string | undefined,
): boolean {
  const flags = [...execArgv, ...(nodeOptions ?? "").split(/\s+/u)];
  for (const flag of flags) {
    const mode = /^--unhandled-rejections=(.+)$/u.exec(flag)?.[1];
    if (mode !== undefined && mode !== "warn" && mode !== "none") return true;
  }
  return false;
}

/** Reads the server settings switch leniently: anything but an explicit `false` is on. */
export function readCrashReportsSetting(settingsPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>)["crashReportsEnabled"] !== false;
    }
    return true;
  } catch {
    return true;
  }
}

/** A pending report file, validated like the relay does; null when unreadable. */
export function readPendingReport(filePath: string): CrashReport | null {
  try {
    return parseCrashReport(JSON.parse(NodeFS.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function readInstallIdFile(filePath: string): string | null {
  try {
    const value = NodeFS.readFileSync(filePath, "utf8").trim().toLowerCase();
    return UUID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reads the random install id the server and desktop share, creating it when
 * missing. Creation links a fully written temp file into place, so a reader
 * never sees a partial id and two writers converge on the first one.
 */
export function readOrCreateInstallId(baseDir: string): string {
  const filePath = NodePath.join(baseDir, CRASH_INSTALL_ID_FILE);
  const existing = readInstallIdFile(filePath);
  if (existing !== null) return existing;
  const created = NodeCrypto.randomUUID();
  const tempPath = `${filePath}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    NodeFS.mkdirSync(baseDir, { recursive: true });
    NodeFS.writeFileSync(tempPath, `${created}\n`, { mode: 0o600 });
    try {
      NodeFS.linkSync(tempPath, filePath);
    } catch (error) {
      // EEXIST: another process won the race, or the file held garbage.
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        readInstallIdFile(filePath) === null
      ) {
        NodeFS.renameSync(tempPath, filePath);
      }
    }
  } catch {
    // Best effort: an unwritable home still gets a per-process id.
  } finally {
    try {
      NodeFS.rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
  }
  return readInstallIdFile(filePath) ?? created;
}

export function hostnameHash(hostname: string): string {
  return NodeCrypto.createHash("sha256").update(hostname).digest("hex");
}

// ---------------------------------------------------------------------------
// Service

export interface DesktopCrashReporterOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Studio home base dir; the server child gets the same dir as STUDIO_HOME. */
  readonly baseDir: string;
  readonly serverSettingsPath: string;
  readonly pendingDir: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly osVersion: string;
  readonly hostname: string;
  readonly homeDir: string;
  /** Where process hooks attach; tests pass an EventEmitter. */
  readonly processHooks?: NodeJS.EventEmitter | null;
  readonly execArgv?: ReadonlyArray<string>;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

interface PreparedReport {
  readonly report: CrashReport;
  readonly body: string;
}

export const makeWith = Effect.fn("DesktopCrashReporter.make")(function* (
  options: DesktopCrashReporterOptions,
): Effect.fn.Return<
  DesktopCrashReporterShape,
  never,
  HttpClient.HttpClient | ElectronApp.ElectronApp | Scope.Scope
> {
  const client = yield* HttpClient.HttpClient;
  const electronApp = yield* ElectronApp.ElectronApp;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const now = options.now ?? Date.now;
  const envEnabled = crashReportsEnabledFromEnv(options.env[CRASH_REPORTS_ENV]);
  const endpoint = crashReportEndpoint(options.env[CRASH_REPORT_URL_ENV]);
  const machine = crashReportMachineLabel(
    options.platform,
    options.arch,
    hostnameHash(options.hostname),
  );
  const limiter = new CrashReportLimiter();
  let settingCache: { readonly at: number; readonly value: boolean } | null = null;
  let installId: string | null = null;

  const enabled = (): boolean => {
    if (!envEnabled) return false;
    const at = now();
    if (settingCache === null || at - settingCache.at >= SETTINGS_CACHE_MS) {
      settingCache = { at, value: readCrashReportsSetting(options.serverSettingsPath) };
    }
    return settingCache.value;
  };

  /** Synchronous so process hooks can use it before the process may die. */
  const prepare = (event: DesktopCrashEvent): PreparedReport | null => {
    try {
      if (!enabled()) return null;
      installId ??= readOrCreateInstallId(options.baseDir);
      const detail: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(event.detail ?? {})) {
        if (value !== undefined) detail[key] = value;
      }
      const draft = buildCrashReport({
        installId,
        machine,
        surface: "desktop",
        kind: event.kind,
        category: event.category ?? null,
        appVersion: options.appVersion,
        os: options.platform,
        osVersion: options.osVersion,
        arch: options.arch,
        provider: event.provider ?? null,
        model: event.model ?? null,
        error: event.error,
        detail,
        homeDir: options.homeDir,
        hostname: options.hostname,
      });
      const count = limiter.admit(crashReportFingerprint(draft), now());
      if (count === null) return null;
      const report = count > 1 ? { ...draft, count } : draft;
      return { report, body: encodeCrashReport(report) };
    } catch {
      return null;
    }
  };

  const send = (body: string): Effect.Effect<boolean> =>
    client
      .execute(
        HttpClientRequest.post(endpoint).pipe(HttpClientRequest.bodyText(body, "application/json")),
      )
      .pipe(
        // Settled: accepted, or refused for good (4xx other than 429), so a
        // pending file is not resent on every launch.
        Effect.map(
          (response) =>
            (response.status >= 200 && response.status < 300) ||
            (response.status >= 400 && response.status < 500 && response.status !== 429),
        ),
        Effect.timeout(SEND_TIMEOUT),
        Effect.catchCause(() => Effect.succeed(false)),
      );

  const report = (event: DesktopCrashEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      const prepared = prepare(event);
      return prepared === null ? Effect.void : Effect.asVoid(send(prepared.body));
    }).pipe(Effect.ignoreCause);

  const reportDetached = (event: DesktopCrashEvent): void => {
    try {
      runFork(report(event));
    } catch {
      // ignore
    }
  };

  const pendingFiles = (): string[] => {
    try {
      return NodeFS.readdirSync(options.pendingDir)
        .filter((name) => name.startsWith(CRASH_PENDING_PREFIX) && name.endsWith(".json"))
        .sort();
    } catch {
      return [];
    }
  };

  const writePending = (body: string): string | null => {
    try {
      if (pendingFiles().length >= MAX_PENDING_FILES) return null;
      NodeFS.mkdirSync(options.pendingDir, { recursive: true });
      const name = `${CRASH_PENDING_PREFIX}${now()}-${NodeCrypto.randomBytes(4).toString("hex")}.json`;
      const filePath = NodePath.join(options.pendingDir, name);
      NodeFS.writeFileSync(`${filePath}.tmp`, body, { mode: 0o600 });
      NodeFS.renameSync(`${filePath}.tmp`, filePath);
      return filePath;
    } catch {
      return null;
    }
  };

  const removeFile = (filePath: string) =>
    Effect.sync(() => {
      try {
        NodeFS.rmSync(filePath, { force: true });
      } catch {
        // ignore
      }
    });

  /** Sends what an earlier run left behind. One attempt each; failures wait for the next launch. */
  const flushPending = Effect.gen(function* () {
    if (!enabled()) return;
    for (const name of pendingFiles()) {
      const filePath = NodePath.join(options.pendingDir, name);
      const stamp = Number(/^desktop-(\d+)-/u.exec(name)?.[1] ?? Number.NaN);
      const parsed = readPendingReport(filePath);
      if (parsed === null || !Number.isFinite(stamp) || now() - stamp > PENDING_MAX_AGE_MS) {
        yield* removeFile(filePath);
        continue;
      }
      const sent = yield* send(encodeCrashReport(parsed));
      if (sent) yield* removeFile(filePath);
    }
  }).pipe(Effect.ignoreCause);

  // Main-process uncaught exceptions. The monitor event never changes how
  // Electron handles the exception; it only observes it.
  const onUncaughtMonitor = (error: unknown, origin: unknown) => {
    const prepared = prepare({
      kind: origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
      category: typeof origin === "string" ? origin : "uncaughtException",
      error,
    });
    if (prepared === null) return;
    const pending = writePending(prepared.body);
    try {
      runFork(
        send(prepared.body).pipe(
          Effect.flatMap((sent) => (sent && pending !== null ? removeFile(pending) : Effect.void)),
        ),
      );
    } catch {
      // ignore
    }
  };

  // Electron's main process only warns on unhandled rejections. Adding a
  // listener silences Node's warning, so it is printed here instead.
  const warn =
    options.warn ??
    ((message: string) => process.emitWarning(message, "UnhandledPromiseRejectionWarning"));
  const onUnhandledRejection = (reason: unknown) => {
    try {
      const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      warn(`Unhandled promise rejection: ${text}`);
    } catch {
      // ignore
    }
    reportDetached({ kind: "unhandled_rejection", category: "unhandledRejection", error: reason });
  };

  const hooks = options.processHooks;
  if (hooks) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        hooks.on("uncaughtExceptionMonitor", onUncaughtMonitor);
        if (!unhandledRejectionsThrow(options.execArgv ?? [], options.env["NODE_OPTIONS"])) {
          hooks.on("unhandledRejection", onUnhandledRejection);
        }
      }),
      () =>
        Effect.sync(() => {
          hooks.removeListener("uncaughtExceptionMonitor", onUncaughtMonitor);
          hooks.removeListener("unhandledRejection", onUnhandledRejection);
        }),
    );
  }

  yield* electronApp.on<[Electron.Event, Electron.WebContents, Electron.RenderProcessGoneDetails]>(
    "render-process-gone",
    (_event, webContents, details) => {
      if (details.reason === "clean-exit") return;
      let surface: string | undefined;
      try {
        surface = rendererSurfaceOf(webContents) ?? webContents.getType();
      } catch {
        surface = undefined;
      }
      reportDetached({
        kind: "renderer_gone",
        category: details.reason,
        detail: { exitCode: details.exitCode, surface },
      });
    },
  );

  yield* electronApp.on<[Electron.Event, Electron.Details]>(
    "child-process-gone",
    (_event, details) => {
      if (details.reason === "clean-exit") return;
      reportDetached({
        kind: "child_process_gone",
        category: details.reason,
        detail: {
          type: details.type,
          exitCode: details.exitCode,
          serviceName: details.serviceName,
          name: details.name,
        },
      });
    },
  );

  if (envEnabled) {
    yield* Effect.sleep(PENDING_FLUSH_DELAY).pipe(Effect.andThen(flushPending), Effect.forkScoped);
  }
  if (options.env[CRASH_REPORT_SELF_TEST_ENV] === "1") {
    yield* Effect.sleep(SELF_TEST_DELAY).pipe(
      Effect.andThen(
        report({
          kind: "test",
          category: "self_test",
          error: new Error("Crash report self test"),
        }),
      ),
      Effect.forkScoped,
    );
  }

  return {
    report,
    reportServerExit: ({ reason, instanceId }) =>
      report({
        kind: "server_exit",
        category: serverExitCategory(reason),
        ...(instanceId === undefined ? {} : { detail: { instance: instanceId } }),
      }),
  } satisfies DesktopCrashReporterShape;
});

export const make = Effect.fn("DesktopCrashReporter.makeLive")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return yield* makeWith({
    env: process.env,
    baseDir: environment.baseDir,
    serverSettingsPath: environment.serverSettingsPath,
    pendingDir: NodePath.join(environment.logDir, CRASH_PENDING_DIR),
    appVersion: environment.appVersion,
    platform: environment.platform,
    arch: environment.processArch,
    osVersion: NodeOS.release(),
    hostname: NodeOS.hostname(),
    homeDir: environment.homeDirectory,
    processHooks: process,
    execArgv: process.execArgv,
  });
});

export const layer = Layer.effect(DesktopCrashReporter, make());
