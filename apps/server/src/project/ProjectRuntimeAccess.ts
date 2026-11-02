/** Project permission saves update current chats and the default for new chats. */
import { teamRulesClampMode, teamRulesModeRefusal } from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ServerSettingsError,
  isProviderNativeSubagentThread,
  type ServerSettingsPatch,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

type SettingsService = ServerSettings.ServerSettingsService["Service"];
export class ProjectRuntimeAccess extends Context.Service<
  ProjectRuntimeAccess,
  {
    readonly updateSettings: (
      patch: ServerSettingsPatch,
      mutation?: Parameters<SettingsService["updateProviderInstance"]>[0],
    ) => ReturnType<SettingsService["updateSettings"]>;
  }
>()("studio/project/ProjectRuntimeAccess") {}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return ProjectRuntimeAccess.of({
    updateSettings: (patch, mutation) =>
      orchestrator.withProjectPermissionUpdate(
        Effect.gen(function* () {
          // A save names a mode even when it is the one already stored, so it is
          // judged here too: the settings check only sees what changed.
          const rules = yield* currentTeamRules;
          for (const value of [
            ...Object.values(patch.projectSettingsOverrides ?? {}),
            ...Object.values(patch.projectSettingsOverrideChanges ?? {}).map(
              (change) => change.set,
            ),
          ]) {
            const mode = value?.defaultRuntimeMode;
            const refused = mode === undefined ? null : teamRulesModeRefusal(rules, mode);
            if (refused !== null) {
              return yield* new ServerSettingsError({
                settingsPath: "project chat permissions",
                operation: "write-file",
                teamRulesRefusal: refused,
              });
            }
          }
          const saved = yield* mutation === undefined
            ? settings.updateSettings(patch)
            : settings.updateProviderInstance(mutation, patch);
          // A global default remains a default. Only an explicit project save changes existing chats.
          const projects = [
            ...new Set([
              ...Object.entries(patch.projectSettingsOverrides ?? {})
                .filter(([, value]) => value === null || Object.hasOwn(value, "defaultRuntimeMode"))
                .map(([id]) => id),
              ...Object.entries(patch.projectSettingsOverrideChanges ?? {})
                .filter(
                  ([, change]) =>
                    Object.hasOwn(change.set ?? {}, "defaultRuntimeMode") ||
                    (change.clear ?? []).includes("defaultRuntimeMode"),
                )
                .map(([id]) => id),
            ]),
          ].map((id) => ProjectId.make(id));
          if (projects.length === 0) return saved;
          const batchId = NodeCrypto.randomUUID();
          yield* Effect.gen(function* () {
            const snapshot = yield* orchestrator.getShellSnapshot();
            const threads = new Map(
              [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => [
                thread.id,
                thread,
              ]),
            );
            const failures: string[] = [];
            for (const thread of threads.values()) {
              if (
                !projects.includes(thread.projectId) ||
                thread.deletedAt !== null ||
                isProviderNativeSubagentThread(thread)
              )
                continue;
              const runtimeMode = teamRulesClampMode(
                rules,
                saved.projectSettingsOverrides[thread.projectId]?.defaultRuntimeMode ??
                  saved.defaultRuntimeMode,
              );
              if (thread.runtimeMode === runtimeMode) continue;
              yield* orchestrator
                .dispatch({
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make(`project-access:${batchId}:${thread.id}`),
                  threadId: thread.id,
                  runtimeMode,
                  applyOnNextTurn: true,
                })
                .pipe(
                  Effect.catch(() => {
                    failures.push(thread.id);
                    return Effect.void;
                  }),
                );
            }
            if (failures.length > 0)
              return yield* Effect.fail(
                new Error(
                  `Project permissions were saved, but ${failures.length} chats could not be updated. Save the project permission again to retry.`,
                ),
              );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath:
                    "project chat permissions (default saved; retry to finish applying)",
                  operation: "write-file",
                  cause,
                }),
            ),
          );
          return saved;
        }),
      ),
  });
});
export const layer = Layer.effect(ProjectRuntimeAccess, make);
