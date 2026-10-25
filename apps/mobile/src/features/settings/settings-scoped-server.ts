import {
  isNullableProjectSettingsOverride,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type EnvironmentId,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrideChange,
  type ProjectSettingsOverrides,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@specweave-studio/contracts";
import {
  projectSettingsOverrideChangesPatch,
  resolveProjectSettings,
} from "@specweave-studio/shared/projectSettings";

import type { SettingsTarget } from "./settings-environment-filter";

export interface ScopedMobileSettingsTarget {
  readonly environment: SettingsTarget;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: ReturnType<typeof resolveProjectSettings>["sources"];
}

export function resolveMobileSettingsTargets(
  environments: readonly SettingsTarget[],
  members: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[] | null,
): readonly ScopedMobileSettingsTarget[] {
  if (members === null) {
    return environments.map((environment) => ({
      environment,
      projectId: null,
      ...resolveProjectSettings(environment.serverConfig.settings, null),
    }));
  }
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  return members.flatMap((member) => {
    const environment = byId.get(member.environmentId);
    if (!environment) return [];
    return [
      {
        environment,
        projectId: member.id,
        ...resolveProjectSettings(environment.serverConfig.settings, member.id),
      },
    ];
  });
}

export function planMobileScopedSettingsPatch(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  patch: ServerSettingsPatch,
) {
  if (!projectSelected) {
    return targets.map((target) => ({ environmentId: target.environment.environmentId, patch }));
  }
  const keys = Object.keys(patch);
  if (
    keys.some(
      (key) => !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(key as ProjectScopedServerSettingKey),
    )
  )
    return [];
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // A picker's "Inherit" sends null; for keys whose override cannot
    // store null that means remove the override.
    if (value === null && !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey))
      clear.push(key);
    else set[key] = value;
  }
  return planMobileProjectOverrideChanges(targets, {
    ...(Object.keys(set).length > 0 ? { set: set as ProjectSettingsOverrides } : {}),
    ...(clear.length > 0 ? { clear } : {}),
  });
}

/**
 * Sends only the keys the edit names, so a save planned from an older
 * snapshot cannot undo another one saved since; servers without per-key
 * edits get the snapshot entry with the edit applied.
 */
function planMobileProjectOverrideChanges(
  targets: readonly ScopedMobileSettingsTarget[],
  change: ProjectSettingsOverrideChange,
) {
  const writes = new Map<
    EnvironmentId,
    {
      target: ScopedMobileSettingsTarget;
      changes: Record<ProjectId, ProjectSettingsOverrideChange>;
    }
  >();
  for (const target of targets) {
    if (
      target.projectId === null ||
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides !== true
    )
      continue;
    const write = writes.get(target.environment.environmentId) ?? { target, changes: {} };
    write.changes[target.projectId] = change;
    writes.set(target.environment.environmentId, write);
  }
  return [...writes].map(([environmentId, { target, changes }]) => ({
    environmentId,
    patch: projectSettingsOverrideChangesPatch(
      target.environment.serverConfig.settings,
      changes,
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrideChanges ===
        true,
    ),
  }));
}

/** A mixed selection has no single value to display. */
export function uniformMobileSetting<K extends keyof ServerSettings>(
  targets: readonly Pick<ScopedMobileSettingsTarget, "settings">[],
  key: K,
): ServerSettings[K] | null {
  const reference = targets[0];
  if (!reference) return null;
  const value = reference.settings[key];
  return targets.every((target) => target.settings[key] === value) ? value : null;
}

export function planMobileScopedSettingsClear(
  targets: readonly ScopedMobileSettingsTarget[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  return planMobileProjectOverrideChanges(targets, { clear: [...keys] });
}
