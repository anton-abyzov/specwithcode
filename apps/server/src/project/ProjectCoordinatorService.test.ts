// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ProjectWorkspaceError,
  SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
  type Project,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Coordinator from "./ProjectCoordinatorService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";
import * as Projects from "./ProjectService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { provider } from "../studio/fixtures.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ServiceUpdateInProgressError } from "../serviceUpdate/ServiceUpdateHold.ts";
import { UnopenableHolds, UsageLimitHolds } from "../orchestration-v2/UnopenableHolds.ts";

const id = ProjectId.make("project:coordinator");
const commandId = CommandId.make("request:one");
const model = { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" };
const fixture = (afterCoordinatorLaunch: Effect.Effect<void> = Effect.void) => {
  let providers: ReadonlyArray<ServerProvider> = [];
  let serverSettings = DEFAULT_SERVER_SETTINGS;
  let project: Project = {
    id,
    title: "Project",
    workspaceRoot: "/tmp/fixture",
    repositoryIdentity: null,
    defaultModelSelection: model,
    defaultThreadEnvMode: null,
    autoPull: false,
    projectIcon: null,
    faviconPath: null,
    scripts: [],
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    deletedAt: null,
    workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS },
  };
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const launches: Launch.ThreadLaunchInput[] = [];
  const sends: Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0][] = [];
  const receipts = new Set<string>();
  const runs: OrchestrationV2Run[] = [];
  const turnItems: Array<{ type: string; failure?: { class: string } }> = [];
  const updates: Projects.ProjectUpdateInput[] = [];
  let sendFailure: unknown = null;
  const dependencies = Layer.mergeAll(
    Layer.mock(EventSink.EventSinkV2)({ readByCommandId: () => Stream.empty }),
    Layer.mock(Projects.ProjectService)({
      getById: () => Effect.sync(() => (project.deletedAt ? Option.none() : Option.some(project))),
      update: (input) =>
        Effect.sync(() => {
          updates.push(input);
          const previous = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
          const { expectedRevision: _expected, ...patch } = input.workspaceSettings ?? {};
          project = {
            ...project,
            workspaceSettings: {
              ...previous,
              ...Object.fromEntries(
                Object.entries(patch).filter(([, value]) => value !== undefined),
              ),
              coordinatorThreadId: input.coordinatorThreadId ?? previous.coordinatorThreadId,
              revision: previous.revision + 1,
            },
          };
          return project;
        }),
    }),
    Layer.mock(Workspace.ProjectWorkspaceService)({
      assertAdmission: () =>
        Effect.suspend(() =>
          project.deletedAt ||
          project.workspaceSettings?.paused ||
          project.workspaceSettings?.archived
            ? Effect.fail(
                new ProjectWorkspaceError({
                  projectId: id,
                  code: project.deletedAt
                    ? "not_found"
                    : project.workspaceSettings?.paused
                      ? "paused"
                      : "archived",
                }),
              )
            : Effect.void,
        ),
      readWorkspace: () =>
        Effect.sync(() => ({
          settings: project.workspaceSettings!,
          memory: { files: [], totalBytes: 0 },
        })),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
      sendToThread: (input) =>
        sendFailure !== null
          ? (Effect.fail(sendFailure) as never)
          : Effect.sync(() => {
              if (!receipts.has(input.commandId)) {
                receipts.add(input.commandId);
                sends.push(input);
              }
              return {
                message: { attachments: input.attachments },
              } as Threads.ThreadManagementSendResult;
            }),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          const threadId = input.threadId!;
          shells.set(threadId, {
            ...liveThreadShell(threadId, { activeRunId: null }),
            projectId: id,
          });
          return { threadId, resumed: false } as Launch.ThreadLaunchResult;
        }).pipe(Effect.tap(() => afterCoordinatorLaunch)),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.sync(() => serverSettings),
    }),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.sync(() => providers),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: (() => Effect.sync(() => ({ runs, turnItems }))) as never,
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "project-coordinator-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    dependencies,
    updates,
    launches,
    sends,
    shells,
    runs,
    turnItems,
    get project() {
      return project;
    },
    setProject: (patch: Partial<Project>) => {
      project = { ...project, ...patch };
    },
    setProviders: (next: ReadonlyArray<ServerProvider>) => {
      providers = next;
    },
    setSettings: (patch: Partial<ServerSettings>) => {
      serverSettings = { ...serverSettings, ...patch };
    },
    setSendFailure: (failure: unknown) => {
      sendFailure = failure;
    },
  };
};

const readyWithUsage = (
  instance: string,
  driver: string,
  usedPercent: number,
  checkedAt = "2026-10-13T00:00:00Z",
): ServerProvider => ({
  ...provider(instance, driver),
  models: [
    {
      slug: `${driver}-model`,
      name: "Default",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  usageLimits: {
    checkedAt,
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent,
        resetsAt: "2099-01-01T00:00:00Z",
      },
    ],
  },
});

it.effect("keeps coordinator usage fallback inside the project's approved folder support", () =>
  Effect.gen(function* () {
    const f = fixture();
    // A usage fallback only trusts a read taken within the last few minutes.
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const native = readyWithUsage("claude", "claudeAgent", 100, observedAt);
    const copilot = readyWithUsage("copilot", "acpRegistry", 10, observedAt);
    const codex = readyWithUsage("codex", "codex", 20, observedAt);
    f.setProject({
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        coordinatorModelSelection: model,
        environment: { additionalFolders: ["/approved-a", "/approved-b"], repositories: [] },
      },
    });
    f.setSettings({
      ...DEFAULT_SERVER_SETTINGS,
      providerLimitAction: "switch",
      providerLimitSwitchAtPercent: 95,
    });
    f.setProviders([native, copilot, codex]);
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      const { threadId } = yield* service.start({ projectId: id, commandId });
      // An existing fallback on ACP must not be kept when the saved model is full.
      f.shells.set(threadId, {
        ...f.shells.get(threadId)!,
        modelSelection: { instanceId: copilot.instanceId, model: "opus" },
        runtimeMode: "approval-required",
      });
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:compatible-fallback"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual({
        instanceId: codex.instanceId,
        model: "codex-model",
      });
      expect(f.project.workspaceSettings?.coordinatorModelSelection).toEqual(model);
      // Without compatible headroom, keep the native choice instead of choosing ACP.
      f.setProviders([native, copilot]);
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:no-compatible-fallback"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(model);
      expect(f.project.workspaceSettings?.coordinatorModelSelection).toEqual(model);
    }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
  }),
);

it.effect("rejects incompatible saved or active ACP after coordinator selection recovery", () =>
  Effect.gen(function* () {
    for (const saved of [{ instanceId: ProviderInstanceId.make("copilot"), model: "opus" }, null]) {
      const f = fixture();
      const threadId = ThreadId.make("existing-coordinator");
      const current =
        saved === null
          ? { instanceId: ProviderInstanceId.make("copilot"), model: "opus" }
          : { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" };
      f.shells.set(threadId, {
        ...liveThreadShell(threadId),
        projectId: id,
        modelSelection: current,
        runtimeMode: "approval-required",
      });
      f.setProject({
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          coordinatorThreadId: threadId,
          coordinatorModelSelection: saved,
          environment: { additionalFolders: ["/approved"], repositories: [] },
        },
      });
      f.setProviders([
        readyWithUsage("copilot", "acpRegistry", 10),
        readyWithUsage("codex", "codex", 20),
      ]);
      yield* Effect.gen(function* () {
        const service = yield* Coordinator.ProjectCoordinatorService;
        const error = yield* service
          .send({ projectId: id, commandId, prompt: "Next" })
          .pipe(Effect.flip);
        expect(error.code).toBe("unsupported_provider");
        expect(error.message).toContain("Codex or Claude");
        expect(f.sends).toHaveLength(0);
        expect(f.launches).toHaveLength(0);
        expect(f.updates).toHaveLength(0);
        expect(f.project.workspaceSettings?.coordinatorModelSelection).toEqual(saved);
      }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
    }
  }),
);

it.effect(
  "chooses a compatible automatic coordinator default without overriding a saved ACP choice",
  () =>
    Effect.gen(function* () {
      for (const explicit of [false, true]) {
        const f = fixture();
        const copilot = readyWithUsage("copilot", "acpRegistry", 10);
        const codex = readyWithUsage("codex", "codex", 20);
        const saved = explicit ? { instanceId: copilot.instanceId, model: "opus" } : null;
        f.setSettings({ defaultRuntimeMode: "approval-required" });
        f.setProject({
          defaultModelSelection: null,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            coordinatorModelSelection: saved,
            environment: { additionalFolders: ["/approved"], repositories: [] },
          },
        });
        f.setProviders([copilot, codex]);
        yield* Effect.gen(function* () {
          const service = yield* Coordinator.ProjectCoordinatorService;
          if (explicit) {
            const error = yield* service.start({ projectId: id, commandId }).pipe(Effect.flip);
            expect(error.code).toBe("unsupported_provider");
            expect(f.updates).toHaveLength(0);
            expect(f.launches).toHaveLength(0);
            expect(f.project.workspaceSettings?.coordinatorModelSelection).toEqual(saved);
          } else {
            yield* service.start({ projectId: id, commandId });
            expect(f.launches[0]?.modelSelection).toEqual({
              instanceId: codex.instanceId,
              model: "codex-model",
            });
          }
        }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
      }
    }),
);
it.effect(
  "preserves a full-access ACP coordinator using its existing policy instead of new defaults",
  () =>
    Effect.gen(function* () {
      for (const interactionMode of ["default", "plan"] as const) {
        const f = fixture();
        const copilot = readyWithUsage("copilot", "acpRegistry", 10);
        const saved = { instanceId: copilot.instanceId, model: "opus" };
        f.setProject({
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            coordinatorModelSelection: saved,
            environment: { additionalFolders: ["/approved"], repositories: [] },
          },
        });
        f.setSettings({ defaultRuntimeMode: "full-access" });
        f.setProviders([copilot]);
        yield* Effect.gen(function* () {
          const service = yield* Coordinator.ProjectCoordinatorService;
          const { threadId } = yield* service.start({ projectId: id, commandId });
          expect(f.launches[0]?.modelSelection).toEqual(saved);
          expect(f.launches[0]?.runtimeMode).toBe("full-access");
          f.shells.set(threadId, {
            ...f.shells.get(threadId)!,
            runtimeMode: "full-access",
            interactionMode,
          });
          f.setSettings({ defaultRuntimeMode: "approval-required" });
          const request = service.send({
            projectId: id,
            commandId: CommandId.make("policy:" + interactionMode),
            prompt: "Next",
          });
          if (interactionMode === "default") {
            yield* request;
            expect(f.sends.at(-1)?.modelSelection).toEqual(saved);
          } else {
            expect((yield* request.pipe(Effect.flip)).code).toBe("unsupported_provider");
            expect(f.sends).toHaveLength(0);
          }
          expect(f.project.workspaceSettings?.coordinatorModelSelection).toEqual(saved);
        }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
      }
    }),
);
it.effect(
  "launches with the project's approval mode instead of the host's full-access default",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.setSettings({
        defaultRuntimeMode: "full-access",
        projectSettingsOverrides: { [id]: { defaultRuntimeMode: "approval-required" } },
      });
      yield* Effect.gen(function* () {
        const service = yield* Coordinator.ProjectCoordinatorService;
        yield* service.start({ projectId: id, commandId });
      }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
      expect(f.launches).toHaveLength(1);
      expect(f.launches[0]?.runtimeMode).toBe("approval-required");
    }),
);
it.effect("inherits the host approval mode when only another project has a runtime override", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.setSettings({
      defaultRuntimeMode: "approval-required",
      projectSettingsOverrides: {
        [ProjectId.make("another-project")]: { defaultRuntimeMode: "full-access" },
      },
    });
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      yield* service.start({ projectId: id, commandId });
    }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]?.runtimeMode).toBe("approval-required");
  }),
);
it.effect(
  "serializes concurrent starts and finds the same retained coordinator after service restart",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const run = Effect.gen(function* () {
        const service = yield* Coordinator.ProjectCoordinatorService;
        return yield* Effect.all(
          [1, 2, 3].map(() => service.start({ projectId: id, commandId })),
          { concurrency: 3 },
        );
      });
      const first = yield* run.pipe(
        Effect.provide(Coordinator.layer),
        Effect.provide(f.dependencies),
      );
      expect(new Set(first.map((r) => r.threadId)).size).toBe(1);
      expect(f.launches).toHaveLength(1);
      const restarted = yield* run.pipe(
        Effect.provide(Coordinator.layer),
        Effect.provide(f.dependencies),
      );
      expect(restarted.every((r) => r.created === false)).toBe(true);
      expect(f.launches).toHaveLength(1);
    }),
);
it.effect(
  "replays send identity and preserves source provenance without using worker model defaults",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const sourceThreadId = ThreadId.make("worker");
      f.shells.set(sourceThreadId, { ...liveThreadShell(sourceThreadId), projectId: id });
      yield* Effect.gen(function* () {
        const service = yield* Coordinator.ProjectCoordinatorService;
        const input = { projectId: id, commandId, prompt: "Continue this work", sourceThreadId };
        const result = yield* service.send(input);
        yield* service.send(input);
        expect(f.sends).toHaveLength(1);
        expect(f.sends[0]).toMatchObject({
          threadId: result.threadId,
          senderThreadId: sourceThreadId,
          createdBy: "user",
          creationSource: "web",
        });
        expect(f.sends[0]?.text).toContain(sourceThreadId);
        f.setProject({ defaultModelSelection: null });
        expect((yield* service.start({ projectId: id, commandId })).created).toBe(false);
      }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
    }),
);
it.effect("starts a coordinator nobody chose a model for on the host's default", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.setProject({ defaultModelSelection: null });
    f.setProviders([
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-10T00:00:00Z",
        version: null,
        models: [
          { slug: "claude-sonnet-5-5", name: "Sonnet", isCustom: false, capabilities: null },
          { slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      },
    ]);
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      expect((yield* service.start({ projectId: id, commandId })).created).toBe(true);
      expect(f.launches[0]?.modelSelection).toEqual({
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
      });
    }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
  }),
);
it.effect("saves the model a first launch fell back to together with the reservation", () =>
  Effect.gen(function* () {
    const f = fixture();
    // A project from before workspace settings: no settings row and no worker default.
    f.setProject({ defaultModelSelection: null, workspaceSettings: undefined });
    f.setProviders([
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-10T00:00:00Z",
        version: null,
        models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
        slashCommands: [],
        skills: [],
      },
    ]);
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      const { threadId } = yield* service.start({ projectId: id, commandId });
      expect(f.updates).toHaveLength(1);
      expect(f.updates[0]).toMatchObject({
        coordinatorThreadId: threadId,
        workspaceSettings: {
          expectedRevision: 0,
          coordinatorModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        },
      });
      expect(f.project.workspaceSettings).toMatchObject({
        kind: "code",
        revision: 1,
        coordinatorThreadId: threadId,
        coordinatorModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      });
      expect(f.launches[0]?.modelSelection).toEqual(
        f.project.workspaceSettings?.coordinatorModelSelection,
      );
    }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
  }),
);
it.effect("leaves a saved coordinator model alone when it binds the thread", () =>
  Effect.gen(function* () {
    const f = fixture();
    const saved = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
    f.setProject({
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        revision: 4,
        coordinatorModelSelection: saved,
      },
    });
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      yield* service.start({ projectId: id, commandId });
      expect(f.updates).toHaveLength(1);
      expect(f.updates[0]?.workspaceSettings).toBeUndefined();
      expect(f.launches[0]?.modelSelection).toEqual(saved);
    }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
  }),
);
it.effect.each(["deleted", "foreign"] as const)(
  "reports an unavailable %s coordinator without misleading memory guidance",
  (scenario) =>
    Effect.gen(function* () {
      const f = fixture();
      const threadId = ThreadId.make(`project-coordinator:${id}`);
      f.shells.set(threadId, {
        ...liveThreadShell(threadId),
        projectId: scenario === "foreign" ? ProjectId.make("another-project") : id,
        deletedAt: scenario === "deleted" ? DateTime.makeUnsafe("2026-10-13T00:00:00Z") : null,
      });
      yield* Effect.gen(function* () {
        const service = yield* Coordinator.ProjectCoordinatorService;
        const failure = yield* service.start({ projectId: id, commandId }).pipe(Effect.flip);
        expect(failure.code).toBe("invalid_coordinator");
        expect(failure.message).toContain("Reload the project");
        expect(failure.message).not.toMatch(/memory|KiB/);
        expect(f.launches).toHaveLength(0);
        expect(f.sends).toHaveLength(0);
      }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
    }),
);
it.effect("says a message was refused for an update instead of that the project failed", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      yield* service.start({ projectId: id, commandId });
      f.setSendFailure(
        new OrchestratorDispatchError({
          commandId: CommandId.make("request:two"),
          commandType: "message.dispatch",
          cause: new ServiceUpdateInProgressError({ action: "message.dispatch" }),
        }),
      );
      const refused = yield* service
        .send({ projectId: id, commandId: CommandId.make("request:two"), prompt: "Hello" })
        .pipe(Effect.flip);
      expect(refused.code).toBe("update_in_progress");
      expect(refused.message).toBe(SERVICE_UPDATE_IN_PROGRESS_MESSAGE);

      f.setSendFailure(new Error("database is locked"));
      const failed = yield* service
        .send({ projectId: id, commandId: CommandId.make("request:three"), prompt: "Hello" })
        .pipe(Effect.flip);
      expect(failed.code).toBe("operation_failed");
    }).pipe(Effect.provide(Coordinator.layer.pipe(Layer.provideMerge(f.dependencies))));
  }),
);

it.effect("rejects foreign sources, paused projects and missing model choices before launch", () =>
  Effect.gen(function* () {
    const f = fixture();
    const sourceThreadId = ThreadId.make("foreign");
    f.shells.set(sourceThreadId, liveThreadShell(sourceThreadId));
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      expect(
        (yield* service
          .send({ projectId: id, commandId, prompt: "Send", sourceThreadId })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_source_thread");
      f.setProject({ defaultModelSelection: null });
      expect((yield* service.start({ projectId: id, commandId }).pipe(Effect.flip)).code).toBe(
        "model_required",
      );
      f.setProject({ workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, paused: true } });
      expect((yield* service.start({ projectId: id, commandId }).pipe(Effect.flip)).code).toBe(
        "paused",
      );
      expect(f.launches).toHaveLength(0);
      expect(f.sends).toHaveLength(0);
    }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
  }),
);

it.effect(
  "routes an attachment-only worker reply through coordinator creation and native intake",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const sourceThreadId = ThreadId.make("attachment-worker");
      f.shells.set(sourceThreadId, { ...liveThreadShell(sourceThreadId), projectId: id });
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const attachment = {
          id: createPendingAttachmentId("txt"),
          type: "file" as const,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        };
        NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
        NodeFS.writeFileSync(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          "abc",
        );
        const service = yield* Coordinator.ProjectCoordinatorService;
        const result = yield* service.send({
          projectId: id,
          commandId,
          prompt: "",
          sourceThreadId,
          attachments: [attachment],
        });
        expect(f.launches).toHaveLength(1);
        expect(f.sends).toHaveLength(1);
        expect(f.sends[0]?.threadId).toBe(result.threadId);
        expect(f.sends[0]?.senderThreadId).toBe(sourceThreadId);
        const delivered = f.sends[0]!.attachments[0]!;
        expect(delivered.id).not.toBe(attachment.id);
        expect(
          NodeFS.readFileSync(
            resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: delivered,
            })!,
            "utf8",
          ),
        ).toBe("abc");
      }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
    }),
);

it.effect.each(["deleted", "foreign"] as const)(
  "rejects a selected worker becoming %s during coordinator creation without transferring its upload",
  (scenario) =>
    Effect.gen(function* () {
      const launched = yield* Deferred.make<void>();
      const continueLaunch = yield* Deferred.make<void>();
      const f = fixture(
        Deferred.succeed(launched, undefined).pipe(Effect.andThen(Deferred.await(continueLaunch))),
      );
      const sourceThreadId = ThreadId.make(`racing-worker-${scenario}`);
      const source = { ...liveThreadShell(sourceThreadId), projectId: id };
      f.shells.set(sourceThreadId, source);
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const attachment = {
          id: createPendingAttachmentId("txt"),
          type: "file" as const,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        };
        NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
        const stagedPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        })!;
        NodeFS.writeFileSync(stagedPath, "abc");
        const before = NodeFS.readdirSync(config.attachmentsDir, { recursive: true });
        const service = yield* Coordinator.ProjectCoordinatorService;
        const sending = yield* service
          .send({
            projectId: id,
            commandId,
            prompt: "Continue",
            sourceThreadId,
            attachments: [attachment],
          })
          .pipe(Effect.flip, Effect.forkScoped);
        // The initial source check has passed; ensure is still finishing coordinator creation.
        yield* Deferred.await(launched);
        f.shells.set(
          sourceThreadId,
          scenario === "deleted"
            ? { ...source, deletedAt: DateTime.makeUnsafe("2026-10-09T00:01:00Z") }
            : { ...source, projectId: ProjectId.make("other-project") },
        );
        yield* Deferred.succeed(continueLaunch, undefined);
        expect((yield* Fiber.join(sending)).code).toBe("invalid_source_thread");
        expect(f.launches).toHaveLength(1); // Reservation can precede the final admission check.
        expect(f.sends).toHaveLength(0);
        expect(NodeFS.readdirSync(config.attachmentsDir, { recursive: true })).toEqual(before);
        expect(NodeFS.readFileSync(stagedPath, "utf8")).toBe("abc");
      }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
    }).pipe(Effect.scoped),
);
it.effect("keeps a coordinator on its fallback while the saved model's provider is full", () =>
  Effect.gen(function* () {
    const f = fixture();
    const usage = (usedPercent: number) => ({
      checkedAt: "2026-10-10T00:00:00Z",
      windows: [
        {
          id: "five_hour",
          kind: "session" as const,
          label: "Session",
          usedPercent,
          resetsAt: "2099-01-01T00:00:00Z",
        },
      ],
    });
    const ready = (instance: string, driver: string, usedPercent: number): ServerProvider => ({
      instanceId: ProviderInstanceId.make(instance),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-10T00:00:00Z",
      version: null,
      models: [
        {
          slug: `${driver}-model`,
          name: "Model",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
      usageLimits: usage(usedPercent),
    });
    const fallback = { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" };
    f.setProject({
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        coordinatorModelSelection: model,
      },
    });
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      const { threadId } = yield* service.start({ projectId: id, commandId });
      // The limit rule moved the coordinator to Codex.
      f.shells.set(threadId, { ...f.shells.get(threadId)!, modelSelection: fallback });
      f.setProviders([ready("claude", "claudeAgent", 100), ready("codex", "codex", 20)]);
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:full"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(fallback);
      // Claude's last run failed after its last usage read: a stale read that
      // shows room does not pull the coordinator back.
      f.runs.push({
        providerInstanceId: model.instanceId,
        ordinal: 1,
        status: "failed",
        completedAt: DateTime.makeUnsafe("2098-12-31T00:00:00Z"),
      } as OrchestrationV2Run);
      f.turnItems.push({ type: "error", failure: { class: "usage_limit" } });
      f.setProviders([ready("claude", "claudeAgent", 10), ready("codex", "codex", 20)]);
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:stale"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(fallback);
      // The same failure for any other reason is no limit: Claude has room, so
      // the coordinator goes back to it.
      f.turnItems.length = 0;
      f.turnItems.push({ type: "error", failure: { class: "provider_error" } });
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:other-failure"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(model);
      f.runs.length = 0;
      f.turnItems.length = 0;
      // Claude has room again: the next message goes back to the saved model.
      f.setProviders([ready("claude", "claudeAgent", 10), ready("codex", "codex", 20)]);
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:room"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(model);
    }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
  }),
);

it.effect("keeps a coordinator off a provider a thread recently could not open", () =>
  Effect.gen(function* () {
    const f = fixture();
    const fallback = { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" };
    f.setProject({
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        coordinatorModelSelection: model,
      },
    });
    let held: ReadonlyMap<string, number> = new Map([[model.instanceId, 0]]);
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      const { threadId } = yield* service.start({ projectId: id, commandId });
      f.shells.set(threadId, { ...f.shells.get(threadId)!, modelSelection: fallback });
      // Both read as having room; only the hold says the saved one would not open.
      f.setProviders([
        readyWithUsage(model.instanceId, "claudeAgent", 10),
        readyWithUsage("codex", "codex", 20),
      ]);
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:held"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(fallback);
      held = new Map();
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:released"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(model);
    }).pipe(
      Effect.provide(Coordinator.layer.pipe(Layer.provideMerge(f.dependencies))),
      Effect.provideService(UnopenableHolds, {
        get: Effect.sync(() => held),
        set: () => Effect.void,
      }),
    );
  }),
);

it.effect("keeps a coordinator off a no-usage provider held on its limit", () =>
  Effect.gen(function* () {
    const f = fixture();
    const fallback = { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" };
    f.setProject({
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        coordinatorModelSelection: model,
      },
    });
    // The sweep holds a provider that reports no usage (Copilot) once a
    // thread stopped on its quota; nothing in its snapshot says it is full.
    let held: ReadonlyMap<string, number> = new Map([[model.instanceId, Number.MAX_SAFE_INTEGER]]);
    yield* Effect.gen(function* () {
      const service = yield* Coordinator.ProjectCoordinatorService;
      const { threadId } = yield* service.start({ projectId: id, commandId });
      f.shells.set(threadId, { ...f.shells.get(threadId)!, modelSelection: fallback });
      f.setProviders([
        readyWithUsage(model.instanceId, "claudeAgent", 10),
        readyWithUsage("codex", "codex", 20),
      ]);
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:quota-held"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(fallback);
      held = new Map();
      yield* service.send({
        projectId: id,
        commandId: CommandId.make("request:quota-released"),
        prompt: "Next",
      });
      expect(f.sends.at(-1)?.modelSelection).toEqual(model);
    }).pipe(
      Effect.provide(Coordinator.layer.pipe(Layer.provideMerge(f.dependencies))),
      Effect.provideService(UsageLimitHolds, {
        get: Effect.sync(() => held),
        set: () => Effect.void,
      }),
    );
  }),
);
