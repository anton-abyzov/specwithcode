import type {
  StudioServiceUpdateRun,
  StudioServiceUpdateRunAppPhase,
  StudioServiceUpdateRunPhase,
} from "@specweave-studio/contracts";
import { compareSemverVersions, parseSemver } from "@specweave-studio/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * `updates/run.json`: the one record of an Update now press (0988).
 *
 * The main process creates it with O_EXCL, keyed by `runId`, so two windows
 * pressing at once make one run, and every window, a reload and a relaunched
 * app follow that run. The service's update agent claims it once config.json
 * names it, and owns it while it installs: it renews `leaseUntil` with a
 * heartbeat and is the only one that ends it as verified, failed or cancelled.
 * The main process ends only an unclaimed run (cancelled before the agent took
 * it) or an ownerless one long past its deadline (expired). `run-app.json`,
 * written only by the main process, carries the app install that follows a
 * verified service.
 *
 * Every write replaces the whole file, bumps `rev`, and never overwrites a
 * terminal record. This module is pure: file access comes in as `RunFiles`.
 */

export const RUN_FILE = "run.json";
export const CONFIG_FILE = "config.json";
export const RUN_APP_FILE = "run-app.json";
export const RUN_ARCHIVE_DIR = "runs";
export const INSTALL_PROGRESS_FILE = "install-progress.json";
export const INSTALL_MARKER_FILE = "install-in-progress.json";
/** Ended runs kept in `runs/`, newest first. */
export const RUN_ARCHIVE_KEEP = 5;

export const RUN_MIN_DEADLINE_MS = 10 * 60_000;
export const RUN_MAX_DEADLINE_MS = 30 * 60_000;
/** An ownerless run this long past its deadline, with no helper alive, is expired by main. */
export const RUN_OWNERLESS_GRACE_MS = 5 * 60_000;
/** No sign of life for this long shows the amber "no progress" line. */
export const RUN_NO_PROGRESS_MS = 120_000;
/**
 * A run still `preparing` this long after it was made has lost the window that
 * was stopping work for it (stop work 90 s, install request 30 s, and slack):
 * main ends it, since nothing else ever requests its install.
 */
export const RUN_PREPARING_LEASE_MS = 150_000;
/** Main kicks the agent again once the lease has lapsed this long... */
export const RUN_REKICK_LAPSE_MS = 10_000;
/** ...and at most this often. */
export const RUN_REKICK_EVERY_MS = 30_000;

export const RUN_TERMINAL_PHASES: ReadonlySet<StudioServiceUpdateRunPhase> = new Set([
  "verified",
  "failed",
  "cancelled",
  "expired",
]);
const RUN_PHASES: ReadonlySet<string> = new Set([
  "preparing",
  "requested",
  "downloading",
  "waiting",
  "installing",
  ...RUN_TERMINAL_PHASES,
]);
const APP_PHASES: ReadonlySet<string> = new Set([
  "waiting-for-service",
  "installing",
  "relaunching",
  "done",
  "failed",
]);

export interface UpdateRunOwner {
  readonly kind: "agent";
  readonly pid: number;
  readonly agentVersion: number | null;
  readonly claimedAt: string;
}

export interface UpdateRunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly rev: number;
  readonly createdAt: string;
  readonly createdBy: "desktop";
  readonly targetVersion: string;
  readonly fromVersion: string | null;
  readonly appTargetVersion: string | null;
  readonly requestedAt: string | null;
  readonly deadlineAt: string;
  readonly phase: StudioServiceUpdateRunPhase;
  readonly owner: UpdateRunOwner | null;
  readonly heartbeatAt: string | null;
  readonly leaseUntil: string | null;
  readonly message: string | null;
  readonly receipt: string | null;
  readonly endedAt: string | null;
}

export interface RunAppRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly appTargetVersion: string;
  readonly fromAppVersion: string;
  readonly appPhase: StudioServiceUpdateRunAppPhase;
  readonly attempts: number;
  readonly message: string | null;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly reportedAt: string | null;
  /** After a refusal: how long the next attempt waits from `updatedAt`. */
  readonly retryDelayMs?: number;
  /** After a refusal: the waits between attempts so far, against the refusal budget. */
  readonly retryWaitMs?: number;
}

/** What `update.py` writes to install-progress.json while it applies a release (0985). */
export interface InstallProgress {
  readonly version: string | null;
  readonly phase: string;
  readonly step: number;
  readonly steps: number;
  readonly phaseStartedAt: string | null;
  /** When the helper began: the current phase's start less the phases already timed. */
  readonly startedAt: string | null;
  readonly heartbeatAt: string | null;
  readonly expectedMs: number | null;
  readonly serviceRestartedAt: string | null;
  readonly result: string | null;
}

/** File access relative to the service's `updates` folder. */
export interface RunFiles {
  readonly read: (name: string) => string | null;
  readonly writeAtomic: (name: string, text: string) => void;
  /** Writes `name` only when it does not exist yet (O_EXCL); false when it does. */
  readonly createExclusive: (name: string, text: string) => boolean;
  readonly rename: (from: string, to: string) => void;
  readonly list: (directory: string) => ReadonlyArray<string>;
  readonly remove: (name: string) => void;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

export function isoMillis(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64 || !ISO_TIME.test(value)) return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: (time) => DateTime.toEpochMillis(time),
  });
}

export function isoAt(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

export const isValidRunId = (value: unknown): value is string =>
  typeof value === "string" && RUN_ID.test(value);

export const isTerminalRunPhase = (phase: StudioServiceUpdateRunPhase): boolean =>
  RUN_TERMINAL_PHASES.has(phase);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectOf(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseRun(text: string | null): UpdateRunRecord | null {
  const raw = objectOf(text);
  if (
    raw === null ||
    raw.schemaVersion !== 1 ||
    !isValidRunId(raw.runId) ||
    typeof raw.rev !== "number" ||
    typeof raw.phase !== "string" ||
    !RUN_PHASES.has(raw.phase) ||
    typeof raw.targetVersion !== "string" ||
    isoMillis(raw.createdAt) === null ||
    isoMillis(raw.deadlineAt) === null
  ) {
    return null;
  }
  const owner =
    typeof raw.owner === "object" && raw.owner !== null
      ? (raw.owner as Record<string, unknown>)
      : null;
  return {
    schemaVersion: 1,
    runId: raw.runId,
    rev: raw.rev,
    createdAt: raw.createdAt as string,
    createdBy: "desktop",
    targetVersion: raw.targetVersion,
    fromVersion: stringOrNull(raw.fromVersion),
    appTargetVersion: stringOrNull(raw.appTargetVersion),
    requestedAt: stringOrNull(raw.requestedAt),
    deadlineAt: raw.deadlineAt as string,
    phase: raw.phase as StudioServiceUpdateRunPhase,
    owner:
      owner !== null && typeof owner.pid === "number"
        ? {
            kind: "agent",
            pid: owner.pid,
            agentVersion: numberOrNull(owner.agentVersion),
            claimedAt: stringOrNull(owner.claimedAt) ?? "",
          }
        : null,
    heartbeatAt: stringOrNull(raw.heartbeatAt),
    leaseUntil: stringOrNull(raw.leaseUntil),
    message: stringOrNull(raw.message),
    receipt: stringOrNull(raw.receipt),
    endedAt: stringOrNull(raw.endedAt),
  };
}

export function parseRunApp(text: string | null): RunAppRecord | null {
  const raw = objectOf(text);
  if (
    raw === null ||
    raw.schemaVersion !== 1 ||
    !isValidRunId(raw.runId) ||
    typeof raw.appTargetVersion !== "string" ||
    typeof raw.appPhase !== "string" ||
    !APP_PHASES.has(raw.appPhase) ||
    isoMillis(raw.updatedAt) === null
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    runId: raw.runId,
    appTargetVersion: raw.appTargetVersion,
    fromAppVersion: stringOrNull(raw.fromAppVersion) ?? "",
    appPhase: raw.appPhase as StudioServiceUpdateRunAppPhase,
    attempts: typeof raw.attempts === "number" ? raw.attempts : 0,
    message: stringOrNull(raw.message),
    updatedAt: raw.updatedAt as string,
    finishedAt: stringOrNull(raw.finishedAt),
    reportedAt: stringOrNull(raw.reportedAt),
    ...(typeof raw.retryDelayMs === "number" && raw.retryDelayMs >= 0
      ? { retryDelayMs: raw.retryDelayMs }
      : {}),
    ...(typeof raw.retryWaitMs === "number" && raw.retryWaitMs >= 0
      ? { retryWaitMs: raw.retryWaitMs }
      : {}),
  };
}

export function parseInstallProgress(text: string | null): InstallProgress | null {
  const raw = objectOf(text);
  if (raw === null || raw.schemaVersion !== 1 || typeof raw.phase !== "string") return null;
  const step = numberOrNull(raw.step);
  const steps = numberOrNull(raw.steps);
  if (step === null || steps === null || step < 1 || steps < step) return null;
  const phaseStartedAt = stringOrNull(raw.phaseStartedAt);
  const phaseStart = isoMillis(phaseStartedAt);
  const timings =
    typeof raw.timings === "object" && raw.timings !== null && !Array.isArray(raw.timings)
      ? (raw.timings as Record<string, unknown>)
      : {};
  let timed = 0;
  for (const [name, value] of Object.entries(timings)) {
    if (name !== "total" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      timed += value;
    }
  }
  return {
    version: stringOrNull(raw.version),
    phase: raw.phase,
    step,
    steps,
    phaseStartedAt,
    startedAt: phaseStart === null ? null : isoAt(phaseStart - timed),
    heartbeatAt: stringOrNull(raw.heartbeatAt),
    expectedMs: numberOrNull(raw.expectedMs),
    serviceRestartedAt: stringOrNull(raw.serviceRestartedAt),
    result: stringOrNull(raw.result),
  };
}

/** createdAt + 3 x the last install's total, between 10 and 30 minutes; 30 when unknown. */
export function deadlineFor(createdMs: number, expectedMs: number | null): number {
  if (expectedMs === null || expectedMs <= 0) return createdMs + RUN_MAX_DEADLINE_MS;
  return createdMs + Math.min(RUN_MAX_DEADLINE_MS, Math.max(RUN_MIN_DEADLINE_MS, 3 * expectedMs));
}

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function archive(files: RunFiles, existing: UpdateRunRecord | null, nowMs: number) {
  const name = existing?.runId ?? `unreadable-${nowMs}`;
  files.rename(RUN_FILE, `${RUN_ARCHIVE_DIR}/${name}.json`);
  const kept = files
    .list(RUN_ARCHIVE_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => ({
      entry,
      at: isoMillis(parseRun(files.read(`${RUN_ARCHIVE_DIR}/${entry}`))?.createdAt) ?? 0,
    }))
    .sort((left, right) => right.at - left.at);
  for (const { entry } of kept.slice(RUN_ARCHIVE_KEEP)) {
    files.remove(`${RUN_ARCHIVE_DIR}/${entry}`);
  }
}

export interface CreateRunInput {
  readonly runId: string;
  readonly nowMs: number;
  readonly targetVersion: string;
  readonly fromVersion: string | null;
  readonly appTargetVersion: string | null;
  /** The last verified install's total, from install-progress.json; null when unknown. */
  readonly expectedMs: number | null;
}

/**
 * Creates the run, or answers the one still running. An ended run is moved to
 * `runs/` (the newest RUN_ARCHIVE_KEEP are kept) and a new one is created.
 */
export function createRun(
  files: RunFiles,
  input: CreateRunInput,
): { readonly created: boolean; readonly run: UpdateRunRecord } {
  const created = isoAt(input.nowMs);
  const run: UpdateRunRecord = {
    schemaVersion: 1,
    runId: input.runId,
    rev: 1,
    createdAt: created,
    createdBy: "desktop",
    targetVersion: input.targetVersion,
    fromVersion: input.fromVersion,
    appTargetVersion: input.appTargetVersion,
    requestedAt: null,
    deadlineAt: isoAt(deadlineFor(input.nowMs, input.expectedMs)),
    phase: "preparing",
    owner: null,
    heartbeatAt: null,
    leaseUntil: null,
    message: null,
    receipt: null,
    endedAt: null,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (files.createExclusive(RUN_FILE, serialize(run))) return { created: true, run };
    const existing = parseRun(files.read(RUN_FILE));
    if (existing !== null && !isTerminalRunPhase(existing.phase)) {
      return { created: false, run: existing };
    }
    archive(files, existing, input.nowMs);
  }
  throw new Error("The update run could not be created.");
}

export function readRun(files: RunFiles): UpdateRunRecord | null {
  return parseRun(files.read(RUN_FILE));
}

/**
 * Re-reads the run and applies `change` to it. Null, and nothing written, when
 * the run is gone, is another one, has ended, or `change` declines.
 */
export function transitionRun(
  files: RunFiles,
  runId: string,
  change: (run: UpdateRunRecord) => UpdateRunRecord | null,
): UpdateRunRecord | null {
  const current = readRun(files);
  if (current === null || current.runId !== runId || isTerminalRunPhase(current.phase)) {
    return null;
  }
  const next = change(current);
  if (next === null) return null;
  const written = { ...next, rev: current.rev + 1 };
  files.writeAtomic(RUN_FILE, serialize(written));
  return written;
}

export function readRunApp(files: RunFiles): RunAppRecord | null {
  return parseRunApp(files.read(RUN_APP_FILE));
}

export function writeRunApp(files: RunFiles, record: RunAppRecord): void {
  files.writeAtomic(RUN_APP_FILE, serialize(record));
}

/**
 * The helper's progress, only when it is for this run: its version, written
 * since the run began. The helper learns the version only after its first
 * phases (the before-read scan), so a record with no version yet counts for
 * a run the agent reports installing.
 */
export function progressForRun(
  run: UpdateRunRecord,
  progress: InstallProgress | null,
): InstallProgress | null {
  if (progress === null) return null;
  const versionless = progress.version === null && run.phase === "installing";
  if (progress.version !== run.targetVersion && !versionless) return null;
  const beat = isoMillis(progress.heartbeatAt);
  const created = isoMillis(run.createdAt);
  return beat !== null && created !== null && beat > created ? progress : null;
}

/** The app follow-up belonging to `run`, when the run asks for one. */
export function appForRun(run: UpdateRunRecord, app: RunAppRecord | null): RunAppRecord | null {
  return app !== null && app.runId === run.runId && run.appTargetVersion !== null ? app : null;
}

/** Nothing more happens for the run: the service is done and so is the app, when it needed one. */
export function runIsTerminal(run: UpdateRunRecord, app: RunAppRecord | null): boolean {
  if (!isTerminalRunPhase(run.phase)) return false;
  if (run.phase !== "verified" || run.appTargetVersion === null) return true;
  const own = appForRun(run, app);
  return own !== null && (own.appPhase === "done" || own.appPhase === "failed");
}

function latest(...values: ReadonlyArray<string | null | undefined>): string {
  let best: { readonly at: number; readonly text: string } | null = null;
  for (const value of values) {
    const at = isoMillis(value);
    if (at !== null && (best === null || at > best.at)) best = { at, text: value! };
  }
  return best?.text ?? "";
}

export function deriveRunView(input: {
  readonly run: UpdateRunRecord;
  readonly app: RunAppRecord | null;
  readonly progress: InstallProgress | null;
  readonly nowMs: number;
}): StudioServiceUpdateRun {
  const { run, nowMs } = input;
  const app = appForRun(run, input.app);
  const progress = progressForRun(run, input.progress);
  const terminal = runIsTerminal(run, app);
  const lastSignAt = latest(
    run.heartbeatAt,
    progress?.heartbeatAt,
    run.createdAt,
    app?.updatedAt,
    run.endedAt,
  );
  const lastSign = isoMillis(lastSignAt) ?? nowMs;
  const outcome: StudioServiceUpdateRun["outcome"] = !terminal
    ? null
    : run.phase === "verified"
      ? app?.appPhase === "failed"
        ? "failed"
        : "updated"
      : run.phase === "failed"
        ? "failed"
        : run.phase === "cancelled"
          ? "cancelled"
          : "expired";
  return {
    runId: run.runId,
    phase: run.phase,
    terminal,
    targetVersion: run.targetVersion,
    appTargetVersion: run.appTargetVersion,
    startedAt: run.createdAt,
    deadlineAt: run.deadlineAt,
    lastSignAt,
    noProgress: !terminal && nowMs - lastSign > RUN_NO_PROGRESS_MS,
    step:
      progress === null || terminal
        ? null
        : {
            label: progress.phase,
            i: progress.step,
            n: progress.steps,
            phaseStartedAt: progress.phaseStartedAt,
            startedAt: progress.startedAt,
            expectedMs: progress.expectedMs,
            serviceBack: progress.serviceRestartedAt !== null,
            result: progress.result,
          },
    app:
      app === null
        ? null
        : { phase: app.appPhase, message: app.message, finishedAt: app.finishedAt },
    message: app?.appPhase === "failed" ? app.message : run.message,
    outcome,
    endedAt: run.endedAt,
  };
}

function leaseLapsedAt(run: UpdateRunRecord): number | null {
  if (run.owner === null) {
    return isoMillis(run.leaseUntil) ?? isoMillis(run.requestedAt);
  }
  return isoMillis(run.leaseUntil);
}

/**
 * Main kicks the agent again for a run nobody holds: not ended, requested, its
 * lease lapsed over RUN_REKICK_LAPSE_MS ago, before its deadline, and not
 * kicked within RUN_REKICK_EVERY_MS. While the helper runs it keeps the pass
 * lock, so a kick then does nothing.
 */
export function shouldRekick(input: {
  readonly run: UpdateRunRecord;
  readonly nowMs: number;
  readonly lastKickMs: number | null;
}): boolean {
  const { run, nowMs } = input;
  if (isTerminalRunPhase(run.phase) || run.phase === "preparing" || run.requestedAt === null) {
    return false;
  }
  const deadline = isoMillis(run.deadlineAt);
  const lapsed = leaseLapsedAt(run);
  if (deadline === null || nowMs >= deadline || lapsed === null) return false;
  if (nowMs - lapsed <= RUN_REKICK_LAPSE_MS) return false;
  return input.lastKickMs === null || nowMs - input.lastKickMs >= RUN_REKICK_EVERY_MS;
}

/**
 * The only failure main declares: the run has no owner, is RUN_OWNERLESS_GRACE_MS
 * past its deadline, no helper heartbeat for it in RUN_NO_PROGRESS_MS, and no
 * install is marked in progress.
 */
export function shouldExpire(input: {
  readonly run: UpdateRunRecord;
  readonly progress: InstallProgress | null;
  readonly markerPresent: boolean;
  readonly nowMs: number;
}): boolean {
  const { run, nowMs } = input;
  if (isTerminalRunPhase(run.phase) || input.markerPresent) return false;
  const lease = isoMillis(run.leaseUntil);
  if (run.owner !== null && lease !== null && lease > nowMs) return false;
  const deadline = isoMillis(run.deadlineAt);
  if (deadline === null || nowMs <= deadline + RUN_OWNERLESS_GRACE_MS) return false;
  const progress = progressForRun(run, input.progress);
  const beat = isoMillis(progress?.heartbeatAt);
  return beat === null || nowMs - beat > RUN_NO_PROGRESS_MS;
}

/**
 * A `preparing` run whose window is gone: nobody owns it and nothing will
 * request its install. Either it is older than RUN_PREPARING_LEASE_MS, or it
 * was made before this process started (its window cannot have survived).
 */
export function preparingAbandoned(input: {
  readonly run: UpdateRunRecord;
  readonly nowMs: number;
  /** When this desktop process began following runs; null when unknown. */
  readonly processStartedMs: number | null;
  /** The run was made by this process. */
  readonly madeHere: boolean;
}): boolean {
  const { run, nowMs } = input;
  if (run.phase !== "preparing" || run.owner !== null || run.requestedAt !== null) return false;
  const created = isoMillis(run.createdAt);
  if (created === null) return false;
  if (nowMs - created > RUN_PREPARING_LEASE_MS) return true;
  return !input.madeHere && input.processStartedMs !== null && created < input.processStartedMs;
}

const versionAtLeast = (version: string, target: string): boolean => {
  if (parseSemver(version) === null || parseSemver(target) === null) return version === target;
  return compareSemverVersions(version, target) >= 0;
};

/**
 * The service already runs the run's target (state.json, or the helper's
 * verified result for this run) while nobody holds the run: an install that
 * outlived its agent pass, or a request written over by the fleet or the CLI.
 */
export function serviceReachedTarget(input: {
  readonly run: UpdateRunRecord;
  readonly installedVersion: string | null;
  readonly progress: InstallProgress | null;
  readonly markerPresent: boolean;
  readonly nowMs: number;
}): boolean {
  const { run, nowMs } = input;
  if (isTerminalRunPhase(run.phase) || run.requestedAt === null || input.markerPresent) {
    return false;
  }
  const lease = isoMillis(run.leaseUntil);
  if (run.owner !== null && lease !== null && lease > nowMs) return false;
  if (
    input.installedVersion !== null &&
    versionAtLeast(input.installedVersion, run.targetVersion)
  ) {
    return true;
  }
  const progress = progressForRun(run, input.progress);
  return progress !== null && progress.version !== null && progress.result === "verified";
}

/**
 * config.json still asks for this run's request. A cancel or an expiry writes
 * the config only then: a newer request written by the fleet, the CLI or
 * another press is never withdrawn on this run's behalf.
 */
export function configNamesRun(files: RunFiles, run: UpdateRunRecord): boolean {
  const config = objectOf(files.read(CONFIG_FILE));
  return (
    config !== null &&
    run.requestedAt !== null &&
    config.installRunId === run.runId &&
    config.installRequestedAt === run.requestedAt
  );
}

/** The run as windows see it, or null when there is none. */
export function readRunView(files: RunFiles, nowMs: number): StudioServiceUpdateRun | null {
  const run = readRun(files);
  if (run === null) return null;
  return deriveRunView({
    run,
    app: readRunApp(files),
    progress: parseInstallProgress(files.read(INSTALL_PROGRESS_FILE)),
    nowMs,
  });
}
