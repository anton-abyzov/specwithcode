/**
 * Words and decisions behind "Also add on": which machines may get a skill
 * from this one, where the change goes, the result words per machine, Retry
 * failed and each machine's Undo. Every phrase is looked up by its English text.
 */
import type {
  EnvironmentId,
  ProjectSkillSourceStatus,
  ProjectSkillsFleetPushResult,
} from "@specweave-studio/contracts";
import type {
  StudioFleetMachine,
  StudioFleetSkillSource,
} from "@specweave-studio/contracts/studioFleet";

/** An English phrase and the values it takes, for `tx`. */
export interface Phrase {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

type Row = ProjectSkillsFleetPushResult["results"][number];

/** The one copy a rollout sends: one connected repo at one commit. */
export interface RolloutSource {
  readonly skillId: string;
  readonly repo: string;
  readonly skill: string;
  readonly version: string;
  readonly contentHash: string;
  readonly scope: "user";
  readonly github: StudioFleetSkillSource;
}

const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;
const SKILL_PATH = /^([A-Za-z0-9._-]+\/){1,8}SKILL\.md$/;
const BRANCH = /^[A-Za-z0-9._-]{1,100}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** The source a skill's lock records, or why it cannot be sent to another machine. */
export function rolloutSourceOf(
  status: ProjectSkillSourceStatus,
):
  | { readonly ok: true; readonly source: RolloutSource }
  | { readonly ok: false; readonly reason: Phrase } {
  const { repo, installed, installedSource } = status;
  if (repo === null || !REPO.test(repo))
    return {
      ok: false,
      reason: { text: "Only a skill from a connected GitHub repo can be added on other machines." },
    };
  if (status.lockScope !== "user")
    return {
      ok: false,
      reason: { text: "Only skills for every project roll out to other machines." },
    };
  if (installed.version === null || !VERSION.test(installed.version))
    return {
      ok: false,
      reason: { text: "This copy records no version, so other machines cannot get the same one." },
    };
  if (
    installed.commit === null ||
    !COMMIT.test(installed.commit) ||
    installed.contentHash === null ||
    !HASH.test(installed.contentHash) ||
    installedSource === undefined ||
    !SKILL_PATH.test(installedSource.path) ||
    !BRANCH.test(installedSource.branch)
  )
    return {
      ok: false,
      reason: {
        text: "The lock records no source commit for this copy. Update it once here first.",
      },
    };
  return {
    ok: true,
    source: {
      skillId: `${repo}/${status.skill}`,
      repo,
      skill: status.skill,
      version: installed.version,
      contentHash: installed.contentHash,
      scope: "user",
      github: {
        kind: "github",
        path: installedSource.path,
        branch: installedSource.branch,
        commit: installed.commit,
      },
    },
  };
}

export interface RolloutMachine {
  readonly machineId: string;
  readonly label: string;
  readonly environmentId: EnvironmentId;
  /** Why nothing may be sent there; null when it can be ticked. */
  readonly disabled: Phrase | null;
}

const cannotWrite = (machine: string): Phrase => ({
  text: "This sign-in cannot change skills on {machine}",
  values: { machine },
});

/** Every other machine, unticked; offline and unpaired ones disabled with their reason. */
export function rolloutMachines(
  machines: ReadonlyArray<StudioFleetMachine>,
  self: EnvironmentId,
  machineName?: (environmentId: EnvironmentId, hostLabel: string) => string,
): ReadonlyArray<RolloutMachine> {
  return machines
    .filter((machine) => machine.environmentId !== self)
    .map((machine) => {
      const label =
        machineName?.(machine.environmentId, machine.label) ?? machine.machineName ?? machine.label;
      const disabled: Phrase | null =
        machine.status === "unreachable"
          ? { text: "{machine} is offline", values: { machine: label } }
          : machine.status === "identity-mismatch"
            ? {
                text: "{machine} answers as another machine than the one paired",
                values: { machine: label },
              }
            : !machine.pairingConfigured
              ? cannotWrite(label)
              : null;
      return { machineId: machine.id, label, environmentId: machine.environmentId, disabled };
    });
}

/** Disables the machines whose first preview says nothing can be sent there. */
export function withPreviewRefusals(
  machines: ReadonlyArray<RolloutMachine>,
  previews: ReadonlyArray<Row>,
): ReadonlyArray<RolloutMachine> {
  return machines.map((machine) => {
    if (machine.disabled) return machine;
    const answer = previews.find((row) => row.machineId === machine.machineId);
    if (answer === undefined || answer.ok) return machine;
    if (answer.reason === "unsupported")
      return {
        ...machine,
        disabled: {
          text: "{machine} needs a newer SpecWithCode to preview this",
          values: { machine: machine.label },
        },
      };
    if (answer.reason === "unauthorized")
      return { ...machine, disabled: cannotWrite(machine.label) };
    if (answer.reason === "unreachable")
      return {
        ...machine,
        disabled: { text: "{machine} is offline", values: { machine: machine.label } },
      };
    return machine;
  });
}

/** "studio", "studio and laptop", "studio, laptop and tower". */
export function joinMachineNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The line above "Also add on": where the change goes. */
export function placesPhrase(self: string, ticked: ReadonlyArray<string>): Phrase {
  return ticked.length === 0
    ? { text: "On {machine} only.", values: { machine: self } }
    : { text: "On {machines}.", values: { machines: joinMachineNames([self, ...ticked]) } };
}

export function savePhrase(self: string, ticked: ReadonlyArray<string>): Phrase {
  return { text: "Save on {machines}", values: { machines: joinMachineNames([self, ...ticked]) } };
}

/** What happened on one machine, in the words shared with Integrations. */
export function rolloutResultWords(row: Row): Phrase {
  if (row.ok) {
    if (row.removed === true) return { text: "Removed" };
    if (row.previous)
      return { text: "Updated to {version}", values: { version: row.installedVersion ?? "" } };
    return row.via === "npx" ? { text: "Added via npx vskill" } : { text: "Added" };
  }
  switch (row.reason) {
    case "name-taken":
      return { text: "Skipped, the name is already used there" };
    case "vskill-missing":
      return { text: "vskill and npx missing" };
    case "no-access":
      return { text: "No access" };
    default:
      return { text: "Failed: {error}", values: { error: row.message ?? row.reason ?? "" } };
  }
}

/** The tone of a result row. */
export function rolloutResultTone(row: Row): "done" | "skipped" | "failed" {
  if (row.ok) return "done";
  return row.reason === "name-taken" ? "skipped" : "failed";
}

/** Machines Retry failed asks again: never a verified success, never a skip. */
export function retryMachineIds(rows: ReadonlyArray<Row>): ReadonlyArray<string> {
  return rows.filter((row) => rolloutResultTone(row) === "failed").map((row) => row.machineId);
}

export type UndoPlan =
  | {
      readonly kind: "remove" | "restore";
      readonly version: string;
      readonly contentHash: string;
      readonly github: StudioFleetSkillSource;
    }
  | { readonly kind: "none"; readonly reason: Phrase };

/** How Undo puts one machine back: remove a new copy, or reinstall the one it replaced. */
export function undoPlanOf(row: Row, source: RolloutSource): UndoPlan {
  if (!row.ok || row.removed === true)
    return { kind: "none", reason: { text: "Nothing changed there." } };
  const previous = row.previous ?? null;
  if (previous === null)
    return {
      kind: "remove",
      version: row.installedVersion ?? source.version,
      contentHash: source.contentHash,
      github: source.github,
    };
  if (
    previous.version === null ||
    !VERSION.test(previous.version) ||
    previous.commit === null ||
    !COMMIT.test(previous.commit) ||
    previous.contentHash === null ||
    !HASH.test(previous.contentHash) ||
    previous.path === null ||
    !SKILL_PATH.test(previous.path) ||
    previous.branch === null ||
    !BRANCH.test(previous.branch)
  )
    return {
      kind: "none",
      reason: { text: "The copy it replaced records no source commit, so Undo cannot restore it." },
    };
  return {
    kind: "restore",
    version: previous.version,
    contentHash: previous.contentHash,
    github: {
      kind: "github",
      path: previous.path,
      branch: previous.branch,
      commit: previous.commit,
    },
  };
}
