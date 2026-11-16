import {
  teamRulesFolderLaunchRefusal,
  teamRulesInstanceDriver,
  teamRulesInstanceHasLaunchValues,
  teamRulesTurnRefusal,
} from "@specweave-studio/shared/teamRules";
import { currentTeamRules, teamRulesForFolder } from "../teamRules/TeamRules.ts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  advisorGuidance,
  claudeBuiltInAdvisorModel,
  claudeSessionAdvisor,
  resolveAdvisor,
} from "@specweave-studio/shared/advisor";
import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  resolveAgentInstructions,
  type RuntimeMode,
  withServiceInstructions,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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
    // Optional: only the advisor reads provider snapshots here. Without them
    // no Claude pair is found, so a thread whose advisor is on consults
    // through the studio-code tool.
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
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
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
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
        const advisorChild = input.thread.purpose === "advisor";
        const advisorSettings = resolveProjectSettings(settings, input.thread.projectId).settings;
        const guidance = advisorGuidance({
          mode: input.thread.advisorMode,
          settings: advisorSettings.advisor,
          advisorChild,
        });
        const claudeAdvisor =
          driver !== "claudeAgent"
            ? undefined
            : yield* Effect.gen(function* () {
                const providers = Option.isSome(providerRegistry)
                  ? yield* providerRegistry.value.getProviders
                  : [];
                const decision = claudeSessionAdvisor({
                  advisorChild,
                  mode: input.thread.advisorMode,
                  settings: advisorSettings.advisor,
                  builtInModel: claudeBuiltInAdvisorModel({
                    providers,
                    thread: input.modelSelection,
                    advisor: resolveAdvisor({
                      providers,
                      thread: input.modelSelection,
                      model: advisorSettings.advisor.model,
                      reviewers: advisorSettings.adversarialReview.reviewers,
                      tier: advisorSettings.adversarialReview.tier,
                      tiers: advisorSettings.modelTiers,
                      sourceOrder: advisorSettings.defaultModelProviders,
                      excludedModels: advisorSettings.providerLimitExcludedModels,
                      nowMs: yield* Clock.currentTimeMillis,
                    }).advisor,
                  }),
                  // The adapter knows the session's context size and applies the limit.
                  contextTokens: null,
                  previousRoute: null,
                });
                return decision.kind === "inherit"
                  ? undefined
                  : decision.kind === "disable"
                    ? ({ kind: "disable" } as const)
                    : ({
                        kind: "model",
                        model: decision.model,
                        contextLimit: advisorSettings.advisor.builtInContextLimit,
                      } as const);
              });
        return ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          // An advisor only reads: the provider's read-only sandbox where it
          // has one, and nothing to approve because nothing may be written.
          ...(advisorChild ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } : {}),
          agentInstructions: [
            withServiceInstructions(
              resolveAgentInstructions({
                globalInstructions: settings.agentInstructions,
                projectInstructions: projectOverrides?.agentInstructions,
              }),
            ),
            ...(guidance === null ? [] : [guidance]),
          ].join("\n\n"),
          ...(guidance === null ? {} : { advisorGuidance: guidance }),
          ...(claudeAdvisor === undefined ? {} : { claudeAdvisor }),
          claudeWorkflowMode: projectOverrides?.claudeWorkflowMode ?? settings.claudeWorkflowMode,
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
