import type {
  DesktopUpdateChannel,
  DesktopUpdatePreferences,
  StudioServiceUpdateState,
  StudioServiceUpdateStatus,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { execFile } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import { parseStudioInstallation } from "../backend/localServiceAttach.ts";

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
  const studioRoot = Path.join(homeDirectory, ".specweave-studio");
  let names: ReadonlyArray<string>;
  try {
    names = readDir(studioRoot);
  } catch {
    return [];
  }
  const found: ManagedServiceInstallation[] = [];
  for (const name of [...names].sort()) {
    if (!SERVICE_AGENT_IDENTITIES.has(name)) continue;
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
    found.push({ identity: name, studioHome: installation.studioHome, version });
  }
  return found;
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
      }
    : { ...NO_AUTOMATIC_UPDATES, automaticUpdatesAllowed: false };
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
    ...(typeof previous.repository === "string" ? { repository: previous.repository } : {}),
  };
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
 * Maps the agent's `state.json` (or its absence) to what Settings shows. With
 * no state yet, the agent's `config.json` decides between "checking soon" and
 * "automatic checks are off", so the row never waits on an agent that will not run.
 */
export function toServiceUpdateState(input: {
  readonly installation: ManagedServiceInstallation | null;
  readonly stateText: string | null;
  readonly configText?: string | null;
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
  if (input.stateText === null) {
    return automaticChecksOff(input.configText) ? { ...base, status: "disabled" } : base;
  }
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.stateText);
    if (typeof parsed !== "object" || parsed === null) return base;
    record = parsed as Record<string, unknown>;
  } catch {
    return base;
  }
  const status = record.status as StudioServiceUpdateStatus;
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
    status: AGENT_STATUSES.has(status) ? status : "starting",
    identity: input.installation.identity,
    installedVersion: stringOrNull(record.installedVersion) ?? input.installation.version,
    availableVersion: stringOrNull(record.availableVersion),
    downloadedVersion: stringOrNull(record.downloadedVersion),
    checkedAt: stringOrNull(record.checkedAt),
    quietSince: stringOrNull(record.quietSince),
    message: stringOrNull(record.message),
    lastInstall,
    updatedAt: stringOrNull(record.updatedAt),
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
 * a renderer that ignores answers older than its request still takes it.
 */
export function withAgentStartFailure(
  state: StudioServiceUpdateState,
  failure: AgentStartFailure | null,
): StudioServiceUpdateState {
  if (failure === null || state.status === "not-managed") return state;
  const written = isoMillis(state.updatedAt ?? null);
  const failed = isoMillis(failure.at);
  if (written !== null && failed !== null && written >= failed) return state;
  return { ...state, status: "error", message: failure.message, updatedAt: failure.at };
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
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
  });
}

function writeJsonAtomic(filePath: string, value: unknown) {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  FS.renameSync(temporary, filePath);
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
  /** Installs or refreshes the agent's launchd job; a no-op when unchanged. */
  readonly ensureAgent: () => Promise<void>;
  /** Asks launchd to run one agent pass now. */
  readonly runAgentNow: () => Promise<void>;
  /** See `hasPendingForcedInstall`. */
  readonly pendingForcedInstall: (nowMs: number) => boolean;
}

/**
 * How long "Update now" waits for the bundled agent to be installed before it
 * kicks the job anyway. Installing is a quick local process; the wait only
 * keeps a slow one from holding the click's reply.
 */
export const INSTALL_AGENT_REFRESH_WAIT = Duration.seconds(10);

export type AgentRefreshOutcome = "refreshed" | "failed" | "timed out";

/**
 * Installs the bundled agent, then asks launchd to run it. The kicked pass
 * takes the agent lock, so refreshing after the kick would find it busy and
 * leave the older agent to handle the request. A refresh that fails or outlives
 * `wait` still kicks (the refresh process keeps running, never cut off
 * mid-reload): the job already installed can still run. Fails only when the
 * kick does.
 */
export const refreshThenRunAgent = (
  controller: Pick<ServiceUpdateController, "ensureAgent" | "runAgentNow">,
  wait: Duration.Input = INSTALL_AGENT_REFRESH_WAIT,
) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.tryPromise(() => controller.ensureAgent()).pipe(
      Effect.timeoutOption(wait),
      Effect.map(
        Option.match({
          onNone: (): AgentRefreshOutcome => "timed out",
          onSome: (): AgentRefreshOutcome => "refreshed",
        }),
      ),
      Effect.orElseSucceed((): AgentRefreshOutcome => "failed"),
    );
    yield* Effect.tryPromise(() => controller.runAgentNow());
    return outcome;
  });

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
      );
    },
    runAgentNow: async () => {
      const target = installation();
      if (target === null) return;
      await run(
        "/bin/launchctl",
        ["kickstart", `gui/${uid()}/${serviceAgentLabel(target.identity)}`],
        15_000,
      );
    },
    pendingForcedInstall: (nowMs) => {
      const target = installation();
      if (target === null) return false;
      return hasPendingForcedInstall(
        readTextOrNull(Path.join(updatesDir(target), "config.json")),
        nowMs,
      );
    },
  };
}
