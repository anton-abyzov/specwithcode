import type {
  DesktopUpdateChannel,
  DesktopUpdatePreferences,
  StudioServiceUpdateState,
  StudioServiceUpdateStatus,
} from "@specweave-studio/contracts";
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

export interface ServiceAgentConfig {
  readonly schemaVersion: 1;
  readonly checkAutomatically: boolean;
  readonly downloadInBackground: boolean;
  readonly installAutomatically: boolean;
  readonly channel: "stable" | "preview";
  readonly quietMinutes: number;
  readonly installRequestedAt: string | null;
  readonly checkRequestedAt: string | null;
  readonly repository?: string;
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

export function buildServiceAgentConfig(input: {
  readonly previous: Partial<ServiceAgentConfig> | null;
  readonly preferences: DesktopUpdatePreferences;
  readonly channel: DesktopUpdateChannel;
  readonly installRequestedAt?: string;
  readonly checkRequestedAt?: string;
}): ServiceAgentConfig {
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
    installRequestedAt: input.installRequestedAt ?? previous.installRequestedAt ?? null,
    checkRequestedAt: input.checkRequestedAt ?? previous.checkRequestedAt ?? null,
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
  readonly writeConfig: (input: {
    readonly preferences: DesktopUpdatePreferences;
    readonly channel: DesktopUpdateChannel;
    readonly installRequestedAt?: string;
    readonly checkRequestedAt?: string;
  }) => void;
  /** Installs or refreshes the agent's launchd job; a no-op when unchanged. */
  readonly ensureAgent: () => Promise<void>;
  /** Asks launchd to run one agent pass now. */
  readonly runAgentNow: () => Promise<void>;
}

export function makeServiceUpdateController(input: {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly agentScriptPath: () => string | null;
  readonly uid?: () => number;
}): ServiceUpdateController {
  const uid = input.uid ?? (() => process.getuid?.() ?? 501);
  const installation = () =>
    input.platform === "darwin"
      ? (findManagedServiceInstallations(input.homeDirectory)[0] ?? null)
      : null;
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
  };
}
