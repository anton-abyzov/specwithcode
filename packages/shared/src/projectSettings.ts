import {
  type ModelSelection,
  PROJECT_FILE_BACKED_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectFileBackedSettingKey,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrideChange,
  type ProjectSettingsOverrides,
  type ResolvedServerSettings,
  type ServerSettings,
  type ServerSettingsPatch,
  type StudioProjectFile,
  type ThreadEnvMode,
  type WorktreeCleanupRules,
} from "@specweave-studio/contracts";
import {
  applyProjectSettingsOverrideChange,
  isModelSelectionProviderEnabled,
} from "./serverSettings.ts";

/**
 * Where a project-scoped value came from. The order is the priority order:
 * a project override, then the environment value, then the repository's
 * specweave-studio.json for keys in `PROJECT_FILE_BACKED_SETTINGS`, then the built-in
 * default (reported as "environment", since that is what the environment
 * value is when nothing set it).
 */
export type ProjectSettingSource = "environment" | "project" | "specweave-studio.json";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings<Settings extends ServerSettings = ServerSettings> {
  /** Environment settings with the project's overrides applied. */
  readonly settings: Settings;
  /** Where each scopable key's effective value came from. */
  readonly sources: ProjectSettingSources;
  /** The project's raw override entry; `{}` when it has none. */
  readonly overrides: ProjectSettingsOverrides;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

const ENVIRONMENT_SOURCES: ProjectSettingSources = Object.fromEntries(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
) as Record<ProjectScopedServerSettingKey, ProjectSettingSource>;

/** Cheap check so hot paths skip the projectId lookup when nothing is overridden. */
export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    // A forward-compatible decode can leave an unknown value as a present
    // undefined; that is not an override.
    if (Object.values(entry).some((value) => value !== undefined)) return true;
  }
  return false;
}

/**
 * The project aggregate's own model and workspace fields. They remain the
 * source of truth until the server has folded them into the override record;
 * after the fold the record alone decides, so a reset there cannot be undone
 * by a stale aggregate value.
 */
export interface LegacyProjectSettingsFields {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
}

/**
 * Apply one project's overrides on top of environment settings. A model
 * override whose provider is disabled on this environment falls back to the
 * environment value, the same guard the environment-level selection gets.
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  // Nullable, not just optional: the mobile new-task flow passes its selected
  // project straight through, and that is null until the shell snapshot lands.
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings;
/**
 * With the checkout's decoded specweave-studio.json (or null for a missing or invalid
 * one), every file-backed key resolves to a concrete value: the file fills
 * keys whose project and environment tiers are both unset, and the built-in
 * default fills what is left.
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  projectFile: StudioProjectFile | null,
): ResolvedProjectSettings<ResolvedServerSettings>;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFile?: StudioProjectFile | null,
): ResolvedProjectSettings {
  const resolved = resolveProjectOverrides(settings, projectId, project);
  return projectFile === undefined ? resolved : applyProjectFile(resolved, projectFile);
}

function applyProjectFile(
  resolved: ResolvedProjectSettings,
  projectFile: StudioProjectFile | null,
): ResolvedProjectSettings {
  let effective: Record<string, unknown> | null = null;
  let sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> | null = null;
  for (const key of Object.keys(PROJECT_FILE_BACKED_SETTINGS) as ProjectFileBackedSettingKey[]) {
    if (resolved.settings[key] !== null) continue;
    const { value, source } = resolveProjectFileBackedSetting(key, null, projectFile);
    effective ??= { ...resolved.settings };
    sources ??= { ...resolved.sources };
    effective[key] = value;
    // A project override of null defers like an unset one, so the value did
    // not come from the project either way.
    sources[key] = source;
  }
  return effective === null || sources === null
    ? resolved
    : { ...resolved, settings: effective as ServerSettings, sources };
}

/**
 * The file and built-in tiers for one key, given the project-over-environment
 * value (`null` when neither is set). For callers that hold the settings tier
 * but only see the file later, such as the git driver reading the specweave-studio.json of
 * the checkout it just created. Same chain as `resolveProjectSettings`.
 */
export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  setting: ServerSettings[K],
  projectFile: StudioProjectFile | null,
): { value: ResolvedServerSettings[K]; source: ProjectSettingSource } {
  if (setting !== null) {
    return { value: setting as ResolvedServerSettings[K], source: "environment" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedServerSettings[K] | undefined;
  return fromFile === undefined
    ? { value: builtIn as ResolvedServerSettings[K], source: "environment" }
    : { value: fromFile, source: "specweave-studio.json" };
}

function resolveProjectOverrides(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings {
  const stored = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const overrides: ProjectSettingsOverrides =
    project == null || settings.projectSettingsFolded
      ? (stored ?? EMPTY_OVERRIDES)
      : {
          ...(project.defaultModelSelection != null
            ? { defaultModelSelection: project.defaultModelSelection }
            : {}),
          ...(project.defaultThreadEnvMode != null
            ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
            : {}),
          ...stored,
        };
  if (Object.keys(overrides).length === 0) {
    return { settings, sources: ENVIRONMENT_SOURCES, overrides: EMPTY_OVERRIDES };
  }
  const sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> = {
    ...ENVIRONMENT_SOURCES,
  };
  const effective: Record<string, unknown> = { ...settings };
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    // A forward-compatible decode leaves an unknown value as a present
    // undefined; that is not an override.
    if (value === undefined) continue;
    // A model on a disabled provider falls back to the environment, like the
    // environment-level guards do for these keys.
    if (
      (key === "textGenerationModelSelection" || key === "defaultModelSelection") &&
      value !== undefined &&
      value !== null &&
      !isModelSelectionProviderEnabled(settings, value as ModelSelection)
    ) {
      continue;
    }
    effective[key] = value;
    sources[key] = "project";
  }
  // A project's single fallback model, set before fallback orders existed,
  // outranks an environment-wide order the project never chose.
  if (
    sources.providerLimitFallbackModelSelection === "project" &&
    sources.providerLimitFallbackModels !== "project"
  ) {
    const single = effective.providerLimitFallbackModelSelection as ModelSelection | null;
    effective.providerLimitFallbackModels = single === null ? [] : [single];
  }
  return { settings: effective as ServerSettings, sources, overrides };
}

/**
 * The patch that saves per-key override edits. A server with the
 * `projectSettingsOverrideChanges` capability applies each key to the entry it
 * holds, so edits from the same snapshot keep each other. An older server only
 * replaces whole entries: the edit is applied to the snapshot entry instead.
 */
export function projectSettingsOverrideChangesPatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  changes: Readonly<Record<ProjectId, ProjectSettingsOverrideChange>>,
  perKey: boolean,
): ServerSettingsPatch {
  if (perKey) return { projectSettingsOverrideChanges: changes };
  return {
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(changes).map(([projectId, change]) => [
        projectId,
        applyProjectSettingsOverrideChange(
          settings.projectSettingsOverrides[projectId as ProjectId],
          change,
        ),
      ]),
    ),
  };
}

/** Replace the project's entry, dropping it entirely when nothing is overridden. */
export function withProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  next: ProjectSettingsOverrides | null,
): ServerSettings["projectSettingsOverrides"] {
  const { [projectId]: _removed, ...rest } = settings.projectSettingsOverrides;
  return next === null || Object.keys(next).length === 0 ? rest : { ...rest, [projectId]: next };
}

/** Worktree rules are project-scoped; artifact and log retention stays environment-wide. */
export function resolveWorktreeCleanup(
  settings: ServerSettings,
  projectId: ProjectId | null,
): WorktreeCleanupRules {
  const policy = resolveProjectSettings(settings, projectId).settings.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const { worktreeAfterDays, worktreeOnMerge, worktreeOnDelete, worktreeUnchanged } =
    settings.storageCleanup;
  return { worktreeAfterDays, worktreeOnMerge, worktreeOnDelete, worktreeUnchanged };
}
