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
  type Project,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
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
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const id = ProjectId.make("project:coordinator");
const commandId = CommandId.make("request:one");
const model = { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" };
const fixture = (afterCoordinatorLaunch: Effect.Effect<void> = Effect.void) => {
  let providers: ReadonlyArray<ServerProvider> = [];
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
  const updates: Projects.ProjectUpdateInput[] = [];
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
        Effect.sync(() => {
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
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.sync(() => providers),
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
    get project() {
      return project;
    },
    setProject: (patch: Partial<Project>) => {
      project = { ...project, ...patch };
    },
    setProviders: (next: ReadonlyArray<ServerProvider>) => {
      providers = next;
    },
  };
};
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
      ).toBe("invalid");
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
        expect((yield* Fiber.join(sending)).code).toBe("invalid");
        expect(f.launches).toHaveLength(1); // Reservation can precede the final admission check.
        expect(f.sends).toHaveLength(0);
        expect(NodeFS.readdirSync(config.attachmentsDir, { recursive: true })).toEqual(before);
        expect(NodeFS.readFileSync(stagedPath, "utf8")).toBe("abc");
      }).pipe(Effect.provide(Coordinator.layer), Effect.provide(f.dependencies));
    }).pipe(Effect.scoped),
);
