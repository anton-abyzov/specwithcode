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
import { PersonalLinkSnapshot } from "./personalLinkSnapshot.ts";
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

const approvalOf = (preview: { settingsRevision?: number; memoryDigest?: string }) => ({
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
        assert.strictEqual(joined.first.snapshotPath, "/tmp/backups/op-1.sqlite");
        assert.strictEqual(joined.first.logicalProject.id, "logical:percy-shared-1");
        assert.strictEqual(joined.first.logicalProject.members.length, 2);
        assert.isTrue(joined.first.routineOwner);
        // The database copy is saved before anything is written.
        assert.deepStrictEqual(events, ["snapshot:op-1", "ownership:join-as-member"]);
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

        assert.deepStrictEqual(events.slice(0, 1), ["snapshot:op-2"]);
        assert.isFalse(memory.has("user_prefs.md"));
        assert.strictEqual(memory.get("user_prefs.from-m5.md")?.content, "Prefers short replies.");
        assert.strictEqual(memory.get("MEMORY.from-m5.md")?.content, "# Memory\n- index");
        const settings = store.get(projM5)!.workspaceSettings!;
        assert.deepStrictEqual(settings.localOnlyMemoryFiles, ["user_prefs.from-m5.md"]);
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
});
