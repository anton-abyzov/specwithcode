import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  type LinkedMemoryExport,
  type ProjectCoordinatorBinding,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import * as LinkedMemorySync from "./LinkedMemorySync.ts";
import { projectFixture } from "./ProjectWorkspace.testkit.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";

export const LOGICAL_ID = "logical:memory";
export const alpha = {
  environmentId: EnvironmentId.make("env-alpha"),
  projectId: ProjectId.make("alpha-copy"),
};
export const beta = {
  environmentId: EnvironmentId.make("env-beta"),
  projectId: ProjectId.make("beta-copy"),
};
export const members = [alpha, beta].map((member) => ({
  ...member,
  coordinatorThreadId: ThreadId.make(`coordinator:${member.projectId}`),
}));

/**
 * An update hold that is held while `held` is true. Given to a service layer
 * from outside, as the server provides the real hold to the whole runtime.
 */
export const holdLayer = (held: Ref.Ref<boolean>) =>
  Layer.mock(ServiceUpdateHold.ServiceUpdateHold)({
    isHeld: Ref.get(held),
    installGated: Ref.get(held),
    awaitReleased: Effect.void,
    current: Effect.succeedNone,
    recordRefusal: () => Effect.void,
    withAdmission: (_action, effect) => effect,
  });

/** One machine: its own database, memory, version history and sync service. */
export const machine = (
  self: typeof alpha,
  label: string,
  logicalProject: { id: string; members: typeof members } | null = {
    id: LOGICAL_ID,
    members,
  },
  kind: "code" | "personal" = "code",
  coordinatorBinding?: ProjectCoordinatorBinding,
  held?: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    const project = projectFixture(self.projectId, {
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        kind,
        ...(coordinatorBinding ? { coordinatorBinding } : {}),
        ...(logicalProject
          ? {
              logicalProject: {
                ...logicalProject,
                title: "Shared",
                coordinatorId: "coordinator",
              },
            }
          : {}),
      },
    });
    const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    const workspace = Workspace.layer.pipe(
      Layer.provideMerge(Layer.merge(storage, LinkedMemoryHistory.layerMemory)),
    );
    const layer = LinkedMemorySync.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          workspace,
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(self.environmentId),
            getDescriptor: Effect.succeed({ label }),
          } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
          Layer.succeed(ProjectService.ProjectService, {
            getById: (projectId: ProjectId) =>
              Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
            snapshot: Effect.succeed({ projects: [project] }),
          } as unknown as ProjectService.ProjectService["Service"]),
        ),
      ),
      Layer.provideMerge(held === undefined ? Layer.empty : holdLayer(held)),
    );
    const context = yield* Layer.buildWithMemoMap(
      layer,
      yield* Layer.makeMemoMap,
      yield* Effect.scope,
    );
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | LinkedMemorySync.LinkedMemorySync
        | Workspace.ProjectWorkspaceService
        | LinkedMemoryHistory.LinkedMemoryHistory
        | ProjectStore.ProjectStoreV2
      >,
    ) => Effect.provide(effect, context);
    yield* run(
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make(`event:${self.projectId}`),
          aggregateKind: "project",
          aggregateId: self.projectId,
          occurredAt: "2026-10-09T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: self.projectId,
            title: "Shared",
            workspaceRoot: `/tmp/${self.projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-09T00:00:00.000Z",
            updatedAt: "2026-10-09T00:00:00.000Z",
          },
        });
      }),
    );
    const write = (name: string, content: string) =>
      run(
        Effect.gen(function* () {
          const service = yield* Workspace.ProjectWorkspaceService;
          const current = yield* service
            .readMemory({ projectId: self.projectId, name })
            .pipe(Effect.option);
          return yield* service.writeMemory({
            projectId: self.projectId,
            name,
            content,
            expectedRevision: Option.isSome(current) ? current.value.revision : null,
          });
        }),
      );
    const remove = (name: string) =>
      run(
        Effect.gen(function* () {
          const service = yield* Workspace.ProjectWorkspaceService;
          const current = yield* service.readMemory({ projectId: self.projectId, name });
          yield* service.deleteMemory({
            projectId: self.projectId,
            name,
            expectedRevision: current.revision,
          });
        }),
      );
    const contents = run(
      Effect.gen(function* () {
        const service = yield* Workspace.ProjectWorkspaceService;
        const read = yield* service.readWorkspace({ projectId: self.projectId });
        const result: Record<string, string> = {};
        for (const file of read.memory.files)
          result[file.name] = (yield* service.readMemory({
            projectId: self.projectId,
            name: file.name,
          })).content;
        return result;
      }),
    );
    const sync = run(Effect.service(LinkedMemorySync.LinkedMemorySync));
    const exported = sync.pipe(
      Effect.flatMap((service) => service.memoryExport({ projectId: self.projectId })),
    );
    const exportPage = (options: { cursor?: string; digestOnly?: boolean }) =>
      sync.pipe(
        Effect.flatMap((service) =>
          service.memoryExport({ projectId: self.projectId, ...options }),
        ),
      );
    const merge = (peer: typeof alpha, memory: LinkedMemoryExport, peerLabel = "Peer") =>
      sync.pipe(
        Effect.flatMap((service) =>
          service.memoryMerge({
            projectId: self.projectId,
            peer: { ...peer, label: peerLabel },
            export: memory,
          }),
        ),
      );
    const history = run(
      Effect.service(LinkedMemoryHistory.LinkedMemoryHistory).pipe(
        Effect.flatMap((service) => service.read(self.projectId)),
      ),
    );
    const noteVersions = sync.pipe(
      Effect.flatMap((service) => service.noteVersions(self.projectId)),
    );
    const mergeMovedNotes = (input: {
      notes: ReadonlyArray<{ name: string; content: string }>;
      versions: LinkedMemorySync.MovedNoteVersions;
      sourceEnvironmentId: string;
    }) =>
      sync.pipe(
        Effect.flatMap((service) =>
          service.mergeMovedNotes({
            ...input,
            projectId: self.projectId,
            logicalProjectId: LOGICAL_ID,
            sourceLabel: "Moved",
          }),
        ),
      );
    return {
      self,
      project,
      noteVersions,
      mergeMovedNotes,
      context,
      write,
      remove,
      contents,
      exported,
      exportPage,
      merge,
      history,
    };
  });

export type Machine = Effect.Success<ReturnType<typeof machine>>;
/** Both exports first, then each side merges the other's, as the client does. */
export const pass = (left: Machine, right: Machine) =>
  Effect.gen(function* () {
    const fromLeft = yield* left.exported;
    const fromRight = yield* right.exported;
    const onLeft = yield* left.merge(right.self, fromRight);
    const onRight = yield* right.merge(left.self, fromLeft);
    return { onLeft, onRight };
  });
