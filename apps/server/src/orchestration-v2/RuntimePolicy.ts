import {
  teamRulesFolderLaunchRefusal,
  teamRulesInstanceDriver,
  teamRulesInstanceHasLaunchValues,
  teamRulesTurnRefusal,
} from "@specweave-studio/shared/teamRules";
import { currentTeamRules, teamRulesForFolder } from "../teamRules/TeamRules.ts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  effectiveClaudeUltracodeDefault,
  ultracodeChatKind,
  ultracodeDefaultForChat,
} from "@specweave-studio/shared/ultracodeDefault";
import {
  type ClaudeUltracodeDefault,
  type ClaudeWorkflowMode,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  resolveAgentInstructions,
  type RuntimeMode,
  type ServerProvider,
  withServiceInstructions,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2RuntimePolicy as ProviderAdapterV2RuntimePolicyType,
} from "./ProviderAdapter.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectUsesWorktrees } from "../mcp/toolkits/project/launchWorkspace.ts";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapterV2RuntimePolicyType, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "specweave-studio/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    }),
});

/**
 * The mode a provider runs a thread in. A mode the provider does not offer
 * (a thread set before it stopped offering it, or a stale client) runs in
 * Supervised rather than having Studio imitate it.
 */
export function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    // Optional so hosts without the store (some tests) still resolve; there no
    // thread is a routine's.
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    // A routine's chat carries no marker of its own; the routine row names it.
    // Best effort: a store that cannot answer counts the chat as a routine's,
    // which keeps the Ultracode default off rather than failing the turn.
    const isRoutineThread = (threadId: string) =>
      Option.match(sql, {
        onNone: () => Effect.succeed(false),
        onSome: (client) =>
          client<{ readonly found: number }>`
            SELECT 1 AS found FROM scheduled_tasks WHERE thread_id = ${threadId} LIMIT 1
          `.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.catchCause((cause) =>
              Effect.logWarning("routine lookup for the Ultracode default failed", {
                threadId,
                cause,
              }).pipe(Effect.as(true)),
            ),
          ),
      });
    /**
     * What "Ultracode by default" gives this chat if its toggle is unset. The
     * routine lookup runs only when its answer could change the result.
     */
    function resolveUltracodeDefault(input: {
      readonly thread: OrchestrationV2AppThread;
      readonly project: ProjectStore.ProjectRow | null;
      readonly workflowMode: ClaudeWorkflowMode | undefined;
      readonly ultracodeDefault: ClaudeUltracodeDefault | undefined;
      readonly provider: ServerProvider | undefined;
      readonly model: string;
    }) {
      return Effect.gen(function* () {
        const project =
          input.project === null
            ? null
            : {
                id: input.project.projectId,
                workspaceSettings: input.project.workspaceSettings ?? null,
              };
        const kindInput = { threadId: input.thread.id, project, lineage: input.thread.lineage };
        let chatKind = ultracodeChatKind({ ...kindInput, routine: false });
        if (
          chatKind === "thread" &&
          input.workflowMode !== "disabled" &&
          effectiveClaudeUltracodeDefault(input.workflowMode, input.ultracodeDefault) ===
            "threads" &&
          (yield* isRoutineThread(input.thread.id))
        ) {
          chatKind = ultracodeChatKind({ ...kindInput, routine: true });
        }
        return ultracodeDefaultForChat({
          workflowMode: input.workflowMode,
          ultracodeDefault: input.ultracodeDefault,
          chatKind,
          provider: input.provider,
          model: input.model,
          nowMs: yield* Clock.currentTimeMillis,
        }).state;
      });
    }

    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                cause,
              }),
          ),
        );
        const projectOverrides = settings.projectSettingsOverrides[input.thread.projectId];
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const worktreePath = input.thread.worktreePath;
        const localProject =
          worktreePath === null
            ? yield* projects.get(input.thread.projectId).pipe(
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new RuntimePolicyResolveError({
                          projectId: input.thread.projectId,
                          providerInstanceId: input.modelSelection.instanceId,
                          cause: "Project not found.",
                        }),
                      ),
                    onSome: (project) => Effect.succeed(project),
                  }),
                ),
              )
            : null;
        const cwd = localProject === null ? worktreePath! : localProject.workspaceRoot;
        // Every provider turn passes here, whichever entry point started it, so
        // this is where Team rules hold. Refused, never lowered silently: the
        // message says what to change and the stored mode stays as it was.
        const driver =
          instance?.driverKind ??
          teamRulesInstanceDriver(settings, input.modelSelection.instanceId);
        const folderRules = yield* teamRulesForFolder(cwd);
        const teamRulesRefusal =
          teamRulesTurnRefusal(folderRules, {
            runtimeMode: input.thread.runtimeMode,
            driver,
            model: input.modelSelection.model,
            carried: input.thread.origin?.carried,
          }) ??
          teamRulesFolderLaunchRefusal(
            folderRules,
            yield* currentTeamRules,
            driver,
            teamRulesInstanceHasLaunchValues(
              settings,
              input.modelSelection.instanceId,
              driver,
              process.env,
            ),
          );
        if (teamRulesRefusal !== null) {
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause: teamRulesRefusal.message,
          });
        }
        // Read once: runtime modes here, sign-in and usage for the Ultracode default.
        const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
        const supportedRuntimeModes = snapshot?.supportedRuntimeModes;
        // A thread in the project's own checkout may not add a worktree while
        // the project's Use worktrees switch is off; with it on (an umbrella
        // folder, a coordinator) the agent may still make one itself.
        // A thread with its own folder outside the project folder gets a git
        // that refuses commits and branch switches in the project's clones.
        const threadFolderProject =
          worktreePath === null
            ? null
            : yield* projects.get(input.thread.projectId).pipe(
                Effect.map(Option.getOrNull),
                // Best effort: a store that cannot answer leaves the thread without the guard.
                Effect.catchCause(() => Effect.succeed(null)),
              );
        const manualWorktreesBlocked =
          localProject !== null
            ? !projectUsesWorktrees(
                resolveProjectSettings(settings, input.thread.projectId, localProject),
              )
            : threadFolderProject !== null &&
                worktreePath !== null &&
                !isInsideFolder(threadFolderProject.workspaceRoot, worktreePath)
              ? threadFolderProject.workspaceRoot
              : false;
        const claudeWorkflowMode =
          projectOverrides?.claudeWorkflowMode ?? settings.claudeWorkflowMode;
        const claudeUltracodeDefault =
          driver === "claudeAgent"
            ? yield* resolveUltracodeDefault({
                thread: input.thread,
                project: localProject ?? threadFolderProject,
                workflowMode: claudeWorkflowMode,
                ultracodeDefault:
                  projectOverrides?.claudeUltracodeDefault ?? settings.claudeUltracodeDefault,
                provider: snapshot,
                model: input.modelSelection.model,
              })
            : undefined;
        return ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          agentInstructions: withServiceInstructions(
            resolveAgentInstructions({
              globalInstructions: settings.agentInstructions,
              projectInstructions: projectOverrides?.agentInstructions,
            }),
          ),
          claudeWorkflowMode,
          ...(claudeUltracodeDefault === undefined ? {} : { claudeUltracodeDefault }),
          responseStyle: projectOverrides?.responseStyle ?? settings.responseStyle,
          preferSpecWithCodeBrowser: settings.preferSpecWithCodeBrowser,
          manualWorktreesBlocked,
        });
      }),
    });
  }),
);

/** Whether `candidate` is `folder` or below it, by path text on either separator. */
function isInsideFolder(folder: string, candidate: string): boolean {
  const base = folder.replace(/[\\/]+$/u, "");
  return (
    candidate === base || candidate.startsWith(`${base}/`) || candidate.startsWith(`${base}\\`)
  );
}

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
