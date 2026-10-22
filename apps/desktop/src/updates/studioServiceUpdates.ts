import type {
  DesktopUpdateChannel,
  DesktopUpdatePreferences,
  StudioServicePendingInstall,
  StudioServiceUpdateRun,
  StudioServiceUpdateState,
  StudioServiceUpdateStatus,
} from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native launchd updater bootstrap owns subprocess and filesystem lifecycle outside the service runtime.
import { execFile } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native launchd updater bootstrap owns subprocess and filesystem lifecycle outside the service runtime.
import * as FS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native launchd updater bootstrap owns subprocess and filesystem lifecycle outside the service runtime.
import * as Path from "node:path";

import {
  canonicalStudioPath,
  LEGACY_STUDIO_HOME_DIRECTORY,
  STUDIO_HOME_DIRECTORY,
} from "@specweave-studio/shared/studioIdentity";

import { parseStudioInstallation } from "../backend/localServiceAttach.ts";
import { readRunView, type RunFiles } from "./updateRun.ts";

/**
 * Background updates of the fleet-installed Studio service on this Mac.
 *
 * The service cannot safely replace itself: launchd would stop the updater
 * together with the service. Each release instead ships a guarded upgrade
 * helper, and a small update agent (`scripts/studio-fleet/update_agent.py`)
 * runs beside the service as its own launchd job. It checks the release feed,
 * downloads and verifies the next release, waits for a quiet moment (no
 * session working, nothing new for a while) and then runs the release's own
 * helper. The desktop only installs the agent, writes its preferences to
 * `<studioHome>/updates/config.json` and reads `<studioHome>/updates/state.json`.
 */

export const SERVICE_AGENT_IDENTITIES = new Set(["m4", "m1", "m3"]);
export const SERVICE_AGENT_QUIET_MINUTES = 10;

export interface ManagedServiceInstallation {
  readonly identity: string;
  readonly studioHome: string;
  readonly version: string | null;
}

/** The fleet-installed services on this computer the agent knows how to update. */
export function findManagedServiceInstallations(
  homeDirectory: string,
  readDir: (path: string) => ReadonlyArray<string> = (path) => FS.readdirSync(path),
  readFile: (path: string) => string = (path) => FS.readFileSync(path, "utf8"),
): ReadonlyArray<ManagedServiceInstallation> {
  // Same order as the desktop's attach scan: the branded root first, then an
  // unmigrated legacy root. A migrated legacy root links to the branded one, so its
  // entries are the ones already found.
  const found: ManagedServiceInstallation[] = [];
  const seen = new Set<string>();
  for (const directory of [STUDIO_HOME_DIRECTORY, LEGACY_STUDIO_HOME_DIRECTORY]) {
    const studioRoot = Path.join(homeDirectory, directory);
    let names: ReadonlyArray<string>;
    try {
      names = readDir(studioRoot);
    } catch {
      continue;
    }
    for (const name of [...names].sort()) {
      if (!SERVICE_AGENT_IDENTITIES.has(name) || seen.has(name)) continue;
      let text: string;
      try {
        text = readFile(Path.join(studioRoot, name, "installation.json"));
      } catch {
        continue;
      }
      const installation = parseStudioInstallation(text, {
        studioRoot,
        directoryName: name,
        join: Path.join,
        canonical: (path) => canonicalStudioPath(path, homeDirectory),
      });
      if (installation === null || !installation.serviceInstalled) continue;
      if (installation.identity !== name) continue;
      let version: string | null = null;
      try {
        const record = JSON.parse(text) as { version?: unknown };
        version = typeof record.version === "string" ? record.version : null;
      } catch {
        version = null;
      }
      seen.add(name);
      found.push({ identity: name, studioHome: installation.studioHome, version });
    }
  }
  return found.sort((a, b) => a.identity.localeCompare(b.identity));
}

/**
 * How the agent handles an install request: `normal` waits for a quiet
 * service; `force` means the app has stopped and held the service's work, so
 * the agent retries its snapshot every few seconds until `installHoldUntil`.
 */
export type ServiceInstallMode = "normal" | "force";

export interface ServiceAgentConfig {
  readonly schemaVersion: 1;
  readonly checkAutomatically: boolean;
  readonly downloadInBackground: boolean;
  readonly installAutomatically: boolean;
  readonly channel: "stable" | "preview";
  readonly quietMinutes: number;
  readonly installRequestedAt: string | null;
  readonly checkRequestedAt: string | null;
  // Older agents ignore these three keys, so a forced request falls back to a
  // normal one there.
  readonly installMode: ServiceInstallMode;
  readonly installHoldUntil: string | null;
  readonly installCancelledAt: string | null;
  /**
   * The version the app showed for the pending request, when it knew one. The
   * agent installs only that version and only within
   * SERVICE_INSTALL_REQUEST_TTL_MS of `at`, which equals `installRequestedAt`.
   * Older agents ignore it and treat `installRequestedAt` as before.
   */
  readonly installRequest?: ServiceInstallRequestRecord | null;
  /**
   * The Update now run (updates/run.json) this request belongs to. An agent
   * with run support claims that run; older agents ignore the key.
   */
  readonly installRunId?: string | null;
  readonly repository?: string;
}

export interface ServiceInstallRequestRecord {
  readonly at: string;
  readonly version: string;
}

/** What an install request writes besides `installRequestedAt`. */
export interface ServiceInstallRequest {
  readonly mode: ServiceInstallMode;
  readonly holdUntil: string | null;
  /** The version the renderer showed; null from older renderers. */
  readonly version: string | null;
}

/**
 * An install request the agent has not started within this long lapses
 * (`update_request.py` REQUEST_TTL), so it never installs at a later idle moment.
 */
export const SERVICE_INSTALL_REQUEST_TTL_MS = 10 * 60_000;

const RELEASE_VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;

function releaseVersion(value: unknown): string | null {
  return typeof value === "string" && RELEASE_VERSION.test(value) ? value : null;
}

/** A forced install's hold may end at most this far ahead; later times are ignored. */
export const SERVICE_INSTALL_HOLD_LIMIT_MS = 30 * 60_000;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isoMillis(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64 || !ISO_TIME.test(value)) return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: (time) => DateTime.toEpochMillis(time),
  });
}

/**
 * Reads the renderer's install options. Anything unexpected is ignored rather
 * than refused: an older renderer sends nothing, and a malformed hold must not
 * stop the install. A hold time is kept only when it lies within the next 30
 * minutes, normalised to UTC.
 */
export function parseServiceInstallOptions(raw: unknown, nowMs: number): ServiceInstallRequest {
  if (typeof raw !== "object" || raw === null) {
    return { mode: "normal", holdUntil: null, version: null };
  }
  const record = raw as {
    readonly force?: unknown;
    readonly holdUntil?: unknown;
    readonly version?: unknown;
  };
  const version = releaseVersion(record.version);
  if (record.force !== true) return { mode: "normal", holdUntil: null, version };
  const until = isoMillis(record.holdUntil);
  const holdUntil =
    until !== null && until > nowMs && until <= nowMs + SERVICE_INSTALL_HOLD_LIMIT_MS
      ? DateTime.formatIso(DateTime.makeUnsafe(until))
      : null;
  return { mode: "force", holdUntil, version };
}

/**
 * Ties a request made at `at` to the version the renderer showed, or, from an
 * older renderer that sends none, to the one the agent offers (what Settings
 * showed). Null when no version is known: the agent then treats the request
 * as older desktops wrote it.
 */
export function serviceInstallRequestRecord(
  at: string,
  shownVersion: string | null,
  state: Pick<StudioServiceUpdateState, "downloadedVersion" | "availableVersion"> | null,
): ServiceInstallRequestRecord | null {
  const version =
    releaseVersion(shownVersion) ??
    releaseVersion(state?.downloadedVersion) ??
    releaseVersion(state?.availableVersion);
  return version === null ? null : { at, version };
}

function installRequestRecord(value: unknown): ServiceInstallRequestRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { readonly at?: unknown; readonly version?: unknown };
  const version = releaseVersion(record.version);
  return typeof record.at === "string" && isoMillis(record.at) !== null && version !== null
    ? { at: record.at, version }
    : null;
}

export const NO_AUTOMATIC_UPDATES = {
  checkAutomatically: false,
  downloadAutomatically: false,
  installAutomatically: false,
} as const;

/**
 * What actually runs: the saved switches when this build allows self-update,
 * otherwise all off, which is also what the service's agent config holds.
 */
export function effectiveUpdatePreferences(
  saved: DesktopUpdatePreferences,
  allowed: boolean,
): DesktopUpdatePreferences {
  return allowed
    ? {
        checkAutomatically: saved.checkAutomatically,
        downloadAutomatically: saved.downloadAutomatically,
        installAutomatically: saved.installAutomatically,
        automaticUpdatesAllowed: true,
        ...withForceInstallAfter(saved),
      }
    : { ...NO_AUTOMATIC_UPDATES, automaticUpdatesAllowed: false, ...withForceInstallAfter(saved) };
}

// How long a forced install waits applies whether or not self-update runs.
function withForceInstallAfter(saved: DesktopUpdatePreferences) {
  return saved.forceInstallAfterMinutes === undefined
    ? {}
    : { forceInstallAfterMinutes: saved.forceInstallAfterMinutes };
}

export function agentChannel(channel: DesktopUpdateChannel): "stable" | "preview" {
  return channel === "nightly" ? "preview" : "stable";
}

/** Fields one request changes in the agent config; the rest carry over. */
export interface ServiceAgentConfigChange {
  /** Null clears a pending request. */
  readonly installRequestedAt?: string | null;
  readonly checkRequestedAt?: string;
  readonly installMode?: ServiceInstallMode;
  readonly installHoldUntil?: string | null;
  readonly installCancelledAt?: string;
  /** Null clears it; a request without one is not tied to a version. */
  readonly installRequest?: ServiceInstallRequestRecord | null;
  /** Null clears it: a request outside a run must never be claimed for one. */
  readonly installRunId?: string | null;
}

function stringOrNullValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * What "Cancel update" writes. The request itself is cleared too: an agent
 * copy older than `installCancelledAt` still treats a set `installRequestedAt`
 * as pending and would install at its next quiet moment.
 */
export function cancelServiceInstallChange(at: string): ServiceAgentConfigChange {
  return {
    installRequestedAt: null,
    installCancelledAt: at,
    installMode: "normal",
    installHoldUntil: null,
    installRequest: null,
    installRunId: null,
  };
}

/**
 * A forced install is pending and its hold has not passed: the app quit or
 * restarted before the agent was started for it, so start it now.
 */
export function hasPendingForcedInstall(configText: string | null, nowMs: number): boolean {
  if (configText === null) return false;
  let config: Partial<ServiceAgentConfig> | null;
  try {
    config = JSON.parse(configText) as Partial<ServiceAgentConfig> | null;
  } catch {
    return false;
  }
  if (config?.installMode !== "force") return false;
  const requested = isoMillis(config.installRequestedAt);
  const holdUntil = isoMillis(config.installHoldUntil);
  const cancelled = isoMillis(config.installCancelledAt);
  // The agent lets a request tied to a version lapse; starting it for one would do nothing.
  const bound = installRequestRecord(config.installRequest);
  const lapsed =
    bound !== null &&
    bound.at === config.installRequestedAt &&
    requested !== null &&
    nowMs - requested > SERVICE_INSTALL_REQUEST_TTL_MS;
  return (
    requested !== null &&
    holdUntil !== null &&
    holdUntil > nowMs &&
    !lapsed &&
    (cancelled === null || cancelled <= requested)
  );
}

export function buildServiceAgentConfig(
  input: {
    readonly previous: Partial<ServiceAgentConfig> | null;
    readonly preferences: DesktopUpdatePreferences;
    readonly channel: DesktopUpdateChannel;
  } & ServiceAgentConfigChange,
): ServiceAgentConfig {
  const previous = input.previous ?? {};
  return {
    schemaVersion: 1,
    checkAutomatically: input.preferences.checkAutomatically,
    downloadInBackground: input.preferences.downloadAutomatically,
    installAutomatically: input.preferences.installAutomatically,
    channel: agentChannel(input.channel),
    quietMinutes:
      typeof previous.quietMinutes === "number" && previous.quietMinutes >= 1
        ? previous.quietMinutes
        : SERVICE_AGENT_QUIET_MINUTES,
    installRequestedAt:
      input.installRequestedAt !== undefined
        ? input.installRequestedAt
        : stringOrNullValue(previous.installRequestedAt),
    checkRequestedAt: input.checkRequestedAt ?? previous.checkRequestedAt ?? null,
    installMode: input.installMode ?? (previous.installMode === "force" ? "force" : "normal"),
    installHoldUntil:
      input.installHoldUntil !== undefined
        ? input.installHoldUntil
        : stringOrNullValue(previous.installHoldUntil),
    installCancelledAt: input.installCancelledAt ?? stringOrNullValue(previous.installCancelledAt),
    installRequest:
      input.installRequest !== undefined
        ? input.installRequest
        : installRequestRecord(previous.installRequest),
    ...runIdField(input.installRunId, previous.installRunId),
    ...(typeof previous.repository === "string" ? { repository: previous.repository } : {}),
  };
}

/**
 * `installRunId` only once a run has used it: a config written outside runs
 * stays exactly as before them. A request outside a run clears a stale id.
 */
function runIdField(
  change: string | null | undefined,
  previous: unknown,
): { readonly installRunId?: string | null } {
  const kept =
    typeof previous === "string" && /^[A-Za-z0-9-]{1,64}$/.test(previous) ? previous : null;
  const value = change !== undefined ? change : kept;
  return value !== null || previous !== undefined ? { installRunId: value } : {};
}

const AGENT_STATUSES = new Set<StudioServiceUpdateStatus>([
  "disabled",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installing",
  "installed",
  "manual-required",
  "error",
]);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function automaticChecksOff(configText: string | null | undefined): boolean {
  if (!configText) return false;
  try {
    const config = JSON.parse(configText) as Partial<ServiceAgentConfig> | null;
    return config?.checkAutomatically === false;
  } catch {
    return false;
  }
}

/**
 * The install request in the agent's config that it has not finished, by the
 * agent's own rules: a cancelled request is gone, and one tied to a version
 * lapses unstarted after SERVICE_INSTALL_REQUEST_TTL_MS. The agent applies
 * that lapse only when a pass starts, so a forced request the pass it started
 * keeps retrying stays pending until its hold ends. One the agent took up
 * (`handledInstallRequestAt`) stays pending only while it installs; after that
 * the agent's `lastInstall` is the answer.
 */
export function pendingServiceInstall(input: {
  readonly configText: string | null | undefined;
  readonly handledAt: unknown;
  readonly status: StudioServiceUpdateStatus;
  readonly nowMs: number;
}): StudioServicePendingInstall | null {
  if (!input.configText) return null;
  let config: Partial<ServiceAgentConfig> | null;
  try {
    config = JSON.parse(input.configText) as Partial<ServiceAgentConfig> | null;
  } catch {
    return null;
  }
  const requestedAt = config?.installRequestedAt;
  const requested = isoMillis(requestedAt);
  if (config === null || typeof requestedAt !== "string" || requested === null) return null;
  const cancelled = isoMillis(config.installCancelledAt);
  if (cancelled !== null && cancelled > requested) return null;
  const handled = input.handledAt === requestedAt;
  if (handled && input.status !== "installing") return null;
  const bound = installRequestRecord(config.installRequest);
  const version = bound !== null && bound.at === requestedAt ? bound.version : null;
  const mode: ServiceInstallMode = config.installMode === "force" ? "force" : "normal";
  const holdUntil = mode === "force" ? stringOrNullValue(config.installHoldUntil) : null;
  if (!handled && version !== null) {
    const servedUntil = Math.max(
      requested + SERVICE_INSTALL_REQUEST_TTL_MS,
      isoMillis(holdUntil) ?? Number.NEGATIVE_INFINITY,
    );
    if (input.nowMs > servedUntil) return null;
  }
  return { requestedAt, mode, version, holdUntil, handled };
}

/**
 * Maps the agent's `state.json` (or its absence) to what Settings shows. With
 * no state yet, the agent's `config.json` decides between "checking soon" and
 * "automatic checks are off", so the row never waits on an agent that will not run.
 */
export function toServiceUpdateState(input: {
  readonly installation: ManagedServiceInstallation | null;
  readonly stateText: string | null;
  readonly configText?: string | null;
  /** Decides whether a pending request has lapsed; now when omitted. */
  readonly nowMs?: number;
  /** The Update now run every window follows; omitted or null when there is none. */
  readonly run?: StudioServiceUpdateRun | null;
}): StudioServiceUpdateState {
  const empty: StudioServiceUpdateState = {
    status: "not-managed",
    identity: null,
    installedVersion: null,
    availableVersion: null,
    downloadedVersion: null,
    checkedAt: null,
    quietSince: null,
    message: null,
    lastInstall: null,
  };
  if (input.installation === null) return empty;
  const base: StudioServiceUpdateState = {
    ...empty,
    status: "starting",
    identity: input.installation.identity,
    installedVersion: input.installation.version,
  };
  const nowMs = input.nowMs ?? DateTime.toEpochMillis(DateTime.nowUnsafe());
  const pending = (status: StudioServiceUpdateStatus, handledAt: unknown) =>
    pendingServiceInstall({ configText: input.configText, handledAt, status, nowMs });
  if (input.stateText === null) {
    const status = automaticChecksOff(input.configText) ? "disabled" : base.status;
    return { ...base, status, pendingInstall: pending(status, null) };
  }
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.stateText);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...base, pendingInstall: pending(base.status, null) };
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return { ...base, pendingInstall: pending(base.status, null) };
  }
  const status: StudioServiceUpdateStatus = AGENT_STATUSES.has(
    record.status as StudioServiceUpdateStatus,
  )
    ? (record.status as StudioServiceUpdateStatus)
    : "starting";
  const lastInstallRecord =
    typeof record.lastInstall === "object" && record.lastInstall !== null
      ? (record.lastInstall as Record<string, unknown>)
      : null;
  const lastInstall =
    lastInstallRecord !== null &&
    typeof lastInstallRecord.version === "string" &&
    typeof lastInstallRecord.at === "string" &&
    (lastInstallRecord.result === "updated" || lastInstallRecord.result === "failed")
      ? {
          version: lastInstallRecord.version,
          at: lastInstallRecord.at,
          result: lastInstallRecord.result as "updated" | "failed",
        }
      : null;
  return {
    status,
    identity: input.installation.identity,
    installedVersion: stringOrNull(record.installedVersion) ?? input.installation.version,
    availableVersion: stringOrNull(record.availableVersion),
    downloadedVersion: stringOrNull(record.downloadedVersion),
    checkedAt: stringOrNull(record.checkedAt),
    quietSince: stringOrNull(record.quietSince),
    message: stringOrNull(record.message),
    lastInstall,
    updatedAt: stringOrNull(record.updatedAt),
    pendingInstall: pending(status, record.handledInstallRequestAt),
    ...(input.run ? { run: input.run } : {}),
  };
}

/** The agent advertises run support (`runSupport: 1` in state.json); older agents never write it. */
export function agentSupportsRuns(stateText: string | null): boolean {
  if (stateText === null) return false;
  try {
    const record = JSON.parse(stateText) as { runSupport?: unknown } | null;
    return record?.runSupport === 1;
  } catch {
    return false;
  }
}

/** RunFiles over a service's `updates` folder. O_EXCL creation: a private temp file linked into place. */
export function nodeRunFiles(updatesDir: string): RunFiles {
  const at = (name: string) => Path.join(updatesDir, name);
  return {
    read: (name) => readTextOrNull(at(name)),
    writeAtomic: (name, text) => writeTextAtomic(at(name), text),
    createExclusive: (name, text) => {
      FS.mkdirSync(updatesDir, { recursive: true, mode: 0o700 });
      const temporary = `${at(name)}.${process.pid}.${DateTime.toEpochMillis(DateTime.nowUnsafe())}.create`;
      FS.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      try {
        FS.linkSync(temporary, at(name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      } finally {
        FS.rmSync(temporary, { force: true });
      }
    },
    rename: (from, to) => {
      FS.mkdirSync(Path.dirname(at(to)), { recursive: true, mode: 0o700 });
      FS.renameSync(at(from), at(to));
    },
    list: (directory) => {
      try {
        return FS.readdirSync(at(directory));
      } catch {
        return [];
      }
    },
    remove: (name) => FS.rmSync(at(name), { force: true }),
  };
}

/** The desktop could not start the agent for a request it was given. */
export interface AgentStartFailure {
  /** ISO time of the failure. */
  readonly at: string;
  readonly message: string;
}

/**
 * Reports a failed agent start through the state the renderer polls, until the
 * agent writes a newer state of its own. The failure carries its own time, so
 * a renderer that ignores answers older than its request still takes it. It is
 * flagged as the desktop's own: the agent's versions it keeps are no release a
 * forced request could install while the agent does not run. Every other state
 * says it is not, so a renderer tells this desktop from an older one that
 * never flags its failures.
 */
export function withAgentStartFailure(
  state: StudioServiceUpdateState,
  failure: AgentStartFailure | null,
): StudioServiceUpdateState {
  const agentStarted = { ...state, agentStartFailed: false };
  if (failure === null || state.status === "not-managed") return agentStarted;
  const written = isoMillis(state.updatedAt ?? null);
  const failed = isoMillis(failure.at);
  if (written !== null && failed !== null && written >= failed) return agentStarted;
  return {
    ...state,
    status: "error",
    message: failure.message,
    updatedAt: failure.at,
    agentStartFailed: true,
  };
}

/**
 * Picks the update agent script that /usr/bin/python3 can actually open.
 * Electron's patched fs reports files inside app.asar as present, but an
 * external process sees app.asar as a plain file, so those paths fail with
 * "Not a directory". Only real on-disk paths are accepted.
 */
export function selectAgentScriptPath(
  candidates: ReadonlyArray<string>,
  exists: (candidate: string) => boolean,
): string | null {
  return (
    candidates.find((candidate) => !/\.asar(?:[\\/]|$)/i.test(candidate) && exists(candidate)) ??
    null
  );
}

export function serviceAgentLabel(identity: string): string {
  return `com.specweave.studio.${identity}.updater`;
}

/** `update_agent.py --install-launch-agent` exit status: launchd has the label turned off. */
export const SERVICE_AGENT_DISABLED_EXIT = 3;
export const SERVICE_AGENT_DISABLED_MESSAGE =
  "Update agent is turned off in launchd. Choose Repair in Settings to turn it back on.";

export type ServiceAgentStep = "disabled" | "refresh" | "kickstart" | "repair";

/**
 * Why the update agent could not be installed, started or repaired, in words
 * Settings shows as they are. `disabled` means launchd has the agent's label
 * turned off (`launchctl disable`): nothing is booted out or kicked then, and
 * only Repair, on a click, turns it back on.
 */
export class ServiceAgentError extends Data.TaggedError("ServiceAgentError")<{
  readonly step: ServiceAgentStep;
  readonly message: string;
}> {}

const LAUNCHD_REASON_LIMIT = 400;

/**
 * One line of what a failed helper or launchctl said: the helper's JSON
 * `message`, else stderr or stdout with the exit status, else the exit status.
 */
export function launchdFailureReason(failure: {
  readonly code?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly message?: unknown;
}): string {
  const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
  for (const line of stdout.split("\n").reverse()) {
    try {
      const reply = JSON.parse(line) as { message?: unknown } | null;
      if (typeof reply?.message === "string" && reply.message.length > 0) return reply.message;
    } catch {
      // Not a JSON line: launchctl or python wrote plain text.
    }
  }
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const text = (stderr || stdout).replace(/\s+/g, " ").slice(0, LAUNCHD_REASON_LIMIT);
  const code =
    typeof failure.code === "number" || typeof failure.code === "string"
      ? `exit ${failure.code}`
      : null;
  if (text.length > 0) return code === null ? text : `${text} (${code})`;
  return code ?? (typeof failure.message === "string" ? failure.message : "unknown failure");
}

/** What Settings shows for a failed agent step. */
export function serviceAgentFailureMessage(error: unknown): string {
  if (error instanceof ServiceAgentError) return error.message;
  return `The update agent did not start: ${launchdFailureReason(
    typeof error === "object" && error !== null ? error : { message: String(error) },
  )}`;
}

interface RunFailure {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}

function run(command: string, args: ReadonlyArray<string>, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        timeout,
        maxBuffer: 1024 * 1024,
        env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
          return;
        }
        // Keep what launchctl or the helper said: a bare "Command failed" hides why.
        const failure: RunFailure = {
          code:
            typeof error.code === "number" || typeof error.code === "string" ? error.code : null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          message: error.message,
        };
        reject(failure);
      },
    );
  });
}

function writeTextAtomic(filePath: string, text: string) {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${DateTime.toEpochMillis(DateTime.nowUnsafe())}.tmp`;
  FS.writeFileSync(temporary, text, { mode: 0o600 });
  FS.renameSync(temporary, filePath);
}

function writeJsonAtomic(filePath: string, value: unknown) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readTextOrNull(filePath: string): string | null {
  try {
    return FS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export interface ServiceUpdateController {
  readonly installation: () => ManagedServiceInstallation | null;
  readonly readState: () => StudioServiceUpdateState;
  readonly writeConfig: (
    input: {
      readonly preferences: DesktopUpdatePreferences;
      readonly channel: DesktopUpdateChannel;
    } & ServiceAgentConfigChange,
  ) => void;
  /**
   * Installs or refreshes the agent's launchd job; a no-op when unchanged.
   * Rejects with a `ServiceAgentError`: `disabled` when launchd has the label
   * turned off (nothing was booted out), `refresh` with the helper's reason.
   */
  readonly ensureAgent: () => Promise<void>;
  /** Asks launchd to run one agent pass now; rejects with launchctl's reason. */
  readonly runAgentNow: () => Promise<void>;
  /**
   * Settings' Repair, only on a person's click: `launchctl enable` the label,
   * load the job and start one pass. Never run on its own: the owner may have
   * turned the agent off on purpose.
   */
  readonly repairAgent: () => Promise<void>;
  /** See `hasPendingForcedInstall`. */
  readonly pendingForcedInstall: (nowMs: number) => boolean;
  /** The service's `updates` folder for run records; null when no service is managed here. */
  readonly runFiles: () => RunFiles | null;
  /** The agent writes `runSupport: 1` to its state: it claims Update now runs. */
  readonly runSupported: () => boolean;
}

/**
 * How long "Update now" waits for the bundled agent to be installed before it
 * kicks the job anyway. Installing is a quick local process; the wait only
 * keeps a slow one from holding the click's reply.
 */
export const INSTALL_AGENT_REFRESH_WAIT = Duration.seconds(10);

export type AgentRefreshOutcome = "refreshed" | "failed" | "timed out";

const asAgentError =
  (step: ServiceAgentStep) =>
  (cause: unknown): ServiceAgentError =>
    cause instanceof ServiceAgentError
      ? cause
      : new ServiceAgentError({ step, message: serviceAgentFailureMessage(cause) });

/**
 * Installs the bundled agent, then asks launchd to run it. The kicked pass
 * takes the agent lock, so refreshing after the kick would find it busy and
 * leave the older agent to handle the request. A refresh that fails or outlives
 * `wait` still kicks (the refresh process keeps running, never cut off
 * mid-reload): the job already installed can still run. A label launchd has
 * turned off fails at once, unkicked: no kick could start it. Otherwise fails
 * when the kick does, with launchctl's reason and the refresh's, if it failed.
 */
export const refreshThenRunAgent = (
  controller: Pick<ServiceUpdateController, "ensureAgent" | "runAgentNow">,
  wait: Duration.Input = INSTALL_AGENT_REFRESH_WAIT,
) =>
  Effect.gen(function* () {
    const refresh = yield* Effect.tryPromise({
      try: () => controller.ensureAgent(),
      catch: asAgentError("refresh"),
    }).pipe(
      Effect.timeoutOption(wait),
      Effect.map(
        Option.match({
          onNone: () => ({ outcome: "timed out" as AgentRefreshOutcome, error: null }),
          onSome: () => ({ outcome: "refreshed" as AgentRefreshOutcome, error: null }),
        }),
      ),
      Effect.catchIf(
        (error) => error.step !== "disabled",
        (error) => Effect.succeed({ outcome: "failed" as AgentRefreshOutcome, error }),
      ),
    );
    yield* Effect.tryPromise({
      try: () => controller.runAgentNow(),
      catch: (cause) => {
        const kick = asAgentError("kickstart")(cause);
        return refresh.error === null
          ? kick
          : new ServiceAgentError({
              step: "kickstart",
              message: `${kick.message} (refreshing it failed too: ${refresh.error.message})`,
            });
      },
    });
    return refresh.outcome;
  });

/**
 * Runs Repair and says how it went: null on success, else the failure Settings
 * shows. Only called for a person's click.
 */
export const repairServiceAgent = (controller: Pick<ServiceUpdateController, "repairAgent">) =>
  Effect.tryPromise({
    try: () => controller.repairAgent(),
    catch: asAgentError("repair"),
  }).pipe(
    Effect.as(null as string | null),
    Effect.catch((error: ServiceAgentError) => Effect.succeed(error.message as string | null)),
  );

export function makeServiceUpdateController(input: {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly agentScriptPath: () => string | null;
  readonly uid?: () => number;
  /** Null means no service is attached. Omission is retained for legacy isolated callers. */
  readonly attachedStudioHome?: string | null;
}): ServiceUpdateController {
  const uid = input.uid ?? (() => process.getuid?.() ?? -1);
  const installation = () => {
    if (input.platform !== "darwin" || input.attachedStudioHome === null) return null;
    const candidates = findManagedServiceInstallations(input.homeDirectory).filter(
      (candidate) =>
        input.attachedStudioHome === undefined || candidate.studioHome === input.attachedStudioHome,
    );
    return candidates.length === 1 ? candidates[0]! : null;
  };
  const updatesDir = (target: ManagedServiceInstallation) =>
    Path.join(target.studioHome, "updates");

  return {
    installation,
    readState: () => {
      const target = installation();
      return toServiceUpdateState({
        installation: target,
        stateText:
          target === null ? null : readTextOrNull(Path.join(updatesDir(target), "state.json")),
        configText:
          target === null ? null : readTextOrNull(Path.join(updatesDir(target), "config.json")),
        run:
          target === null
            ? null
            : readRunView(
                nodeRunFiles(updatesDir(target)),
                DateTime.toEpochMillis(DateTime.nowUnsafe()),
              ),
      });
    },
    writeConfig: (config) => {
      const target = installation();
      if (target === null) return;
      const configPath = Path.join(updatesDir(target), "config.json");
      let previous: Partial<ServiceAgentConfig> | null = null;
      const existing = readTextOrNull(configPath);
      if (existing !== null) {
        try {
          previous = JSON.parse(existing) as Partial<ServiceAgentConfig>;
        } catch {
          previous = null;
        }
      }
      writeJsonAtomic(configPath, buildServiceAgentConfig({ previous, ...config }));
    },
    ensureAgent: async () => {
      const target = installation();
      const script = input.agentScriptPath();
      if (target === null || script === null) return;
      await run(
        "/usr/bin/python3",
        [script, "--identity", target.identity, "--install-launch-agent"],
        60_000,
      ).catch((failure: RunFailure) => {
        throw failure.code === SERVICE_AGENT_DISABLED_EXIT
          ? new ServiceAgentError({ step: "disabled", message: SERVICE_AGENT_DISABLED_MESSAGE })
          : new ServiceAgentError({
              step: "refresh",
              message: `The update agent could not be installed: ${launchdFailureReason(failure)}`,
            });
      });
    },
    runAgentNow: async () => {
      const target = installation();
      if (target === null) return;
      await run(
        "/bin/launchctl",
        ["kickstart", `gui/${uid()}/${serviceAgentLabel(target.identity)}`],
        15_000,
      ).catch((failure: RunFailure) => {
        throw new ServiceAgentError({
          step: "kickstart",
          message: `launchctl could not start the update agent: ${launchdFailureReason(failure)}`,
        });
      });
    },
    repairAgent: async () => {
      const target = installation();
      const script = input.agentScriptPath();
      if (target === null || script === null) {
        throw new ServiceAgentError({
          step: "repair",
          message: "No update agent is installed for this Mac's service.",
        });
      }
      await run(
        "/usr/bin/python3",
        [script, "--identity", target.identity, "--repair-launch-agent"],
        60_000,
      ).catch((failure: RunFailure) => {
        throw new ServiceAgentError({
          step: "repair",
          message: `The update agent could not be repaired: ${launchdFailureReason(failure)}`,
        });
      });
    },
    pendingForcedInstall: (nowMs) => {
      const target = installation();
      if (target === null) return false;
      return hasPendingForcedInstall(
        readTextOrNull(Path.join(updatesDir(target), "config.json")),
        nowMs,
      );
    },
    runFiles: () => {
      const target = installation();
      return target === null ? null : nodeRunFiles(updatesDir(target));
    },
    runSupported: () => {
      const target = installation();
      return (
        target !== null &&
        agentSupportsRuns(readTextOrNull(Path.join(updatesDir(target), "state.json")))
      );
    },
  };
}
