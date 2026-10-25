// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  type ChatAttachment,
  ChatAttachmentId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectWorkspaceError,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import { parseRoutedMessage } from "@specweave-studio/shared/routedMessage";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Coordinator from "../../../project/ProjectCoordinatorService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as Workspace from "../../../project/ProjectWorkspaceService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import { provider } from "../../../studio/fixtures.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

/**
 * The real routing tools and the real coordinator service over an in-memory
 * environment: Aide (personal), two projects inside its approved folders, one
 * outside them, one archived. Folders, real paths and attachment bytes are
 * real files in a temporary directory.
 */
const EPOCH = DateTime.makeUnsafe("2026-10-19T00:00:00.000Z");
const model = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };

function world(
  options: {
    readonly callerRuntimeMode?: RuntimeMode;
    /** The user's reply that started the turn, after the request it answers. */
    readonly turnReply?: string;
    readonly agentStartedTurn?: boolean;
    readonly callerInteractionMode?: "default" | "plan";
  } = {},
) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aide-route-")),
  );
  const dir = (...parts: string[]) => {
    const path = NodePath.join(root, ...parts);
    NodeFS.mkdirSync(path, { recursive: true });
    return path;
  };
  const aideRoot = dir("aide");
  const umb = dir("umb");
  const specweaveRoot = dir("umb", "repositories", "specweave");
  const easychampRoot = dir("easychamp");
  const outsideRoot = dir("outside");
  const archivedRoot = dir("umb", "repositories", "old");
  // A folder that does not exist yet, behind a link out of the approved folder.
  NodeFS.symlinkSync(outsideRoot, NodePath.join(umb, "escape"));
  // Approved through a symlink: the real path decides, not the spelling.
  NodeFS.symlinkSync(easychampRoot, NodePath.join(root, "easychamp-link"));

  const aideCoordinator = ThreadId.make("project-coordinator:aide");
  const specweaveCoordinator = ThreadId.make("project-coordinator:specweave");
  const make = (
    id: string,
    title: string,
    workspaceRoot: string,
    settings: Partial<NonNullable<ProjectRecord["workspaceSettings"]>> = {},
  ): ProjectRecord => ({
    id: ProjectId.make(id),
    title,
    workspaceRoot,
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
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      coordinatorModelSelection: model,
      ...settings,
    },
  });
  const projects = new Map<string, ProjectRecord>(
    [
      make("aide", "Aide", aideRoot, {
        kind: "personal",
        coordinatorThreadId: aideCoordinator,
        environment: {
          additionalFolders: [umb, NodePath.join(root, "easychamp-link")],
          repositories: [],
        },
      }),
      make("specweave", "specweave", specweaveRoot, {
        coordinatorThreadId: specweaveCoordinator,
        goal: "Ship SpecWeave.",
      }),
      make("easychamp", "EasyChamp", easychampRoot, { goal: "Grow EasyChamp." }),
      make("outside", "Hackathon", outsideRoot),
      make("old", "Old tool", archivedRoot, { archived: true }),
      make("ghost", "Ghost", NodePath.join(umb, "escape", "not-yet")),
    ].map((project) => [project.id, project]),
  );

  const shell = (
    id: ThreadId,
    projectId: string,
    patch: Partial<OrchestrationV2ThreadShell> = {},
  ): OrchestrationV2ThreadShell => ({
    ...liveThreadShell(id, { activeRunId: null }),
    projectId: ProjectId.make(projectId),
    status: "idle",
    ...patch,
  });
  const turnRun = RunId.make("run:aide:1");
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [
      aideCoordinator,
      shell(aideCoordinator, "aide", {
        title: "Aide coordinator",
        activeRunId: turnRun,
        status: "running",
        runtimeMode: options.callerRuntimeMode ?? "full-access",
        interactionMode: options.callerInteractionMode ?? "default",
      }),
    ],
    [
      specweaveCoordinator,
      shell(specweaveCoordinator, "specweave", { title: "specweave coordinator" }),
    ],
    [
      ThreadId.make("thread:docs"),
      shell(ThreadId.make("thread:docs"), "specweave", {
        title: "Docs typo fixes",
        status: "completed",
      }),
    ],
  ]);

  const requestId = MessageId.make("message:user-request");
  const agentId = MessageId.make("message:agent-note");
  const replyId = MessageId.make("message:user-reply");
  const turnMessageId = options.agentStartedTurn
    ? agentId
    : options.turnReply === undefined
      ? requestId
      : replyId;
  const config = { attachmentsDir: "" };
  const message = (
    id: MessageId,
    text: string,
    createdBy: "user" | "agent",
    attachments: ChatAttachment[] = [],
  ): OrchestrationV2ConversationMessage => ({
    id,
    threadId: aideCoordinator,
    runId: turnRun,
    nodeId: null,
    role: "user",
    text,
    attachments,
    streaming: false,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    createdBy,
    creationSource: "web",
  });
  const words =
    "Audit EasyChamp's signup flow and fix the typo in the SpecWeave docs. Screenshot attached.";
  const messages = new Map<ThreadId, OrchestrationV2ConversationMessage[]>();

  const sends: ThreadManagement.ThreadManagementSendInput[] = [];
  const launches: ThreadLaunch.ThreadLaunchInput[] = [];
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "session",
      thread: {
        threadId: aideCoordinator,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) => Effect.sync(() => Option.fromNullishOr(projects.get(id))),
      snapshot: Effect.sync(() => ({ projects: [...projects.values()] }) as never),
      update: (input) =>
        Effect.sync(() => {
          const previous = projects.get(input.projectId)!;
          const next = {
            ...previous,
            workspaceSettings: {
              ...previous.workspaceSettings!,
              coordinatorThreadId:
                input.coordinatorThreadId ?? previous.workspaceSettings!.coordinatorThreadId,
            },
          };
          projects.set(input.projectId, next);
          return next;
        }),
    }),
    Layer.mock(Workspace.ProjectWorkspaceService)({
      assertAdmission: (projectId) =>
        Effect.suspend(() => {
          const settings = projects.get(projectId)?.workspaceSettings;
          return settings?.archived || settings?.paused
            ? Effect.fail(
                new ProjectWorkspaceError({
                  projectId,
                  code: settings.archived ? "archived" : "paused",
                }),
              )
            : Effect.void;
        }),
      readWorkspace: ({ projectId }) =>
        Effect.sync(() => ({
          settings: projects.get(projectId)!.workspaceSettings!,
          memory: { files: [], totalBytes: 0 },
        })),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
      listProjectThreads: ({ projectId }) =>
        Effect.sync(() => [...shells.values()].filter((entry) => entry.projectId === projectId)),
      getThreadRecords: ((
        threadId: ThreadId,
        _fields: unknown,
        filter?: { messageIds?: string[] },
      ) =>
        Effect.sync(() => ({
          messages: (messages.get(threadId) ?? []).filter(
            (entry) => !filter?.messageIds || filter.messageIds.includes(entry.id),
          ),
          runs: threadId === aideCoordinator ? [{ id: turnRun, userMessageId: turnMessageId }] : [],
        }))) as never,
      sendToThread: (input) =>
        Effect.sync(() => {
          sends.push(input);
          const delivered = message(
            input.messageId,
            input.text,
            input.createdBy as "user" | "agent",
            [...input.attachments],
          );
          messages.set(input.threadId, [
            ...(messages.get(input.threadId) ?? []),
            { ...delivered, threadId: input.threadId, senderThreadId: input.senderThreadId },
          ]);
          return {
            message: { attachments: input.attachments },
          } as unknown as ThreadManagement.ThreadManagementSendResult;
        }),
    }),
    // A durable receipt per accepted send: the event the coordinator send checks on retry.
    Layer.mock(EventSink.EventSinkV2)({
      readByCommandId: ({ commandId }) =>
        Stream.fromIterable(
          sends
            .filter((send) => send.commandId === commandId)
            .map((send) => ({
              event: {
                type: "message.updated",
                threadId: send.threadId,
                payload: {
                  id: send.messageId,
                  threadId: send.threadId,
                  text: send.text,
                  senderThreadId: send.senderThreadId,
                  createdBy: send.createdBy,
                },
              },
            })) as never,
        ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          shells.set(
            input.threadId!,
            shell(input.threadId!, input.projectId, {
              title: input.title,
              runtimeMode: input.runtimeMode,
            }),
          );
          return { threadId: input.threadId!, resumed: false } as ThreadLaunch.ThreadLaunchResult;
        }),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          ...provider("claude", "claudeAgent"),
          models: [
            {
              slug: model.model,
              name: "Opus",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        },
      ]),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: (() => Effect.succeed({ runs: [], turnItems: [] })) as never,
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "aide-route-config-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const services = Coordinator.layer.pipe(Layer.provideMerge(dependencies));

  /** Stores the user's screenshot the way the app claims it into Aide's thread. */
  const seed = Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    config.attachmentsDir = serverConfig.attachmentsDir;
    NodeFS.mkdirSync(serverConfig.attachmentsDir, { recursive: true });
    const screenshot: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make("project-coordinator-aide-0b0f7a59-3c38-4d1e-9a51-6c1f1d2e3a40"),
      name: "signup.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    NodeFS.writeFileSync(
      resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment: screenshot,
      })!,
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    messages.set(aideCoordinator, [
      message(requestId, words, "user", [screenshot]),
      message(agentId, "A worker's report.", "agent"),
      ...(options.turnReply === undefined ? [] : [message(replyId, options.turnReply, "user")]),
    ]);
  });

  type Services = Layer.Success<typeof services>;
  const call = (
    name: string,
    params: object,
  ): Effect.Effect<Record<string, never>, never, Services> =>
    Effect.gen(function* () {
      // Built from the test's one set of services, so every call shares its store and files.
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer)),
      );
      const handle = toolkit.handle as unknown as (
        name: string,
        params: object,
      ) => Effect.Effect<Stream.Stream<{ readonly result: unknown }>>;
      const output = yield* handle(name, params).pipe(Stream.unwrap, Stream.runCollect);
      return Array.from(output).at(-1)?.result as Record<string, never>;
    }) as unknown as Effect.Effect<Record<string, never>, never, Services>;

  return {
    root,
    umb,
    projects,
    shells,
    sends,
    launches,
    config,
    seed,
    call,
    services,
    requestId,
    agentId,
    words,
    aideCoordinator,
    specweaveCoordinator,
  };
}

const ASKED = "fix the typo in the SpecWeave docs";

const run = <A, E>(
  w: ReturnType<typeof world>,
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof world>["services"]>>,
) =>
  effect.pipe(
    Effect.provide(w.services),
    Effect.orDie,
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(w.root, { recursive: true, force: true }))),
  );

it.effect(
  "lists only the projects inside Aide's approved folders, with reasons for the rest",
  () => {
    const w = world();
    return run(
      w,
      Effect.gen(function* () {
        yield* w.seed;
        const listed = yield* w.call("studio_route_targets", {});
        expect(listed.turnMessageId).toBe(w.requestId);
        const targets = listed.targets as unknown as Array<Record<string, unknown>>;
        expect(targets.map((target) => target.title).toSorted()).toEqual([
          "EasyChamp",
          "specweave",
        ]);
        const specweave = targets.find((target) => target.title === "specweave")!;
        expect(specweave.grantedBy).toBe(w.umb);
        expect(specweave.goal).toBe("Ship SpecWeave.");
        expect(specweave.recentThreads).toEqual([
          expect.objectContaining({ title: "Docs typo fixes", status: "completed" }),
        ]);
        // Approved through a symlink: the folder as the user saved it is the evidence.
        expect(targets.find((target) => target.title === "EasyChamp")!.grantedBy).toBe(
          NodePath.join(w.root, "easychamp-link"),
        );
        // No other project's memory or instructions travel with the list.
        expect(JSON.stringify(listed)).not.toContain("instructions");
        const unavailable = listed.unavailable as unknown as Array<{
          title: string;
          reason: string;
        }>;
        expect(unavailable.map((entry) => entry.title).toSorted()).toEqual([
          "Ghost",
          "Hackathon",
          "Old tool",
        ]);
        expect(unavailable.find((entry) => entry.title === "Hackathon")!.reason).toContain(
          "outside Aide's approved folders",
        );
        expect(unavailable.find((entry) => entry.title === "Old tool")!.reason).toContain(
          "archived",
        );
      }),
    );
  },
);

it.effect(
  "routes the user's words and screenshot to each owning coordinator once, starting one that is missing",
  () => {
    const w = world();
    return run(
      w,
      Effect.gen(function* () {
        yield* w.seed;
        const toEasyChamp = yield* w.call("studio_project_route", {
          projectId: "easychamp",
          note: "Yours: the signup audit.",
          userAsked: "Audit EasyChamp's signup flow",
        });
        expect(toEasyChamp).toMatchObject({
          projectTitle: "EasyChamp",
          coordinatorCreated: true,
          attachments: 1,
        });
        // The project had no coordinator: routing started it, bound to EasyChamp's folder.
        expect(w.launches).toHaveLength(1);
        expect(w.launches[0]).toMatchObject({
          projectId: "easychamp",
          workspaceStrategy: { type: "root" },
        });
        expect(w.sends).toHaveLength(1);
        const delivered = w.sends[0]!;
        expect(delivered).toMatchObject({
          projectId: "easychamp",
          createdBy: "user",
          senderThreadId: w.aideCoordinator,
        });
        expect(parseRoutedMessage(delivered.text)).toEqual({
          assistantTitle: "Aide",
          threadId: w.aideCoordinator,
          messageId: w.requestId,
          note: "Yours: the signup audit.",
          words: w.words,
        });
        // The screenshot was claimed into EasyChamp's coordinator with the same bytes.
        const file = delivered.attachments[0]!;
        expect(file.id.startsWith("project-coordinator-easychamp")).toBe(true);
        expect([
          ...NodeFS.readFileSync(
            resolveAttachmentPath({ attachmentsDir: w.config.attachmentsDir, attachment: file })!,
          ),
        ]).toEqual([0x89, 0x50, 0x4e, 0x47]);

        // A file planted at the derived pending name is replaced, never trusted.
        const planted = NodeFS.readdirSync(w.config.attachmentsDir).find((entry) =>
          entry.startsWith("pending-"),
        )!;
        NodeFS.writeFileSync(NodePath.join(w.config.attachmentsDir, planted), "evil");
        yield* w.call("studio_project_route", {
          projectId: "easychamp",
          note: "Yours: the signup audit.",
          userAsked: "Audit EasyChamp's signup flow",
        });
        expect([...NodeFS.readFileSync(NodePath.join(w.config.attachmentsDir, planted))]).toEqual([
          0x89, 0x50, 0x4e, 0x47,
        ]);
        expect(w.sends).toHaveLength(1);

        // A retry after the staged copy expired delivers nothing new.
        for (const entry of NodeFS.readdirSync(w.config.attachmentsDir))
          if (entry.startsWith("pending-"))
            NodeFS.rmSync(NodePath.join(w.config.attachmentsDir, entry));
        const retried = yield* w.call("studio_project_route", {
          projectId: "easychamp",
          note: "Yours: the signup audit.",
          userAsked: "Audit EasyChamp's signup flow",
        });
        expect(retried).toMatchObject({
          coordinatorCreated: false,
          messageId: toEasyChamp.messageId,
        });
        expect(w.sends).toHaveLength(1);

        // The same message, the other project's part: one copy there too.
        const toSpecweave = yield* w.call("studio_project_route", {
          projectId: "specweave",
          forwardMessageId: w.requestId,
          note: "Yours: the docs typo.",
          userAsked: "fix the typo in the SpecWeave docs",
        });
        expect(toSpecweave).toMatchObject({
          coordinatorThreadId: w.specweaveCoordinator,
          coordinatorCreated: false,
        });
        expect(w.sends).toHaveLength(2);
        expect(w.sends[1]!.threadId).toBe(w.specweaveCoordinator);
        expect(parseRoutedMessage(w.sends[1]!.text)?.note).toBe("Yours: the docs typo.");
        expect(w.launches).toHaveLength(1);
      }),
    );
  },
);

it.effect(
  "refuses projects outside the approved folders, archived ones and itself, sending nothing",
  () => {
    const w = world();
    return run(
      w,
      Effect.gen(function* () {
        yield* w.seed;
        const outside = yield* w.call("studio_project_route", {
          projectId: "outside",
          userAsked: ASKED,
        });
        expect(outside).toMatchObject({ code: "invalid_request" });
        expect(String(outside.message)).toContain("The user can add that folder");
        const archived = yield* w.call("studio_project_route", {
          projectId: "old",
          userAsked: ASKED,
        });
        expect(String(archived.message)).toContain("archived");
        const self = yield* w.call("studio_project_route", { projectId: "aide", userAsked: ASKED });
        expect(String(self.message)).toContain("own project");
        const missing = yield* w.call("studio_project_route", {
          projectId: "nope",
          userAsked: ASKED,
        });
        expect(missing).toMatchObject({ code: "invalid_request" });
        // Aide's approvals are unchanged: routing never grants itself a folder.
        expect(
          w.projects.get("aide")!.workspaceSettings!.environment.additionalFolders,
        ).toHaveLength(2);
        expect(w.sends).toHaveLength(0);
        expect(w.launches).toHaveLength(0);
      }),
    );
  },
);

it.effect("routes only what the user wrote", () => {
  const w = world();
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      const agentWritten = yield* w.call("studio_project_route", {
        projectId: "specweave",
        forwardMessageId: w.agentId,
        userAsked: ASKED,
      });
      expect(agentWritten).toMatchObject({ code: "invalid_request" });
      expect(w.sends).toHaveLength(0);
    }),
  );
});

it.effect("never hands work to a coordinator running in broader modes than Aide", () => {
  const w = world({ callerRuntimeMode: "approval-required" });
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      const escalated = yield* w.call("studio_project_route", {
        projectId: "specweave",
        userAsked: ASKED,
      });
      expect(escalated).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(w.sends).toHaveLength(0);
    }),
  );
});

it.effect("is not a tool for project coordinators or other threads", () => {
  const w = world();
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      // The same caller, once its project is an ordinary code project.
      const aide = w.projects.get("aide")!;
      w.projects.set("aide", {
        ...aide,
        workspaceSettings: { ...aide.workspaceSettings!, kind: "code" },
      });
      const denied = yield* w.call("studio_route_targets", {});
      expect(denied).toMatchObject({ code: "capability_denied" });
      const routed = yield* w.call("studio_project_route", {
        projectId: "specweave",
        userAsked: ASKED,
      });
      expect(routed).toMatchObject({ code: "capability_denied" });
      expect(w.sends).toHaveLength(0);
    }),
  );
});

it.effect("reports an interaction-mode escalation as one", () => {
  const w = world({ callerInteractionMode: "plan" });
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      const escalated = yield* w.call("studio_project_route", {
        projectId: "specweave",
        userAsked: ASKED,
      });
      expect(escalated).toMatchObject({ code: "interaction_mode_escalation_denied" });
      expect(w.sends).toHaveLength(0);
    }),
  );
});

it.effect("never lets an agent widen the folders, repositories or kind routing trusts", () => {
  const w = world();
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      const widened = yield* w.call("studio_project_update", {
        projectId: "aide",
        workspaceSettings: {
          expectedRevision: 0,
          environment: { additionalFolders: [w.root], repositories: [] },
        },
      });
      expect(String(widened.message)).toContain(
        "Agents cannot change approved folders or repositories themselves",
      );
      expect(String(widened.message)).toContain(
        "call studio_project_request with action add_folder and folder",
      );
      // Appending a repository widens what worktree threads reach, so it needs the user too,
      // even when the approved folders are sent back unchanged.
      const aideFolders = w.projects.get("aide")!.workspaceSettings!.environment.additionalFolders;
      const repository = yield* w.call("studio_project_update", {
        projectId: "aide",
        workspaceSettings: {
          expectedRevision: 0,
          environment: {
            additionalFolders: aideFolders,
            repositories: [{ id: "x", url: "https://github.com/a/b", localPath: null }],
          },
        },
      });
      expect(repository).toMatchObject({ code: "invalid_request" });
      expect(String(repository.message)).toContain("approved folders or repositories");
      expect(w.projects.get("aide")!.workspaceSettings!.environment.repositories).toHaveLength(0);
      const promoted = yield* w.call("studio_project_update", {
        projectId: "specweave",
        workspaceSettings: { expectedRevision: 0, kind: "personal" },
      });
      expect(String(promoted.message)).toContain("A project's kind is fixed when it is created");
    }),
  );
});

it.effect("posts into a project only when the user's own words ask for it", () => {
  const w = world();
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      // Words the user never wrote, such as work the assistant added on its own.
      const invented = yield* w.call("studio_project_route", {
        projectId: "easychamp",
        userAsked: "patch the PHP servers",
      });
      expect(invented).toMatchObject({ code: "invalid_request" });
      expect(String(invented.message)).toContain("stays separate from project chats");
      const blank = yield* w.call("studio_project_route", {
        projectId: "easychamp",
        userAsked: " … ",
      });
      expect(blank).toMatchObject({ code: "invalid_request" });
      expect(w.sends).toHaveLength(0);
      expect(w.launches).toHaveLength(0);

      // The user's words, whatever the quote marks and spacing, are enough.
      const routed = yield* w.call("studio_project_route", {
        projectId: "easychamp",
        userAsked: "“audit  easychamp’s SIGNUP flow”",
      });
      expect(routed).toMatchObject({ projectTitle: "EasyChamp" });
      expect(w.sends).toHaveLength(1);
    }),
  );
});

it.effect("routes an earlier request when the user's reply in this turn says to", () => {
  const w = world({ turnReply: "Yes, send it to SpecWeave." });
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      // Without forwardMessageId the reply itself would be routed; the request is.
      const routed = yield* w.call("studio_project_route", {
        projectId: "specweave",
        forwardMessageId: w.requestId,
        userAsked: "send it to SpecWeave",
      });
      expect(routed).toMatchObject({ coordinatorThreadId: w.specweaveCoordinator });
      expect(w.sends).toHaveLength(1);
      expect(parseRoutedMessage(w.sends[0]!.text)?.words).toBe(w.words);
    }),
  );
});

it.effect("refuses to replay an old user request from an agent-triggered turn", () => {
  const w = world({ agentStartedTurn: true });
  return run(
    w,
    Effect.gen(function* () {
      yield* w.seed;
      const routed = yield* w.call("studio_project_route", {
        projectId: "easychamp",
        forwardMessageId: w.requestId,
        userAsked: ASKED,
      });
      expect(routed).toMatchObject({ code: "invalid_request" });
      expect(String(routed.message)).toContain("stays separate from project chats");
      expect(w.sends).toHaveLength(0);
      expect(w.launches).toHaveLength(0);
    }),
  );
});
