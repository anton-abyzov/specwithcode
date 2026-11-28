/**
 * Where a skill installed on one machine goes (1440): "You, in every project"
 * (vskill `--global`, from the home folder) or "This project". The default is
 * resolved in this order: the project's own setting, then the personal
 * assistant (Percy installs for you), then the machine's default. The machine
 * view has no project folder, so it always installs for you.
 *
 * Every phrase is looked up by its English text.
 */
import type {
  ProjectId,
  ProjectSettingsOverrideChange,
  ServerSettings,
  ServerSettingsPatch,
  SkillInstallScope,
} from "@specweave-studio/contracts";
import { projectSettingsOverrideChangesPatch } from "@specweave-studio/shared/projectSettings";
import { useState } from "react";

export type SkillInstallScopeSource = "machine-view" | "project" | "assistant" | "machine";

export interface ResolvedSkillInstallScope {
  readonly scope: SkillInstallScope;
  readonly source: SkillInstallScopeSource;
}

export function resolveSkillInstallScope(input: {
  /** The machine view: no project folder is open. */
  readonly userLevel: boolean;
  readonly projectOverride: SkillInstallScope | undefined;
  readonly personalAssistant: boolean;
  readonly machineDefault: SkillInstallScope;
}): ResolvedSkillInstallScope {
  if (input.userLevel) return { scope: "user", source: "machine-view" };
  if (input.projectOverride !== undefined)
    return { scope: input.projectOverride, source: "project" };
  if (input.personalAssistant) return { scope: "user", source: "assistant" };
  return { scope: input.machineDefault, source: "machine" };
}

export const SCOPE_LABELS: Readonly<Record<SkillInstallScope, string>> = {
  user: "You, in every project",
  project: "This project",
};

/** Under each choice: where it writes; takes `{machine}` and `{folder}`. */
export const SCOPE_WHERE: Readonly<Record<SkillInstallScope, string>> = {
  user: "Your skills folders on {machine}, for every project",
  project: "{folder}, for anyone who opens this project",
};

/** Why the chooser starts where it does; takes `{machine}`. */
export const SOURCE_PHRASES: Readonly<Record<SkillInstallScopeSource, string>> = {
  "machine-view": "No project is open, so skills install for you in every project.",
  project: "This project's default.",
  assistant: "Percy installs skills for you in every project by default.",
  machine: "{machine}'s default for projects.",
};

/** The line shown while an install runs; takes `{skill}` and `{machine}`. */
export const PROGRESS_PHRASES: Readonly<Record<SkillInstallScope, string>> = {
  user: "Installing {skill} for you in every project on {machine}…",
  project: "Installing {skill} in this project on {machine}…",
};

/** Appended to a receipt, from the lock the copy was read back from. */
export const RECEIPT_SCOPE_PHRASES: Readonly<Record<SkillInstallScope, string>> = {
  user: "For you, in every project.",
  project: "For this project only.",
};

export const PROJECT_ROLLOUT_NOTE =
  "Adding it on other machines works for skills installed for you in every project.";

export const OLDER_SERVER_NOTE =
  "{machine} runs an older SpecWithCode, so installs there follow the open view. Update it to choose.";

/** The settings write that makes `scope` the default at `level`; null clears the project's own. */
export function skillInstallScopeDefaultPatch(input: {
  readonly level: "project" | "machine";
  readonly scope: SkillInstallScope | null;
  readonly projectId: ProjectId;
  readonly settings: Pick<ServerSettings, "projectSettingsOverrides">;
  /** The server applies per-key project changes (`projectSettingsOverrideChanges`). */
  readonly perKey: boolean;
}): ServerSettingsPatch {
  if (input.level === "machine")
    return input.scope === null ? {} : { skillInstallScope: input.scope };
  const change: ProjectSettingsOverrideChange =
    input.scope === null
      ? { clear: ["skillInstallScope"] }
      : { set: { skillInstallScope: input.scope } };
  return projectSettingsOverrideChangesPatch(
    input.settings,
    { [input.projectId]: change },
    input.perKey,
  );
}

/**
 * A one-off pick over the resolved default. It lasts until the default's value
 * changes; then it is dropped for good, so another window saving the same value,
 * or a later change back, never revives it.
 */
export function useSkillInstallScopePick(resolved: SkillInstallScope) {
  const [picked, setPicked] = useState<SkillInstallScope | null>(null);
  const [pickedOver, setPickedOver] = useState(resolved);
  if (pickedOver !== resolved) {
    setPickedOver(resolved);
    setPicked(null);
  }
  return [picked ?? resolved, setPicked] as const;
}
