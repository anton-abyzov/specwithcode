import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type EnvironmentId,
  isNullableProjectSettingsOverride,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrideChange,
  type ProjectSettingsOverrides,
  ServerSettings,
  type StudioProjectFile,
  type ServerSettingsPatch,
} from "@specweave-studio/contracts";
import type { EnvironmentConnectionPhase } from "@specweave-studio/client-runtime/connection";
import {
  projectSettingsOverrideChangesPatch,
  resolveProjectSettings,
  resolveWorktreeCleanup,
  type ProjectSettingSource,
} from "@specweave-studio/shared/projectSettings";
import * as Equal from "effect/Equal";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly settings: ServerSettings;
    readonly environment?: {
      readonly capabilities: {
        readonly projectSettingsOverrides?: boolean | undefined;
        readonly projectSettingsOverrideChanges?: boolean | undefined;
        readonly projectTrackOverrides?: boolean | undefined;
        readonly advisor?: boolean | undefined;
      };
    };
  } | null;
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));
const PROJECT_SCOPED_KEYS = new Set<string>(PROJECT_SCOPED_SERVER_SETTING_KEYS);

export function isProjectScopedSettingKey(key: string): key is ProjectScopedServerSettingKey {
  return PROJECT_SCOPED_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The representative supplies display values, never the set of write targets. */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, environment };
}

/**
 * One (environment, project) pair the scope writes to, with that project's
 * effective settings. Environment scopes have no member and read the
 * environment settings directly.
 */
export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  /** The environment's label; a project is the same project on every environment. */
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<ProjectScopedServerSettingKey, ProjectSettingSource>>;
  /** The project's raw override entry, for rows that show one field of a key. */
  readonly overrides?: ProjectSettingsOverrides;
}

/** Effective settings per connected target: members at project scope, environments otherwise. */
export function resolveScopedSettingsTargets(
  scope: ResolvedSettingsScope,
  connectedEnvironments: readonly ScopedSettingsEnvironment[],
  // Each member's decoded specweave-studio.json, keyed by physical project key, once read.
  // A member absent here has no file tier yet; null is a missing or invalid file.
  projectFiles?: ReadonlyMap<string, StudioProjectFile | null>,
): readonly ScopedSettingsTarget[] {
  const byId = new Map(
    connectedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.flatMap((member) => {
      const environment = byId.get(member.environmentId);
      if (!environment?.serverConfig) return [];
      const projectFile = projectFiles?.get(member.physicalProjectKey);
      const resolved =
        projectFile === undefined
          ? resolveProjectSettings(environment.serverConfig.settings, member.id)
          : resolveProjectSettings(environment.serverConfig.settings, member.id, null, projectFile);
      return [
        {
          environmentId: member.environmentId,
          label: environment.label,
          projectId: member.id,
          settings: resolved.settings,
          sources: resolved.sources,
          overrides: resolved.overrides,
        },
      ];
    });
  }
  return connectedEnvironments.flatMap((environment) =>
    environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            projectId: null,
            settings: environment.serverConfig.settings,
            sources: resolveProjectSettings(environment.serverConfig.settings, null).sources,
          },
        ]
      : [],
  );
}

export function scopedSettingsAreMixed(
  targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  keys: readonly (keyof ServerSettings)[],
): boolean {
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some((candidate) =>
      keys.some((key) => !Equal.equals(first.settings[key], candidate.settings[key])),
    )
  );
}

export type ScopedSettingSource = ProjectSettingSource | "mixed";

/** Whether the keys are overridden on every target, inherited on every target, or split. */
export function scopedSettingsSource(
  targets: readonly Pick<ScopedSettingsTarget, "sources">[],
  keys: readonly (keyof ServerSettings)[],
): ScopedSettingSource {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0 || targets.length === 0) return "environment";
  return combineSources(
    new Set(targets.flatMap((target) => scoped.map((key) => target.sources[key]))),
  );
}

/**
 * Keys a project overrides field by field: the override stores only the
 * fields the project changed, and every other field follows the machine.
 */
export const PROJECT_FIELD_SETTING_KEYS = ["advisor"] as const;
export type ProjectFieldSettingKey = (typeof PROJECT_FIELD_SETTING_KEYS)[number];

export function isProjectFieldSettingKey(key: string): key is ProjectFieldSettingKey {
  return (PROJECT_FIELD_SETTING_KEYS as readonly string[]).includes(key);
}

function ownsField(override: unknown, field: string): boolean {
  return isPlainObject(override) && Object.hasOwn(override, field) && override[field] !== undefined;
}

function combineSources(sources: ReadonlySet<ScopedSettingSource>): ScopedSettingSource {
  return sources.size > 1
    ? "mixed"
    : sources.has("project")
      ? "project"
      : sources.has("specweave-studio.json")
        ? "specweave-studio.json"
        : "environment";
}

/**
 * Like `scopedSettingsSource` for one field of a field-wise key: a target
 * counts as overridden only when its project override holds that field.
 */
export function scopedSettingFieldSource(
  targets: readonly Pick<ScopedSettingsTarget, "sources" | "overrides">[],
  key: ProjectFieldSettingKey,
  field: string,
): ScopedSettingSource {
  if (targets.length === 0) return "environment";
  return combineSources(
    new Set(
      targets.map((target) => {
        const source = target.sources[key];
        // Without the raw entry the key-level answer is the safe one.
        if (source !== "project" || target.overrides === undefined) return source;
        return ownsField(target.overrides[key], field) ? "project" : "environment";
      }),
    ),
  );
}

/** Whether one field of a key differs between the selected targets. */
export function scopedSettingFieldMixed(
  targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  key: ProjectFieldSettingKey,
  field: string,
): boolean {
  const fieldOf = (target: Pick<ScopedSettingsTarget, "settings">) => {
    const value: unknown = target.settings[key];
    return isPlainObject(value) ? value[field] : undefined;
  };
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some((candidate) => !Equal.equals(fieldOf(first), fieldOf(candidate)))
  );
}

/**
 * The change that drops one field from a project's override of `key`: the
 * remaining fields are written back as the whole value (a set replaces the
 * key), and the key is cleared when that field was the last one. Null when
 * the override does not hold the field, so nothing is written.
 */
export function projectOverrideFieldClearChange(
  entry: ProjectSettingsOverrides | undefined,
  key: ProjectFieldSettingKey,
  field: string,
): ProjectSettingsOverrideChange | null {
  const own: unknown = entry?.[key];
  if (!isPlainObject(own) || !ownsField(own, field)) return null;
  const rest = Object.fromEntries(
    Object.entries(own).filter(([name, value]) => name !== field && value !== undefined),
  );
  return Object.keys(rest).length === 0
    ? { clear: [key] }
    : { set: { [key]: rest } as ProjectSettingsOverrides };
}

interface ScopedServerWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
}

/**
 * One write per environment carrying only the keys each project edit names,
 * so a save planned from an older snapshot cannot undo another saved since.
 */
function projectOverrideChangeWrites(
  environments: readonly ScopedSettingsEnvironment[],
  targets: readonly { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }[],
  change: (
    settings: ServerSettings,
    projectId: ProjectId,
    environmentId: EnvironmentId,
    // Null: this entry has nothing to change, so its machine gets no write for it.
  ) => ProjectSettingsOverrideChange | null,
): ScopedServerWrite[] {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const changes = new Map<EnvironmentId, Record<ProjectId, ProjectSettingsOverrideChange>>();
  for (const { environmentId, projectId } of targets) {
    const settings = byId.get(environmentId)?.serverConfig?.settings;
    if (!settings) continue;
    const next = change(settings, projectId, environmentId);
    if (next === null) continue;
    const entries = changes.get(environmentId) ?? {};
    entries[projectId] = next;
    changes.set(environmentId, entries);
  }
  return [...changes].flatMap(([environmentId, entries]) => {
    const environment = byId.get(environmentId);
    if (!environment?.serverConfig) return [];
    return [
      {
        environmentId,
        label: environment.label,
        patch: projectSettingsOverrideChangesPatch(
          environment.serverConfig.settings,
          entries,
          environment.serverConfig.environment?.capabilities.projectSettingsOverrideChanges ===
            true,
        ),
      },
    ];
  });
}

function projectOverrideWrites(
  scope: Extract<ResolvedSettingsScope, { kind: "project" | "checkout" }>,
  environments: readonly ScopedSettingsEnvironment[],
  change: (
    settings: ServerSettings,
    projectId: ProjectId,
    capabilities:
      | NonNullable<
          NonNullable<ScopedSettingsEnvironment["serverConfig"]>["environment"]
        >["capabilities"]
      | undefined,
  ) => ProjectSettingsOverrideChange | null,
): ScopedServerWrite[] {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const targets = scope.members.flatMap((member) => {
    const environment = byId.get(member.environmentId);
    return environment?.serverConfig &&
      environment.connection.phase === "connected" &&
      environment.serverConfig.environment?.capabilities.projectSettingsOverrides === true
      ? [{ environmentId: member.environmentId, projectId: member.id }]
      : [];
  });
  return projectOverrideChangeWrites(environments, targets, (settings, projectId, environmentId) =>
    change(settings, projectId, byId.get(environmentId)?.serverConfig?.environment?.capabilities),
  );
}

/**
 * Environment scopes write the patch to every connected environment; project
 * and checkout scopes write the scopable keys into each member's override
 * entry on its environment. Client keys always persist locally.
 */
export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ScopedSettingsPatch,
) {
  const clientPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => CLIENT_KEYS.has(key)),
  ) as ClientSettingsPatch;
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const serverKeys = Object.keys(serverPatch);
  const { connectedEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unscopableKeys = isProjectScope
    ? serverKeys.filter((key) => !isProjectScopedSettingKey(key))
    : [];
  const serverWrites: ScopedServerWrite[] =
    serverKeys.length === 0
      ? []
      : isProjectScope
        ? unscopableKeys.length > 0
          ? []
          : projectOverrideWrites(scope, environments, (settings, projectId, capabilities) => {
              // Object-valued keys arrive as partial patches (the writing style
              // rows send one field); an override entry stores the whole value,
              // so complete the patch from the target's effective value.
              const effective = resolveProjectSettings(settings, projectId).settings;
              const set: Record<string, unknown> = {};
              const clear: string[] = [];
              for (const [key, value] of Object.entries(serverPatch)) {
                if (value === undefined) continue;
                if (key === "worktreeCleanup" && serverPatch.worktreeCleanup?.mode === "custom") {
                  set[key] = {
                    mode: "custom",
                    rules: {
                      ...resolveWorktreeCleanup(settings, projectId),
                      ...serverPatch.worktreeCleanup.rules,
                    },
                  };
                  continue;
                }
                // A picker's "Inherit" sends null; for keys whose override
                // cannot store null that means remove the override.
                if (
                  value === null &&
                  !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey)
                ) {
                  clear.push(key);
                  continue;
                }
                const base = effective[key as keyof ServerSettings];
                // Tracks, the review policy and the advisor store only what the
                // project changed; every other field keeps following this
                // machine. An older server fills a partial track or review
                // value with defaults, so it gets the whole object, as before;
                // every server that reads the advisor merges it field-wise.
                if (
                  (((key === "modelLanes" || key === "adversarialReview") &&
                    capabilities?.projectTrackOverrides === true) ||
                    (key === "advisor" && capabilities?.advisor === true)) &&
                  isPlainObject(value) &&
                  isPlainObject(base)
                ) {
                  const own = settings.projectSettingsOverrides[projectId]?.[key];
                  const changed = changedFields(value, base);
                  if (own !== undefined || Object.keys(changed).length > 0)
                    set[key] = { ...own, ...changed };
                  continue;
                }
                set[key] =
                  isPlainObject(value) && isPlainObject(base) ? { ...base, ...value } : value;
              }
              return {
                ...(Object.keys(set).length > 0 ? { set: set as ProjectSettingsOverrides } : {}),
                ...(clear.length > 0 ? { clear } : {}),
              };
            })
        : scope.kind === "all" || scope.kind === "environment"
          ? connectedEnvironments.map((environment) => ({
              environmentId: environment.environmentId,
              label: environment.label,
              patch:
                environment.serverConfig?.settings.worktreeCleanup != null &&
                serverPatch.storageCleanup &&
                Object.keys(serverPatch.storageCleanup).some((key) => key.startsWith("worktree"))
                  ? {
                      ...serverPatch,
                      worktreeCleanup: {
                        mode: "custom",
                        rules: {
                          ...resolveWorktreeCleanup(environment.serverConfig.settings, null),
                          ...Object.fromEntries(
                            Object.entries(serverPatch.storageCleanup).filter(([key]) =>
                              key.startsWith("worktree"),
                            ),
                          ),
                        },
                      },
                    }
                  : serverPatch.modelLanes !== undefined && environment.serverConfig
                    ? {
                        // A track save names one lane; each machine keeps its other lane.
                        ...serverPatch,
                        modelLanes: {
                          ...environment.serverConfig.settings.modelLanes,
                          ...serverPatch.modelLanes,
                        },
                      }
                    : serverPatch,
            }))
          : [];
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || serverWrites.length > 0;
  const unavailableReason =
    hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : unscopableKeys.length > 0
          ? "This setting is environment-wide and cannot be overridden by a project."
          : isProjectScope
            ? "Connect the selected checkouts, or update their environments, to save a project override."
            : `Connect ${scope.kind === "environment" ? scope.label : "an environment"} to save this setting.`;
  return { clientPatch, hasClientWrite, serverWrites, unavailableReason };
}

/** Remove the keys' project overrides so each member inherits its environment value again. */
export function planScopedSettingsClear(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const serverWrites =
    scope.kind === "project" || scope.kind === "checkout"
      ? projectOverrideWrites(scope, environments, () => ({ clear: [...keys] }))
      : [];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0
        ? null
        : "Connect the selected checkouts, or update their environments, to reset this override.",
  };
}

/**
 * Remove one field of a field-wise key from each member's project override,
 * so that field follows the machine again and the project's other fields stay.
 * Members whose override does not hold the field are left alone.
 */
export function planScopedSettingFieldClear(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  key: ProjectFieldSettingKey,
  field: string,
) {
  const serverWrites =
    scope.kind === "project" || scope.kind === "checkout"
      ? projectOverrideWrites(scope, environments, (settings, projectId) =>
          projectOverrideFieldClearChange(settings.projectSettingsOverrides[projectId], key, field),
        )
      : [];
  const writable =
    (scope.kind === "project" || scope.kind === "checkout") &&
    scope.members.some((member) =>
      environments.some(
        (environment) =>
          environment.environmentId === member.environmentId &&
          environment.connection.phase === "connected" &&
          environment.serverConfig?.environment?.capabilities.projectSettingsOverrides === true,
      ),
    );
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    // Nothing to remove is not an error; only an unreachable project is.
    unavailableReason:
      serverWrites.length > 0 || writable
        ? null
        : "Connect the selected checkouts, or update their environments, to reset this override.",
  };
}

export interface ProjectOverrideEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * The projects on the selected environments that override `keys`. An
 * environment edit leaves these untouched, so the row can name them and
 * offer to clear them.
 */
export function listProjectOverrides(
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly (keyof ServerSettings)[],
): readonly ProjectOverrideEntry[] {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0) return [];
  return environments.flatMap((environment) => {
    const overrides = environment.serverConfig?.settings.projectSettingsOverrides;
    if (!overrides) return [];
    return Object.entries(overrides).flatMap(([projectId, entry]) =>
      scoped.some((key) => Object.hasOwn(entry, key))
        ? [{ environmentId: environment.environmentId, projectId: projectId as ProjectId }]
        : [],
    );
  });
}

/** Drop `keys` from the named project entries so they follow the environment again. */
export function planProjectOverridesClear(
  environments: readonly ScopedSettingsEnvironment[],
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const connected = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const serverWrites = projectOverrideChangeWrites(
    environments,
    entries.filter((entry) => connected.has(entry.environmentId)),
    () => ({ clear: [...keys] }),
  );
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0 ? null : "Connect the environments to reset these overrides.",
  };
}

/** One project's override change on one machine: values to set, keys to clear, or both. */
export interface ProjectOverrideEdit extends ProjectOverrideEntry {
  readonly set?: ProjectSettingsOverrides;
  readonly clear?: readonly ProjectScopedServerSettingKey[];
}

/**
 * Apply per-entry override edits. Undo uses it too: each machine gets back
 * its own previous value, which can differ from the others'.
 */
export function planProjectOverrideEdits(
  environments: readonly ScopedSettingsEnvironment[],
  edits: readonly ProjectOverrideEdit[],
) {
  const connected = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const byEntry = new Map(edits.map((edit) => [`${edit.environmentId}\n${edit.projectId}`, edit]));
  const serverWrites = projectOverrideChangeWrites(
    environments,
    edits.filter((edit) => connected.has(edit.environmentId)),
    (_settings, projectId, environmentId) => {
      const edit = byEntry.get(`${environmentId}\n${projectId}`);
      return {
        ...(edit?.set ? { set: edit.set } : {}),
        ...(edit?.clear && edit.clear.length > 0 ? { clear: [...edit.clear] } : {}),
      };
    },
  );
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0 ? null : "Connect the environments to change these overrides.",
  };
}

/** Edits that put back each entry's stored value for `key` (undefined: it had no override). */
export function undoProjectOverrideEdits(
  key: ProjectScopedServerSettingKey,
  previous: readonly (ProjectOverrideEntry & { readonly rawValue: unknown })[],
): ProjectOverrideEdit[] {
  return previous.map(({ environmentId, projectId, rawValue }) =>
    rawValue === undefined
      ? { environmentId, projectId, clear: [key] }
      : { environmentId, projectId, set: { [key]: rawValue } as ProjectSettingsOverrides },
  );
}

/** The part of a plan that writes only to `environmentIds`, for undoing what actually saved. */
export function restrictPlanToEnvironments<
  T extends { readonly serverWrites: readonly ScopedServerWrite[] },
>(plan: T, environmentIds: ReadonlySet<EnvironmentId>): T {
  return {
    ...plan,
    serverWrites: plan.serverWrites.filter((write) => environmentIds.has(write.environmentId)),
  };
}

/** Wait for every target so a failed environment does not hide successful or later writes. */
export async function persistScopedSettingsPatch(
  plan: ReturnType<typeof planScopedSettingsPatch>,
  persistServer: (input: {
    environmentId: EnvironmentId;
    input: { patch: ServerSettingsPatch };
  }) => Promise<{ readonly _tag: "Success" | "Failure" }>,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const results = await Promise.allSettled(
    plan.serverWrites.map(({ environmentId, patch }) =>
      persistServer({ environmentId, input: { patch } }),
    ),
  );
  const failedEnvironments = plan.serverWrites.filter((_, index) => {
    const result = results[index];
    return result?.status !== "fulfilled" || result.value._tag === "Failure";
  });
  return {
    failedEnvironments,
    savedEnvironmentCount: plan.serverWrites.length - failedEnvironments.length,
  };
}

/** The fields of `patch` whose value differs from what the target resolves to now. */
function changedFields(
  patch: Record<string, unknown>,
  effective: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([field, value]) =>
        value !== undefined && JSON.stringify(value) !== JSON.stringify(effective[field]),
    ),
  );
}
