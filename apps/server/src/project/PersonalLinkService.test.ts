import { renamedMemoryName } from "@specweave-studio/shared/personalAssistantMigration";
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
import { EventId } from "@specweave-studio/contracts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { emptyMemoryHistory, type MemoryHistoryState } from "./linkedMemoryMerge.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { PERSONAL_DATA_RPC_METHODS } from "../auth/RpcAuthorization.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PersonalLinkService from "./PersonalLinkService.ts";
import { PersonalLinkSnapshot } from "./personalLinkSnapshot.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

const envM5 = EnvironmentId.make("env-m5");
/** The name this machine (M5) gives a renamed clash copy. */
const renamedAs = (name: string) => renamedMemoryName(name, "M5", envM5);
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

interface StoredMemory {
  name: string;
  content: string;
  revision: number;
  updatedAt: string;
}

const makeHarness = (
  initial: ReadonlyArray<Project>,
  options: { readonly snapshotFails?: boolean } = {},
) => {
  const store = new Map<ProjectId, Project>(initial.map((p) => [p.id, p]));
  const events: string[] = [];
  const memory = new Map<string, StoredMemory>(
    [
      { name: "MEMORY.md", content: "# Memory\n- index", revision: 1 },
      { name: "user_prefs.md", content: "Prefers short replies.", revision: 2 },
      { name: "machine_only.md", content: "Local disk layout.", revision: 1 },
      {
        name: "leaked_key.md",
        content: "OPENAI_API_KEY=sk-test-1234567890abcdefghij",
        revision: 1,
      },
    ].map((file) => [file.name, { ...file, updatedAt: "2026-11-02T00:00:00.000Z" }]),
  );
  const flags: Record<string, { localOnly?: boolean; secretDetected?: boolean }> = {
    "machine_only.md": { localOnly: true },
    "leaked_key.md": { secretDetected: true },
  };

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
        const expected =
          input.ownership?.expectedRevision ?? input.workspaceSettings?.expectedRevision;
        if (expected !== undefined && expected !== currentSettings.revision) {
          return Effect.fail({
            _tag: "ProjectSettingsRevisionConflictError",
            message: "conflict",
          } as any);
        }
        events.push(input.ownership ? `ownership:${input.ownership.mode}` : "settings");
        const { expectedRevision: _ignored, ...patch } = input.workspaceSettings ?? {};
        const updated: Project = {
          ...existing,
          title: input.title ?? existing.title,
          projectIcon: input.projectIcon !== undefined ? input.projectIcon : existing.projectIcon,
          workspaceSettings: {
            ...currentSettings,
            ...patch,
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
        memory: {
          files: [...memory.values()].map((file) => ({
            name: file.name,
            revision: file.revision,
            byteLength: file.content.length,
            updatedAt: file.updatedAt,
            ...flags[file.name],
          })),
          totalBytes: 100,
        },
      }),
    readMemoryFiles: () =>
      Effect.succeed(
        [...memory.values()]
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map((file) => ({ ...file, byteLength: file.content.length })),
      ),
    writeMemory: (input: any) =>
      Effect.sync(() => {
        events.push(`write:${input.name}`);
        const file = {
          name: input.name,
          content: input.content,
          revision: 1,
          updatedAt: "2026-11-03T00:00:00.000Z",
        };
        memory.set(input.name, file);
        return { ...file, byteLength: input.content.length };
      }),
    renameMemory: (input: any) =>
      Effect.sync(() => {
        events.push(`rename:${input.from}->${input.to}`);
        const source = memory.get(input.from)!;
        const file = { ...source, name: input.to, revision: 1 };
        memory.delete(input.from);
        memory.set(input.to, file);
        return { ...file, byteLength: file.content.length };
      }),
    deleteMemory: (input: any) =>
      Effect.sync(() => {
        events.push(`delete:${input.name}`);
        memory.delete(input.name);
        return { deleted: true as const };
      }),
  } as any);

  const snapshotLayer = Layer.succeed(PersonalLinkSnapshot, {
    snapshot: (operationId: string) =>
      options.snapshotFails
        ? Effect.fail(new Error("disk full"))
        : Effect.sync(() => {
            events.push(`snapshot:${operationId}`);
            return `/tmp/backups/${operationId}.sqlite`;
          }),
  });

  const layer = PersonalLinkService.layer.pipe(
    Layer.provide(Layer.mergeAll(envLayer, projectLayer, workspaceLayer, snapshotLayer)),
  );

  return { layer, store, memory, events };
};

const previewOf = (
  layer: Layer.Layer<PersonalLinkService.PersonalLinkService>,
  projectId: ProjectId,
) =>
  Effect.gen(function* () {
    const svc = yield* PersonalLinkService.PersonalLinkService;
    return yield* svc.preview({ projectId });
  }).pipe(Effect.provide(layer));

const approvalOf = (preview: {
  readonly settingsRevision?: number | undefined;
  readonly memoryDigest?: string | undefined;
}) => ({
  expectedSettingsRevision: preview.settingsRevision!,
  memoryDigest: preview.memoryDigest!,
});

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
        // The clash review gets names and hashes of syncable files, never content.
        assert.deepStrictEqual(
          result.memoryFiles?.map((file) => file.name),
          ["MEMORY.md", "user_prefs.md"],
        );
        assert.isFalse(JSON.stringify(result).includes("Prefers short replies"));
        assert.strictEqual(result.self?.projectId, projM5);
        assert.strictEqual(result.settingsRevision, 1);
        assert.match(result.memoryDigest ?? "", /^[0-9a-f]{64}$/);
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
        const { layer, store, events } = makeHarness([
          makeProject({ id: projM5, title: "Local Assistant" }),
        ]);
        const preview = yield* previewOf(layer, projM5);
        const request = {
          projectId: projM5,
          logicalProjectId: "logical:percy-shared-1",
          canonicalName: "Percy",
          members: [memberM5, memberM4],
          routineOwner: true,
          peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
          peerMachineLabel: "M4",
          operationId: "op-1",
          approval: approvalOf(preview),
        };
        const joined = yield* Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          const first = yield* svc.join({
            ...request,
            icon: { kind: "lucide", name: "bot", color: "blue" },
          });
          const second = yield* svc.join(request);
          return { first, second };
        }).pipe(Effect.provide(layer));

        assert.isFalse(joined.first.replayed);
        assert.isTrue(joined.second.replayed);
        assert.match(
          joined.first.snapshotPath ?? "",
          /^\/tmp\/backups\/op-1@r1-[0-9a-f]{16}\.sqlite$/,
        );
        assert.strictEqual(joined.first.logicalProject.id, "logical:percy-shared-1");
        assert.strictEqual(joined.first.logicalProject.members.length, 2);
        assert.isTrue(joined.first.routineOwner);
        // The database copy is saved before anything is written.
        assert.strictEqual(events.length, 2);
        assert.match(events[0]!, /^snapshot:op-1@/);
        assert.strictEqual(events[1], "ownership:join-as-member");
        const saved = store.get(projM5)!;
        assert.strictEqual(saved.title, "Percy");
        assert.deepStrictEqual(saved.projectIcon, { kind: "lucide", name: "bot", color: "blue" });
        assert.strictEqual(saved.workspaceSettings?.coordinatorBinding?.state, "active");
        assert.strictEqual(saved.workspaceSettings?.coordinatorBinding?.routineOwner, true);
      }),
  );

  it.effect("join refuses a first link without the owner's approval", () =>
    Effect.gen(function* () {
      const { layer, events } = makeHarness([makeProject({ id: projM5 })]);
      const error = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.join({
          projectId: projM5,
          logicalProjectId: "logical:percy-shared-1",
          members: [memberM5, memberM4],
          routineOwner: true,
          peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
        });
      }).pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(error.code, "approval_required");
      assert.deepStrictEqual(events, []);
    }),
  );

  it.effect("join refuses with stale_plan when memory changed after the review", () =>
    Effect.gen(function* () {
      const { layer, memory, events } = makeHarness([makeProject({ id: projM5 })]);
      const preview = yield* previewOf(layer, projM5);
      memory.set("user_prefs.md", {
        name: "user_prefs.md",
        content: "Prefers long replies.",
        revision: 3,
        updatedAt: "2026-11-04T00:00:00.000Z",
      });
      const error = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.join({
          projectId: projM5,
          logicalProjectId: "logical:percy-shared-1",
          members: [memberM5, memberM4],
          routineOwner: true,
          peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
          approval: approvalOf(preview),
        });
      }).pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(error.code, "stale_plan");
      assert.deepStrictEqual(events, []);
    }),
  );

  it.effect("join writes nothing when the database copy fails", () =>
    Effect.gen(function* () {
      const { layer, store, events } = makeHarness([makeProject({ id: projM5 })], {
        snapshotFails: true,
      });
      const preview = yield* previewOf(layer, projM5);
      const error = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.join({
          projectId: projM5,
          logicalProjectId: "logical:percy-shared-1",
          members: [memberM5, memberM4],
          routineOwner: true,
          peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
          memoryResolutions: [{ name: "user_prefs.md", action: "rename-local" }],
          approval: approvalOf(preview),
        });
      }).pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(error.code, "snapshot_failed");
      assert.deepStrictEqual(events, []);
      assert.isUndefined(store.get(projM5)?.workspaceSettings?.logicalProject);
    }),
  );

  it.effect(
    "join renames clashing files as chosen, keeps nothing deleted, and a retry still matches the approval",
    () =>
      Effect.gen(function* () {
        const { layer, store, memory, events } = makeHarness([makeProject({ id: projM5 })]);
        const preview = yield* previewOf(layer, projM5);
        const request = {
          projectId: projM5,
          logicalProjectId: "logical:percy-shared-1",
          members: [memberM5, memberM4],
          routineOwner: false,
          peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
          operationId: "op-2",
          memoryResolutions: [
            { name: "user_prefs.md", action: "rename-local" as const },
            { name: "MEMORY.md", action: "rename-shared" as const },
          ],
          approval: approvalOf(preview),
        };
        yield* Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          return yield* svc.join(request);
        }).pipe(Effect.provide(layer));

        assert.match(events[0]!, /^snapshot:op-2@/);
        assert.isFalse(memory.has("user_prefs.md"));
        assert.strictEqual(
          memory.get(renamedAs("user_prefs.md"))?.content,
          "Prefers short replies.",
        );
        assert.strictEqual(memory.get(renamedAs("MEMORY.md"))?.content, "# Memory\n- index");
        const settings = store.get(projM5)!.workspaceSettings!;
        assert.deepStrictEqual(settings.localOnlyMemoryFiles, [renamedAs("user_prefs.md")]);
        assert.strictEqual(settings.logicalProject?.id, "logical:percy-shared-1");
        assert.strictEqual(events.at(-1), "ownership:join-as-member");

        // A retry after the renames (say the reply was lost) is a replay, not a stale plan.
        const again = yield* Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          return yield* svc.join(request);
        }).pipe(Effect.provide(layer));
        assert.isTrue(again.replayed);
      }),
  );

  it.effect("join refuses a peer that does not say its protocol version", () =>
    Effect.gen(function* () {
      const { layer } = makeHarness([makeProject({ id: projM5 })]);
      const error = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.join({
          projectId: projM5,
          logicalProjectId: "logical:percy-shared-1",
          members: [memberM5, memberM4],
          routineOwner: true,
        });
      }).pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(error.code, "version_skew");
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

  const linkedSettings = (
    overrides: Partial<NonNullable<Project["workspaceSettings"]>> = {},
  ): NonNullable<Project["workspaceSettings"]> => ({
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    kind: "personal",
    revision: 4,
    logicalProject: {
      id: "logical:percy-pair",
      title: "Percy",
      coordinatorId: memberM5.coordinatorThreadId,
      members: [memberM5, memberM4],
    },
    coordinatorBinding: { epoch: 0, state: "active", routineOwner: true },
    ...overrides,
  });

  const joinWith = (layer: Layer.Layer<PersonalLinkService.PersonalLinkService>, input: any) =>
    Effect.gen(function* () {
      const svc = yield* PersonalLinkService.PersonalLinkService;
      return yield* svc.join({
        projectId: projM5,
        routineOwner: true,
        peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
        ...input,
      });
    }).pipe(Effect.provide(layer));

  it.effect("join renames each clash in one step and never deletes the original name", () =>
    Effect.gen(function* () {
      const { layer, events } = makeHarness([makeProject({ id: projM5 })]);
      const preview = yield* previewOf(layer, projM5);
      yield* joinWith(layer, {
        logicalProjectId: "logical:percy-shared-1",
        members: [memberM5, memberM4],
        operationId: "op-rename",
        memoryResolutions: [{ name: "user_prefs.md", action: "rename-shared" }],
        approval: approvalOf(preview),
      });
      assert.include(events, `rename:user_prefs.md->${renamedAs("user_prefs.md")}`);
      assert.isFalse(events.some((event) => event.startsWith("delete:")));
    }),
  );

  it.effect("join finishes a rename that stopped halfway on an earlier attempt", () =>
    Effect.gen(function* () {
      const { layer, memory, store } = makeHarness([makeProject({ id: projM5 })]);
      const preview = yield* previewOf(layer, projM5);
      // The earlier attempt wrote the new name but never removed the original.
      memory.set(renamedAs("user_prefs.md"), {
        name: renamedAs("user_prefs.md"),
        content: "Prefers short replies.",
        revision: 1,
        updatedAt: "2026-11-03T00:00:00.000Z",
      });
      yield* joinWith(layer, {
        logicalProjectId: "logical:percy-shared-1",
        members: [memberM5, memberM4],
        operationId: "op-half",
        memoryResolutions: [{ name: "user_prefs.md", action: "rename-shared" }],
        approval: approvalOf(preview),
      });
      assert.isFalse(memory.has("user_prefs.md"));
      assert.strictEqual(memory.get(renamedAs("user_prefs.md"))?.content, "Prefers short replies.");
      assert.strictEqual(
        store.get(projM5)?.workspaceSettings?.logicalProject?.id,
        "logical:percy-shared-1",
      );
    }),
  );

  it.effect("join refuses a rename onto a different file before renaming anything", () =>
    Effect.gen(function* () {
      const { layer, memory, events } = makeHarness([makeProject({ id: projM5 })]);
      memory.set(renamedAs("user_prefs.md"), {
        name: renamedAs("user_prefs.md"),
        content: "Something else.",
        revision: 1,
        updatedAt: "2026-11-03T00:00:00.000Z",
      });
      const preview = yield* previewOf(layer, projM5);
      const error = yield* joinWith(layer, {
        logicalProjectId: "logical:percy-shared-1",
        members: [memberM5, memberM4],
        memoryResolutions: [
          { name: "MEMORY.md", action: "rename-shared" },
          { name: "user_prefs.md", action: "rename-shared" },
        ],
        approval: approvalOf(preview),
      }).pipe(Effect.flip);
      assert.strictEqual(error.code, "invalid");
      assert.isFalse(events.some((event) => event.startsWith("rename:")));
      assert.isTrue(memory.has("MEMORY.md"));
    }),
  );

  it.effect("join refuses this seat's own one-member identity as a link id", () =>
    Effect.gen(function* () {
      const { layer, events } = makeHarness([
        makeProject({
          id: projM5,
          workspaceSettings: linkedSettings({
            logicalProject: {
              id: "logical:own",
              title: "Percy",
              coordinatorId: memberM5.coordinatorThreadId,
              members: [memberM5],
            },
          }),
        }),
      ]);
      const error = yield* joinWith(layer, {
        logicalProjectId: "logical:own",
        members: [memberM5, memberM4],
      }).pipe(Effect.flip);
      assert.strictEqual(error.code, "invalid");
      assert.match(error.message, /Use a new link id/);
      assert.deepStrictEqual(events, []);
    }),
  );

  it.effect("adding a machine to a link needs the owner's approval", () =>
    Effect.gen(function* () {
      const { layer, events } = makeHarness([
        makeProject({ id: projM5, workspaceSettings: linkedSettings() }),
      ]);
      const error = yield* joinWith(layer, {
        logicalProjectId: "logical:percy-pair",
        members: [memberM5, memberM4, memberLinux],
      }).pipe(Effect.flip);
      assert.strictEqual(error.code, "approval_required");
      assert.deepStrictEqual(events, []);
    }),
  );

  it.effect(
    "adding a machine saves a copy, keeps the link's name and ends the machine's old removal",
    () =>
      Effect.gen(function* () {
        const { layer, events, store } = makeHarness([
          makeProject({
            id: projM5,
            workspaceSettings: linkedSettings({
              coordinatorBinding: {
                epoch: 0,
                state: "active",
                routineOwner: true,
                removedMembers: [
                  {
                    environmentId: envLinux,
                    projectId: projLinux,
                    removedAt: "2026-11-01T00:00:00.000Z",
                  },
                ],
              },
            }),
          }),
        ]);
        const preview = yield* previewOf(layer, projM5);
        const result = yield* joinWith(layer, {
          logicalProjectId: "logical:percy-pair",
          canonicalName: "Another name",
          members: [memberM5, memberM4, memberLinux],
          operationId: "op-add",
          memoryResolutions: [{ name: "user_prefs.md", action: "rename-local" }],
          approval: approvalOf(preview),
        });
        assert.match(result.snapshotPath ?? "", /^\/tmp\/backups\/op-add@r4-/);
        assert.match(events[0]!, /^snapshot:op-add@/);
        assert.include(events, `rename:user_prefs.md->${renamedAs("user_prefs.md")}`);
        assert.strictEqual(events.at(-1), "ownership:link-member");
        const saved = store.get(projM5)!;
        assert.strictEqual(saved.title, "Percy");
        assert.strictEqual(saved.workspaceSettings?.logicalProject?.title, "Percy");
        assert.strictEqual(saved.workspaceSettings?.logicalProject?.members.length, 3);
        const binding = saved.workspaceSettings?.coordinatorBinding;
        assert.isUndefined(binding?.removedMembers);
        assert.deepStrictEqual(
          binding?.relinkedMembers?.map((entry) => entry.environmentId),
          [envLinux],
        );
        assert.deepStrictEqual(saved.workspaceSettings?.localOnlyMemoryFiles, [
          renamedAs("user_prefs.md"),
        ]);
      }),
  );

  it.effect("leaving a link remembers it in formerLinks", () =>
    Effect.gen(function* () {
      const { layer, store } = makeHarness([
        makeProject({ id: projM5, workspaceSettings: linkedSettings() }),
      ]);
      yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.leave({ projectId: projM5 });
      }).pipe(Effect.provide(layer));
      const binding = store.get(projM5)!.workspaceSettings?.coordinatorBinding;
      assert.strictEqual(binding?.formerLinks?.length, 1);
      assert.strictEqual(binding?.formerLinks?.[0]?.logicalProjectId, "logical:percy-pair");
      assert.deepStrictEqual(
        binding?.formerLinks?.[0]?.members.map((member) => member.environmentId),
        [envM5, envM4],
      );
      assert.strictEqual(binding?.epoch, 0);
    }),
  );

  it.effect("removing the only other machine also remembers the link it ended", () =>
    Effect.gen(function* () {
      const { layer, store } = makeHarness([
        makeProject({ id: projM5, workspaceSettings: linkedSettings() }),
      ]);
      const result = yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.leave({ projectId: projM5, removeEnvironmentId: envM4 });
      }).pipe(Effect.provide(layer));
      assert.isTrue(result.unlinked);
      const binding = store.get(projM5)!.workspaceSettings?.coordinatorBinding;
      assert.strictEqual(binding?.formerLinks?.[0]?.logicalProjectId, "logical:percy-pair");
    }),
  );

  it.effect("keeps at most eight former links, newest last", () =>
    Effect.gen(function* () {
      const older = Array.from({ length: 8 }, (_, index) => ({
        logicalProjectId: `logical:old-${index}`,
        members: [memberM5],
        leftAt: "2026-10-01T00:00:00.000Z",
      }));
      const { layer, store } = makeHarness([
        makeProject({
          id: projM5,
          workspaceSettings: linkedSettings({
            coordinatorBinding: { epoch: 0, state: "active", formerLinks: older },
          }),
        }),
      ]);
      yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.leave({ projectId: projM5 });
      }).pipe(Effect.provide(layer));
      const former = store.get(projM5)!.workspaceSettings?.coordinatorBinding?.formerLinks ?? [];
      assert.strictEqual(former.length, 8);
      assert.strictEqual(former[0]?.logicalProjectId, "logical:old-1");
      assert.strictEqual(former.at(-1)?.logicalProjectId, "logical:percy-pair");
    }),
  );

  it.effect("joining a link this seat left drops it from formerLinks and notes the relink", () =>
    Effect.gen(function* () {
      const { layer, store } = makeHarness([
        makeProject({
          id: projM5,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            kind: "personal",
            revision: 1,
            logicalProject: {
              id: "logical:own",
              title: "Percy",
              coordinatorId: memberM5.coordinatorThreadId,
              members: [memberM5],
            },
            coordinatorBinding: {
              epoch: 0,
              state: "active",
              routineOwner: true,
              formerLinks: [
                {
                  logicalProjectId: "logical:percy-pair",
                  members: [memberM5, memberM4],
                  leftAt: "2026-11-01T00:00:00.000Z",
                },
                {
                  logicalProjectId: "logical:other",
                  members: [memberM5, memberLinux],
                  leftAt: "2026-11-02T00:00:00.000Z",
                },
              ],
            },
          },
        }),
      ]);
      const preview = yield* previewOf(layer, projM5);
      yield* joinWith(layer, {
        logicalProjectId: "logical:percy-pair",
        members: [memberM5, memberM4],
        operationId: "op-rejoin",
        approval: approvalOf(preview),
      });
      const binding = store.get(projM5)!.workspaceSettings?.coordinatorBinding;
      assert.deepStrictEqual(
        binding?.formerLinks?.map((entry) => entry.logicalProjectId),
        ["logical:other"],
      );
      assert.sameMembers(
        (binding?.relinkedMembers ?? []).map((entry) => entry.environmentId),
        [envM5, envM4],
      );
    }),
  );
});

describe("ProjectWorkspaceService.renameMemory (1448 C3)", () => {
  const renameProject = ProjectId.make("rename-project");
  const histories = new Map<ProjectId, MemoryHistoryState>();
  const historyLayer = Layer.succeed(LinkedMemoryHistory.LinkedMemoryHistory, {
    read: (id: ProjectId) => Effect.sync(() => histories.get(id) ?? emptyMemoryHistory),
    modify: (id: ProjectId, update: (state: MemoryHistoryState) => MemoryHistoryState) =>
      Effect.sync(() => {
        const next = update(histories.get(id) ?? emptyMemoryHistory);
        histories.set(id, next);
        return next;
      }),
    remove: () => Effect.void,
    saveVersion: () => Effect.succeed(false),
    readVersion: () => Effect.succeed(undefined),
    pruneVersions: () => Effect.void,
  } as unknown as LinkedMemoryHistory.LinkedMemoryHistory["Service"]);
  const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const realLayer = ProjectWorkspaceService.layer.pipe(
    Layer.provideMerge(storage),
    Layer.provideMerge(historyLayer),
  );
  const seed = Effect.gen(function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    yield* store.apply({
      sequence: 1,
      eventId: EventId.make(`event:${renameProject}`),
      aggregateKind: "project",
      aggregateId: renameProject,
      occurredAt: "2026-11-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: renameProject,
        title: "Percy",
        workspaceRoot: "/tmp/rename-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    } as any);
  });

  it.effect(
    "moves a file without a tombstone for the original name, and finishes half renames",
    () =>
      Effect.gen(function* () {
        histories.clear();
        yield* seed;
        const service = yield* ProjectWorkspaceService.ProjectWorkspaceService;
        const first = yield* service.writeMemory({
          projectId: renameProject,
          name: "notes.md",
          content: "Mine.",
          expectedRevision: null,
        });
        const edited = yield* service.writeMemory({
          projectId: renameProject,
          name: "notes.md",
          content: "Mine, edited.",
          expectedRevision: first.revision,
        });
        const moved = yield* service.renameMemory({
          projectId: renameProject,
          from: "notes.md",
          to: "notes.from-m5.md",
          expectedRevision: edited.revision,
        });
        assert.strictEqual(moved.content, "Mine, edited.");
        const names = (yield* service.readMemoryFiles({ projectId: renameProject })).map(
          (file) => file.name,
        );
        assert.deepStrictEqual(names, ["notes.from-m5.md"]);
        const history = histories.get(renameProject)!;
        assert.isUndefined(history.tombstones["notes.md"]);
        assert.isUndefined(history.files["notes.md"]);
        assert.isDefined(history.files["notes.from-m5.md"]);

        // A half rename from an older build: the same content already under the new name.
        const again = yield* service.writeMemory({
          projectId: renameProject,
          name: "people.md",
          content: "Same.",
          expectedRevision: null,
        });
        yield* service.writeMemory({
          projectId: renameProject,
          name: "people.from-m5.md",
          content: "Same.",
          expectedRevision: null,
        });
        yield* service.renameMemory({
          projectId: renameProject,
          from: "people.md",
          to: "people.from-m5.md",
          expectedRevision: again.revision,
        });
        const after = (yield* service.readMemoryFiles({ projectId: renameProject })).map(
          (file) => file.name,
        );
        assert.deepStrictEqual(after, ["notes.from-m5.md", "people.from-m5.md"]);
        assert.isUndefined(histories.get(renameProject)!.tombstones["people.md"]);

        // A different file under the new name is a conflict; nothing moves.
        const third = yield* service.writeMemory({
          projectId: renameProject,
          name: "a.md",
          content: "A.",
          expectedRevision: null,
        });
        yield* service.writeMemory({
          projectId: renameProject,
          name: "a.from-m5.md",
          content: "B.",
          expectedRevision: null,
        });
        const error = yield* Effect.flip(
          service.renameMemory({
            projectId: renameProject,
            from: "a.md",
            to: "a.from-m5.md",
            expectedRevision: third.revision,
          }),
        );
        assert.strictEqual(error.code, "conflict");
        assert.strictEqual(
          (yield* service.readMemory({ projectId: renameProject, name: "a.md" })).content,
          "A.",
        );
      }).pipe(Effect.provide(realLayer)),
  );
});

describe("PersonalLinkService database copies", () => {
  it.effect("a later join that reuses the operation id saves its own copy", () =>
    Effect.gen(function* () {
      const { layer, events, memory } = makeHarness([makeProject({ id: projM5 })]);
      const join = (approval: ReturnType<typeof approvalOf>) =>
        Effect.gen(function* () {
          const svc = yield* PersonalLinkService.PersonalLinkService;
          return yield* svc.join({
            projectId: projM5,
            logicalProjectId: "logical:percy-shared-1",
            members: [memberM5, memberM4],
            routineOwner: true,
            peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
            operationId: "personal-link:same",
            approval,
          });
        }).pipe(Effect.provide(layer));
      yield* join(approvalOf(yield* previewOf(layer, projM5)));
      yield* Effect.gen(function* () {
        const svc = yield* PersonalLinkService.PersonalLinkService;
        return yield* svc.leave({ projectId: projM5 });
      }).pipe(Effect.provide(layer));
      memory.set("later.md", {
        name: "later.md",
        content: "Written after leaving.",
        revision: 1,
        updatedAt: "2026-11-05T00:00:00.000Z",
      });
      yield* join(approvalOf(yield* previewOf(layer, projM5)));
      const copies = events.filter((event) => event.startsWith("snapshot:"));
      assert.strictEqual(copies.length, 2);
      assert.notStrictEqual(copies[0], copies[1]);
    }),
  );
});
