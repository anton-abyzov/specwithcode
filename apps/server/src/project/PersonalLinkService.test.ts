import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  PERSONAL_LINK_PROTOCOL_VERSION,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type LogicalProjectMember,
  type Project,
} from "@specweave-studio/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { PERSONAL_DATA_RPC_METHODS } from "../auth/RpcAuthorization.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PersonalLinkService from "./PersonalLinkService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

const envM5 = EnvironmentId.make("env-m5");
const envM4 = EnvironmentId.make("env-m4");
const envLinux = EnvironmentId.make("env-linux");

const projM5 = ProjectId.make("proj-percy-m5");
const projM4 = ProjectId.make("proj-percy-m4");
const projLinux = ProjectId.make("proj-percy-linux");
const projCode = ProjectId.make("proj-code-1");

const memberM5: LogicalProjectMember = {
  environmentId: envM5,
  projectId: projM5,
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projM5}`),
};
const memberM4: LogicalProjectMember = {
  environmentId: envM4,
  projectId: projM4,
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projM4}`),
};
const memberLinux: LogicalProjectMember = {
  environmentId: envLinux,
  projectId: projLinux,
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projLinux}`),
};

const makeProject = (overrides: Partial<Project> & { id: ProjectId }): Project => ({
  id: overrides.id,
  title: overrides.title ?? "Percy",
  workspaceRoot: overrides.workspaceRoot ?? "/Users/anton/.specwithcode/personal",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  faviconPath: null,
  projectIcon: overrides.projectIcon ?? { kind: "lucide", name: "sparkles", color: "violet" },
  workspaceSettings: overrides.workspaceSettings ?? {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    kind: "personal",
    revision: 1,
  },
});

const makeHarness = (initial: ReadonlyArray<Project>) => {
  const store = new Map<ProjectId, Project>(initial.map((p) => [p.id, p]));
  const memoryFiles: Array<{
    name: string;
    revision: number;
    byteLength: number;
    updatedAt: string;
    localOnly?: boolean;
    secretDetected?: boolean;
  }> = [
    { name: "MEMORY.md", revision: 1, byteLength: 42, updatedAt: "2026-11-01T00:00:00.000Z" },
    { name: "user_prefs.md", revision: 2, byteLength: 88, updatedAt: "2026-11-02T00:00:00.000Z" },
    {
      name: "machine_only.md",
      revision: 1,
      byteLength: 30,
      updatedAt: "2026-11-02T00:00:00.000Z",
      localOnly: true,
    },
    {
      name: "leaked_key.md",
      revision: 1,
      byteLength: 55,
      updatedAt: "2026-11-02T00:00:00.000Z",
      secretDetected: true,
    },
  ];

  const envLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(envM5),
    getDescriptor: Effect.succeed({
      environmentId: envM5,
      label: "M5",
      platform: { os: "darwin", arch: "arm64" },
    } as any),
  });

  const projectLayer = Layer.succeed(ProjectService.ProjectService, {
    getById: (id: ProjectId) => Effect.succeed(Option.fromUndefinedOr(store.get(id))),
    update: (input: any) =>
      Effect.suspend(() => {
        const existing = store.get(input.projectId);
        if (!existing) {
          return Effect.fail({ _tag: "ProjectNotFoundError", message: "Not found" } as any);
        }
        const currentSettings = existing.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const updated: Project = {
          ...existing,
          title: input.title ?? existing.title,
          projectIcon: input.projectIcon !== undefined ? input.projectIcon : existing.projectIcon,
          workspaceSettings: {
            ...currentSettings,
            ...(input.ownership
              ? {
                  logicalProject: input.ownership.logicalProject,
                  coordinatorBinding: input.ownership.coordinatorBinding,
                }
              : {}),
            revision: (currentSettings.revision ?? 0) + 1,
          },
        };
        store.set(updated.id, updated);
        return Effect.succeed(updated);
      }),
  } as any);

  const workspaceLayer = Layer.succeed(ProjectWorkspaceService.ProjectWorkspaceService, {
    readWorkspace: () =>
      Effect.succeed({
        settings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        memory: { files: memoryFiles, totalBytes: 100 },
      }),
  } as any);

  const layer = PersonalLinkService.layer.pipe(
    Layer.provide(Layer.mergeAll(envLayer, projectLayer, workspaceLayer)),
  );

  return { layer, store, memoryFiles };
};

describe("PersonalLinkService", () => {
  it("registers all four personalLink RPCs as owner-only personal data RPCs", () => {
    for (const method of [
      WS_METHODS.personalLinkPreview,
      WS_METHODS.personalLinkJoin,
      WS_METHODS.personalLinkLeave,
      WS_METHODS.personalLinkSetRoutineOwner,
    ]) {
      assert.isTrue(PERSONAL_DATA_RPC_METHODS.includes(method));
    }
  });

  it.effect(
    "preview returns strictly allow-listed fields and excludes localOnly and secret files",
    () =>
      Effect.gen(function* () {
        const { layer } = makeHarness([makeProject({ id: projM5 })]);
        const result = yield* Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          return yield* svc.preview({ projectId: projM5 });
        }).pipe(Effect.provide(layer));

        assert.strictEqual(result.protocolVersion, PERSONAL_LINK_PROTOCOL_VERSION);
        assert.strictEqual(result.assistantName, "Percy");
        assert.strictEqual(result.machineLabel, "M5");
        assert.strictEqual(result.memoryFileCount, 2);
        assert.deepStrictEqual(result.memoryFileNames, ["MEMORY.md", "user_prefs.md"]);
        assert.isNull(result.logicalProjectId);
        assert.isTrue(result.routineOwner);
        // Verify no workspaceRoot, git fingerprints, or chat snippets leak
        const keys = Object.keys(result);
        assert.isFalse(keys.includes("workspaceRoot"));
        assert.isFalse(keys.includes("fingerprint"));
        assert.isFalse(keys.includes("threads"));
      }),
  );

  it.effect("preview refuses code projects with not_personal_assistant", () =>
    Effect.gen(function* () {
      const { layer } = makeHarness([
        makeProject({
          id: projCode,
          title: "App",
          workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "code", revision: 1 },
        }),
      ]);
      const error = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.preview({ projectId: projCode });
      }).pipe(Effect.provide(layer), Effect.flip);

      assert.strictEqual(error.code, "not_personal_assistant");
    }),
  );

  it.effect(
    "join links two personal assistants, updates canonical name/icon, and replays idempotently",
    () =>
      Effect.gen(function* () {
        const { layer, store } = makeHarness([
          makeProject({ id: projM5, title: "Local Assistant" }),
        ]);
        const joined = yield* Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          const first = yield* svc.join({
            projectId: projM5,
            logicalProjectId: "logical:percy-shared-1",
            canonicalName: "Percy",
            icon: { kind: "lucide", name: "bot", color: "blue" },
            members: [memberM5, memberM4],
            routineOwner: true,
            peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
            peerMachineLabel: "M4",
            operationId: "op-1",
          });
          const second = yield* svc.join({
            projectId: projM5,
            logicalProjectId: "logical:percy-shared-1",
            canonicalName: "Percy",
            members: [memberM5, memberM4],
            routineOwner: true,
            operationId: "op-1",
          });
          return { first, second };
        }).pipe(Effect.provide(layer));

        assert.isFalse(joined.first.replayed);
        assert.isTrue(joined.second.replayed);
        assert.strictEqual(joined.first.logicalProject.id, "logical:percy-shared-1");
        assert.strictEqual(joined.first.logicalProject.members.length, 2);
        assert.isTrue(joined.first.routineOwner);
        const saved = store.get(projM5)!;
        assert.strictEqual(saved.title, "Percy");
        assert.deepStrictEqual(saved.projectIcon, { kind: "lucide", name: "bot", color: "blue" });
        assert.strictEqual(saved.workspaceSettings?.coordinatorBinding?.state, "active");
        assert.strictEqual(saved.workspaceSettings?.coordinatorBinding?.routineOwner, true);
      }),
  );

  it.effect("join refuses older peer protocol versions with version_skew", () =>
    Effect.gen(function* () {
      const { layer } = makeHarness([makeProject({ id: projM5 })]);
      const error = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.join({
          projectId: projM5,
          logicalProjectId: "logical:percy-shared-1",
          members: [memberM5, memberM4],
          routineOwner: true,
          peerProtocolVersion: 0,
          peerMachineLabel: "M4",
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      assert.strictEqual(error.code, "version_skew");
      assert.strictEqual(error.message, "Update M4 to link Percy.");
    }),
  );

  it.effect(
    "leave unlinks cleanly and preserves local assistant, and removes single peer from 3-machine link",
    () =>
      Effect.gen(function* () {
        const { layer, store } = makeHarness([
          makeProject({
            id: projM5,
            workspaceSettings: {
              ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              kind: "personal",
              revision: 3,
              logicalProject: {
                id: "logical:percy-3way",
                title: "Percy",
                coordinatorId: memberM5.coordinatorThreadId,
                members: [memberM5, memberM4, memberLinux],
              },
              coordinatorBinding: {
                epoch: 0,
                state: "active",
                routineOwner: false,
              },
            },
          }),
        ]);

        const step1 = yield* Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          return yield* svc.leave({ projectId: projM5, removeEnvironmentId: envLinux });
        }).pipe(Effect.provide(layer));

        assert.isFalse(step1.unlinked);
        assert.strictEqual(step1.remainingMembers.length, 2);

        const step2 = yield* Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          return yield* svc.leave({ projectId: projM5 });
        }).pipe(Effect.provide(layer));

        assert.isTrue(step2.unlinked);
        assert.strictEqual(step2.remainingMembers.length, 1);
        const saved = store.get(projM5)!;
        assert.notStrictEqual(saved.workspaceSettings?.logicalProject?.id, "logical:percy-3way");
        assert.strictEqual(saved.workspaceSettings?.coordinatorBinding?.routineOwner, true);
      }),
  );

  it.effect("setRoutineOwner updates routineOwner without altering logicalProject identity", () =>
    Effect.gen(function* () {
      const { layer, store } = makeHarness([
        makeProject({
          id: projM5,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            kind: "personal",
            revision: 2,
            logicalProject: {
              id: "logical:percy-ro",
              title: "Percy",
              coordinatorId: memberM5.coordinatorThreadId,
              members: [memberM5, memberM4],
            },
            coordinatorBinding: {
              epoch: 0,
              state: "active",
              routineOwner: true,
            },
          },
        }),
      ]);

      const res = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.setRoutineOwner({ projectId: projM5, routineOwner: false });
      }).pipe(Effect.provide(layer));

      assert.isFalse(res.routineOwner);
      const saved = store.get(projM5)!;
      assert.strictEqual(saved.workspaceSettings?.logicalProject?.id, "logical:percy-ro");
      assert.strictEqual(saved.workspaceSettings?.coordinatorBinding?.routineOwner, false);
    }),
  );
});
