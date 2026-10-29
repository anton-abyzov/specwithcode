/**
 * Pure helpers behind the Skills control center: which switch each agent
 * gets, the action that undoes a change, the words for previews and results,
 * and the fleet push targets.
 */
import type {
  EnvironmentId,
  ProjectId,
  ProjectSkillPresence,
  ProjectSkillRow,
  ProjectSkillsAction,
  ProjectSkillsActionApplied,
  ProjectSkillsActionPreview,
  ProjectSkillsFleetTarget,
  ProjectSkillsLiveness,
} from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";

import { projectSkillLevel } from "./ProjectSkillsSettings.logic";

export const LIVENESS_LABELS: Readonly<Record<ProjectSkillsLiveness, string>> = {
  now: "Live",
  "next-session": "Next session",
  reload: "/plugins reload",
};

const AGENT_LIVENESS: Readonly<Record<string, ProjectSkillsLiveness>> = {
  claudeAgent: "next-session",
  codex: "now",
  grok: "reload",
};

/** When a switch for this agent takes effect, or null for an agent with no switches. */
export function agentLiveness(driver: string): ProjectSkillsLiveness | null {
  return AGENT_LIVENESS[driver] ?? null;
}

const ARGV_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export type SkillSwitch =
  | {
      readonly available: true;
      readonly action: Extract<ProjectSkillsAction, { readonly kind: "toggle-skill" }>;
    }
  | { readonly available: false; readonly reason: string };

/**
 * The switch for one agent's copy, set to the opposite of its state. Claude
 * keeps a project skill's switch in the repository's `settings.local.json`,
 * everything else in the user's settings.
 */
export function skillSwitchFor(presence: ProjectSkillPresence): SkillSwitch {
  const enabled = !presence.enabled;
  switch (presence.driver) {
    case "claudeAgent": {
      if (presence.scope === "plugin")
        return { available: false, reason: "Claude plugin skills use the whole-plugin control" };
      const level = projectSkillLevel(presence.scope, presence.path);
      return {
        available: true,
        action: {
          kind: "toggle-skill",
          provider: presence.driver,
          instanceId: presence.instanceId,
          enabled,
          scope: level === "project" ? "local" : "user",
        },
      };
    }
    case "codex":
      return {
        available: true,
        action: {
          kind: "toggle-skill",
          provider: presence.driver,
          instanceId: presence.instanceId,
          enabled,
          scope: "user",
        },
      };
    case "grok":
      return { available: false, reason: "Grok has no per-skill toggle" };
    default:
      return { available: false, reason: `${presence.label} has no skill switch here yet` };
  }
}

export interface SkillPlugin {
  /** `plugin@marketplace` for Claude and Codex, the plugin name for Grok. */
  readonly pluginId: string;
  /** The plugin's own name, for the button. */
  readonly name: string;
}

/** The plugin this copy ships in, read from where the agent installed it. */
export function skillPluginOf(presence: ProjectSkillPresence): SkillPlugin | null {
  const parts = presence.path.split(/[\\/]/).filter(Boolean);
  let plugin: SkillPlugin | null = null;
  if (presence.driver === "claudeAgent" || presence.driver === "codex") {
    const cache = parts.lastIndexOf("cache");
    if (cache > 0 && parts[cache - 1] === "plugins" && parts.length > cache + 2) {
      const marketplace = parts[cache + 1]!;
      const name = parts[cache + 2]!;
      plugin = { pluginId: `${name}@${marketplace}`, name };
    }
    // Claude lists a plugin skill as `plugin:skill`; the cache folder must agree.
    if (presence.driver === "claudeAgent" && plugin && presence.name?.includes(":")) {
      if (presence.name.split(":")[0] !== plugin.name) return null;
    }
  } else if (presence.driver === "grok") {
    const installed = parts.lastIndexOf("installed-plugins");
    const local = parts.lastIndexOf("plugins");
    const folder =
      installed >= 0 ? parts[installed + 1] : local >= 0 ? parts[local + 1] : undefined;
    if (folder && parts.includes("skills")) {
      const name = installed >= 0 ? folder.replace(/-[0-9a-f]{8}$/, "") : folder;
      plugin = { pluginId: name, name };
    }
  }
  return plugin && ARGV_NAME.test(plugin.pluginId) ? plugin : null;
}

/** Turning off the whole plugin for this agent, at the user's level. */
export function pluginSwitchFor(
  presence: ProjectSkillPresence,
  enabled: boolean,
): Extract<ProjectSkillsAction, { readonly kind: "toggle-plugin" }> | null {
  const plugin = skillPluginOf(presence);
  if (!plugin || agentLiveness(presence.driver) === null) return null;
  return {
    kind: "toggle-plugin",
    provider: presence.driver,
    instanceId: presence.instanceId,
    pluginId: plugin.pluginId,
    enabled,
    scope: "user",
  };
}

/** What the lock said before a version change, so it can be put back. */
export interface SkillVersionState {
  readonly installedVersion: string | null;
  readonly pinnedVersion: string | null;
}

/**
 * The action that undoes `action`, or null when nothing would put it back.
 * A switch flips back; a version change reinstalls the version it replaced,
 * pinned or not as it was.
 */
export function inverseSkillAction(
  action: ProjectSkillsAction,
  before: SkillVersionState | null,
): ProjectSkillsAction | null {
  switch (action.kind) {
    case "toggle-skill":
    case "toggle-plugin":
      return { ...action, enabled: !action.enabled };
    case "pin":
      if (!before) return null;
      return before.pinnedVersion
        ? { kind: "pin", version: before.pinnedVersion }
        : { kind: "unpin" };
    case "unpin":
      return before?.pinnedVersion ? { kind: "pin", version: before.pinnedVersion } : null;
    case "install-version":
    case "update-latest":
      if (!before?.installedVersion || !/^\d+\.\d+\.\d+$/.test(before.installedVersion))
        return null;
      // vskill's install pins; a version that was not pinned before has that pin dropped again.
      return before.pinnedVersion
        ? { kind: "install-version", version: before.installedVersion }
        : { kind: "install-version", version: before.installedVersion, pin: false };
  }
}

/** A short label for buttons and toasts. */
export function skillActionLabel(action: ProjectSkillsAction, skill: string): string {
  switch (action.kind) {
    case "install-version":
      return `Install ${skill} ${action.version}`;
    case "pin":
      return `Pin ${skill} at ${action.version}`;
    case "unpin":
      return `Unpin ${skill}`;
    case "update-latest":
      return `Update ${skill} to the latest version`;
    case "toggle-skill":
      return `${action.enabled ? "Turn on" : "Turn off"} ${skill}`;
    case "toggle-plugin":
      return `${action.enabled ? "Turn on" : "Turn off"} plugin ${action.pluginId}`;
  }
}

/** The preview card's lines: what changes, where, and when the agent sees it. */
export function skillPreviewLines(preview: ProjectSkillsActionPreview): {
  readonly summary: string;
  readonly detail: string;
  readonly when: string;
  readonly warnings: ReadonlyArray<string>;
} {
  // A summary that already names every file it edits needs no second line saying so.
  const where = preview.argv?.length
    ? `Runs ${preview.argv.join(" ")}`
    : preview.files.length > 0 && !preview.files.every((file) => preview.summary.includes(file))
      ? `Edits ${preview.files.join(", ")}`
      : "";
  return {
    summary: preview.summary,
    detail: where,
    when: `Takes effect: ${LIVENESS_LABELS[preview.liveness]}`,
    warnings: preview.warnings ?? [],
  };
}

/** True when a switch landed but the agent still reports the other state. */
export function skillActionOverridden(
  action: ProjectSkillsAction,
  result: ProjectSkillsActionApplied,
): boolean {
  return (
    (action.kind === "toggle-skill" || action.kind === "toggle-plugin") &&
    result.effectiveEnabled !== undefined &&
    result.effectiveEnabled !== action.enabled
  );
}

/** The toast after an apply: the summary plus what the lock or agent now reports. */
export function skillAppliedText(result: ProjectSkillsActionApplied): {
  readonly title: string;
  readonly description: string;
} {
  const facts: Array<string> = [];
  if (result.installedVersion !== undefined)
    facts.push(
      result.installedVersion === null ? "Not in the lock" : `Installed ${result.installedVersion}`,
    );
  if (result.pinnedVersion !== undefined)
    facts.push(result.pinnedVersion ? `pinned at ${result.pinnedVersion}` : "not pinned");
  if (result.effectiveEnabled !== undefined)
    facts.push(result.effectiveEnabled ? "the agent loads it" : "the agent no longer loads it");
  facts.push(`takes effect: ${LIVENESS_LABELS[result.liveness].toLowerCase()}`);
  const description = facts.join(", ");
  return {
    title: result.summary,
    description: [
      description.charAt(0).toUpperCase() + description.slice(1),
      ...(result.warnings ?? []),
    ]
      .filter(Boolean)
      .join(". "),
  };
}

/** A failed action's sentence; the server words its refusals for people. */
export function skillActionErrorText(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const error = cause as { readonly message?: unknown; readonly stderrTail?: unknown };
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const tail = typeof error.stderrTail === "string" ? error.stderrTail.trim() : "";
    if (message) return tail ? `${message} ${tail.split("\n").slice(-2).join(" ")}` : message;
  }
  return "The machine did not confirm the change.";
}

export interface FleetPushMachine {
  readonly machineId: string;
  readonly label: string;
  readonly environmentId: EnvironmentId;
  /** Unreachable machines cannot take an install now. */
  readonly reachable: boolean;
  /** This project's id on that machine, when the project is there. */
  readonly projectId: ProjectId | null;
}

/** Fleet machines other than this one, with the project's id on each. */
export function fleetPushMachines(
  machines: ReadonlyArray<StudioFleetMachine>,
  self: EnvironmentId,
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
): ReadonlyArray<FleetPushMachine> {
  return machines
    .filter((machine) => machine.environmentId !== self)
    .map((machine) => ({
      machineId: machine.id,
      label: machine.machineName ?? machine.label,
      environmentId: machine.environmentId,
      reachable: machine.status === "reachable",
      projectId:
        members.find((member) => member.environmentId === machine.environmentId)?.id ?? null,
    }));
}

/**
 * Targets for the checked machines. A project install needs the project on
 * that machine; machines without it are returned as `missing` instead.
 */
export function fleetPushTargets(
  machines: ReadonlyArray<FleetPushMachine>,
  checked: ReadonlySet<string>,
  scope: "user" | "project",
): {
  readonly targets: ReadonlyArray<ProjectSkillsFleetTarget>;
  readonly missing: ReadonlyArray<FleetPushMachine>;
} {
  const targets: Array<ProjectSkillsFleetTarget> = [];
  const missing: Array<FleetPushMachine> = [];
  for (const machine of machines) {
    if (!checked.has(machine.machineId) || !machine.reachable) continue;
    if (scope === "user") targets.push({ machineId: machine.machineId, scope: "user" });
    else if (machine.projectId)
      targets.push({
        machineId: machine.machineId,
        scope: "project",
        projectId: machine.projectId,
      });
    else missing.push(machine);
  }
  return { targets, missing };
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** True when `candidate` is a strictly higher X.Y.Z than `current`; false for anything unparsable. */
export function isNewerVersion(candidate: string | null, current: string | null): boolean {
  const a = candidate ? SEMVER.exec(candidate.trim()) : null;
  const b = current ? SEMVER.exec(current.trim()) : null;
  if (!a || !b) return false;
  for (let index = 1; index <= 3; index++) {
    const diff = Number(a[index]) - Number(b[index]);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * The version to offer as an update, or null. vskill's "latest" is the
 * registry's newest upload; it counts only when its number is higher than the
 * installed one, so a lock ahead of the registry is never offered a downgrade.
 */
export function skillUpdateTarget(installed: string | null, newest: string | null): string | null {
  return isNewerVersion(newest, installed) ? newest : null;
}

/** Whether a row can change version or be pushed: vskill must know where it came from. */
export function skillVersionControl(row: ProjectSkillRow): {
  readonly skillId: string | null;
  readonly installedVersion: string | null;
  readonly pinnedVersion: string | null;
  readonly canPin: boolean;
} {
  const lock = row.lock;
  return {
    skillId: lock?.skillId ?? null,
    installedVersion: lock?.version ?? null,
    pinnedVersion: lock?.pinnedVersion ?? null,
    // vskill pins only in the folder's own lock.
    canPin: lock?.lockScope === "project",
  };
}
