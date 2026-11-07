import { AuthSettingsWriteScope } from "@specweave-studio/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@specweave-studio/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ServerSettings,
  type UnifiedSettings,
} from "@specweave-studio/contracts";
import { useCallback, useMemo } from "react";

import {
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  useClientSettings,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestConfirmDialog } from "../../confirmDialog";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverrideEdits,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  restrictPlanToEnvironments,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

/** Effective settings for the representative target: project overrides applied on top of its environment. */
export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = target?.settings ?? DEFAULT_SERVER_SETTINGS;
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

/** Where the keys' effective values come from across the selected targets. */
export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

type ScopedPlan = ReturnType<typeof planScopedSettingsPatch>;

/** What a successful change tells the user, and the plan that reverses it. */
export interface ScopedPlanFeedback {
  readonly title: string;
  readonly description?: string;
  /** Restricted to the environments that saved before it runs; Undo is offered only when set. */
  readonly undo?: ScopedPlan;
}

export interface ScopedPlanResult {
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly failedLabels: readonly string[];
}

const NOT_RUN: ScopedPlanResult = { savedEnvironmentIds: new Set(), failedLabels: [] };

export function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const run = useCallback(
    async (plan: ScopedPlan, feedback?: ScopedPlanFeedback): Promise<ScopedPlanResult> => {
      if (plan.unavailableReason) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: plan.unavailableReason,
        });
        return NOT_RUN;
      }
      const { failedEnvironments, savedEnvironmentCount } = await persistScopedSettingsPatch(
        plan,
        async (request) => {
          const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
            (scope) => !readEnvironmentScope(request.environmentId, scope),
          );
          if (missing)
            return AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection cannot change these settings.",
                }),
              ),
            );
          return persistServer(request);
        },
        persistClientSettingsPatch,
      );
      const failed = new Set(failedEnvironments.map((environment) => environment.environmentId));
      const savedEnvironmentIds = new Set(
        plan.serverWrites
          .map((write) => write.environmentId)
          .filter((environmentId) => !failed.has(environmentId)),
      );
      const undo =
        feedback?.undo && savedEnvironmentIds.size > 0
          ? restrictPlanToEnvironments(feedback.undo, savedEnvironmentIds)
          : undefined;
      const undoAction =
        undo && undo.serverWrites.length > 0
          ? (id: () => string) => ({
              children: "Undo",
              onClick: () => {
                toastManager.close(id());
                void run(undo, { title: "Change undone" });
              },
            })
          : undefined;
      if (failedEnvironments.length > 0) {
        let id = "";
        id = toastManager.add({
          type: "error",
          title:
            savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
          description: `Could not update ${failedEnvironments.map((environment) => environment.label).join(", ")}.${savedEnvironmentCount > 0 ? " The other selected environments saved the change." : ""}`,
          ...(savedEnvironmentCount > 0 && undoAction ? { actionProps: undoAction(() => id) } : {}),
        });
      } else if (feedback) {
        let id = "";
        id = toastManager.add({
          type: "success",
          title: feedback.title,
          ...(feedback.description ? { description: feedback.description } : {}),
          ...(undoAction ? { actionProps: undoAction(() => id) } : {}),
        });
      }
      return {
        savedEnvironmentIds,
        failedLabels: failedEnvironments.map((environment) => environment.label),
      };
    },
    [persistServer],
  );
  return run;
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (patch: ScopedSettingsPatch) => void run(planScopedSettingsPatch(scope, environments, patch)),
    [environments, run, scope],
  );
}

/**
 * Drop the project overrides for `keys` so the selected checkouts inherit
 * again. Rows also render outside the settings layout (provider cards,
 * dialogs), where there is no scope and nothing to clear.
 */
export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      void run(planScopedSettingsClear(context.scope, context.environments, keys));
    },
    [context, run],
  );
}

/**
 * Clear `keys` on specific project entries, from an environment scope's chain
 * popover. Clearing more than one project asks first; every clear offers Undo.
 */
export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    async (
      entries: readonly ProjectOverrideEntry[],
      keys: readonly ProjectScopedServerSettingKey[],
      label: string,
    ) => {
      if (context === null || entries.length === 0) return;
      const machines = new Set(entries.map((entry) => entry.environmentId)).size;
      if (entries.length > 1) {
        const confirmed =
          (await requestConfirmDialog(
            `Reset "${label}" for ${entries.length} projects${machines > 1 ? ` on ${machines} machines` : ""}? They will follow the app setting. You can undo right after.`,
            { confirmLabel: `Reset ${entries.length} projects` },
          )) ?? true;
        if (!confirmed) return;
      }
      const undo = planProjectOverrideEdits(
        context.environments,
        entries.map((entry) => {
          const stored = context.environments.find(
            (environment) => environment.environmentId === entry.environmentId,
          )?.serverConfig?.settings.projectSettingsOverrides[entry.projectId];
          const kept = keys.filter((key) => stored !== undefined && Object.hasOwn(stored, key));
          return {
            ...entry,
            set: Object.fromEntries(
              kept.map((key) => [key, stored![key]]),
            ) as ProjectSettingsOverrides,
            clear: keys.filter((key) => !kept.includes(key)),
          };
        }),
      );
      await run(planProjectOverridesClear(context.environments, entries, keys), {
        title: `${label} follows the app setting`,
        description: entries.length === 1 ? "For 1 project." : `For ${entries.length} projects.`,
        undo,
      });
    },
    [context, run],
  );
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
