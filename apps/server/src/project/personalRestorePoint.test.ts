// @effect-diagnostics nodeBuiltinImport:off anyUnknownInErrorContext:off -- reads the saved files in a private temp home as they are on disk; the project row store is a loosely typed fake.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  type Project,
  ProjectId,
  type ProjectWorkspaceSettings,
  ThreadId,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import {
  PersonalRestoreAssistantError,
  PersonalRestorePoint,
  PersonalRestorePointInvalidError,
  PersonalRestorePointMissingError,
  PersonalRestoreStillLinkedError,
  PersonalRestoreStorageError,
  layer as restorePointLayer,
} from "./personalRestorePoint.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";

const PERCY = ProjectId.make("percy-laptop");
const OTHER = ProjectId.make("code-project");
const GONE_FOLDER = "/scratch/removed-checkout";

type Patch = Record<string, any>;

/** A private state folder under the OS temp dir; never the live SpecWithCode data. */
const makeScratchHome = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-percy-restore-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const originalSettings: ProjectWorkspaceSettings = {
  ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  kind: "personal",
  revision: 4,
  instructions: "Answer briefly.",
  environment: {
    additionalFolders: [],
    repositories: [
      { id: "taxes", url: "https://github.com/example/taxes.git", localPath: "/scratch/taxes" },
    ],
  },
  localOnlyMemoryFiles: ["health.md"],
};

/** One machine: a personal assistant and a code project in one store, with a private home. */
const makeMachine = Effect.gen(function* () {
  const home = yield* makeScratchHome;
  let project: Project = {
    id: PERCY,
    title: "Percy on Laptop",
    workspaceRoot: "/scratch/percy",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    deletedAt: null,
    faviconPath: null,
    projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
    workspaceSettings: originalSettings,
  };
  const updates: Array<Patch> = [];
  let settingsMovedOn = false;
  const refuse = (error: {
    readonly _tag: string;
  }): Effect.Effect<Project, { readonly _tag: string }> => Effect.fail(error);
  const update = (input: Patch) =>
    Effect.suspend(() => {
      const settings = project.workspaceSettings!;
      if (
        settingsMovedOn ||
        (input.workspaceSettings !== undefined &&
          input.workspaceSettings.expectedRevision !== settings.revision)
      )
        return refuse({ _tag: "ProjectRequestDeniedError" });
      // As the real service: a repository folder that is gone is not approved again.
      if (
        input.workspaceSettings?.environment?.repositories.some(
          (repository: { localPath: string | null }) => repository.localPath === GONE_FOLDER,
        )
      )
        return refuse({ _tag: "ProjectEnvironmentError" });
      updates.push(input);
      const { expectedRevision: _ignored, ...patch } = input.workspaceSettings ?? {};
      project = {
        ...project,
        title: input.title ?? project.title,
        projectIcon: input.projectIcon !== undefined ? input.projectIcon : project.projectIcon,
        workspaceSettings: { ...settings, ...patch, revision: settings.revision + 1 },
      };
      return Effect.succeed(project);
    });
  const projects = {
    getById: (id: ProjectId) =>
      Effect.sync(() =>
        id === PERCY
          ? Option.some(project)
          : id === OTHER
            ? Option.some({ ...project, id: OTHER, workspaceSettings: undefined })
            : Option.none(),
      ),
    update,
  } as unknown as ProjectService.ProjectService["Service"];

  const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const workspace = Workspace.layer.pipe(
    Layer.provideMerge(Layer.merge(storage, LinkedMemoryHistory.layerMemory)),
  );
  const layer = restorePointLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        workspace,
        Layer.succeed(ProjectService.ProjectService, projects),
        ServerConfig.layerTest(home, home),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const context = yield* Layer.buildWithMemoMap(
    layer,
    yield* Layer.makeMemoMap,
    yield* Effect.scope,
  );
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.provide(effect, context) as Effect.Effect<A, E>;

  yield* run(
    Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      for (const [sequence, projectId] of [PERCY, OTHER].entries())
        yield* store.apply({
          sequence: sequence + 1,
          eventId: EventId.make(`event:${projectId}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-11-01T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: projectId,
            workspaceRoot: `/scratch/${projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        } as any);
    }),
  );

  const memoryOf = (projectId: ProjectId) =>
    run(
      Effect.gen(function* () {
        const service = yield* Workspace.ProjectWorkspaceService;
        return Object.fromEntries(
          (yield* service.readMemoryFiles({ projectId })).map((file) => [file.name, file.content]),
        );
      }),
    );
  const write = (name: string, content: string, projectId: ProjectId = PERCY) =>
    run(
      Effect.gen(function* () {
        const service = yield* Workspace.ProjectWorkspaceService;
        const current = yield* service.readMemory({ projectId, name }).pipe(Effect.option);
        return yield* service.writeMemory({
          projectId,
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
        const current = yield* service.readMemory({ projectId: PERCY, name });
        yield* service.deleteMemory({
          projectId: PERCY,
          name,
          expectedRevision: current.revision,
        });
      }),
    );
  const history = run(
    Effect.service(LinkedMemoryHistory.LinkedMemoryHistory).pipe(
      Effect.flatMap((service) => service.read(PERCY)),
    ),
  );
  const points = yield* run(Effect.service(PersonalRestorePoint));
  const config = yield* run(Effect.service(ServerConfig.ServerConfig));
  /** What a restore puts back besides memory. */
  const assistant = () => ({
    title: project.title,
    icon: project.projectIcon,
    instructions: project.workspaceSettings!.instructions,
    repositories: project.workspaceSettings!.environment.repositories,
    localOnly: project.workspaceSettings!.localOnlyMemoryFiles,
  });
  return {
    points,
    backups: NodePath.join(config.stateDir, "backups", "personal-link"),
    memoryOf,
    write,
    remove,
    history,
    updates,
    assistant,
    current: () => project,
    change: (next: (project: Project) => Project) => {
      project = next(project);
    },
    /** Every settings write from now on is refused as a revision conflict. */
    moveSettingsOn: () => {
      settingsMovedOn = true;
    },
  };
});

type Machine = Effect.Success<typeof makeMachine>;

const seed = (machine: Machine) =>
  Effect.gen(function* () {
    yield* machine.write("MEMORY.md", "# Memory\n\n- [Health](health.md)\n- [Work](work.md)\n");
    yield* machine.write("health.md", "private, kept on this machine\n");
    yield* machine.write("work.md", "the office");
    yield* machine.write("notes.md", "line one\r\nline two, no final newline");
    yield* machine.write("README.md", "the code project's own memory", OTHER);
  });

/** The merge and everything after it: every restored field is changed. */
const changeEverything = (machine: Machine) =>
  Effect.gen(function* () {
    yield* machine.write("MEMORY.md", "# Memory\n\n- [Home](home.md)\n- [Work](work.md)\n");
    yield* machine.write("work.md", "the office, as another machine wrote it");
    yield* machine.write("home.md", "added by the link");
    yield* machine.write("notes.from-laptop.md", "renamed for the merge");
    yield* machine.remove("notes.md");
    machine.change((project) => ({
      ...project,
      title: "Percy",
      projectIcon: null,
      workspaceSettings: {
        ...project.workspaceSettings!,
        revision: project.workspaceSettings!.revision + 3,
        instructions: "The link's instructions.",
        environment: {
          additionalFolders: [],
          repositories: [
            { id: "taxes", url: "https://github.com/example/taxes.git", localPath: null },
            { id: "vault", url: "https://github.com/example/vault.git", localPath: null },
          ],
        },
        localOnlyMemoryFiles: ["health.md", "notes.from-laptop.md"],
      },
    }));
  });

const pointFiles = (machine: Machine) =>
  NodeFS.existsSync(machine.backups) ? NodeFS.readdirSync(machine.backups).toSorted() : [];

describe("PersonalRestorePoint.capture", () => {
  it.effect("saves only this assistant, as one owner-only file in the backups folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        const point = yield* machine.points.capture(PERCY, "before-link");
        assert.strictEqual(point.reason, "before-link");
        assert.strictEqual(point.memoryFileCount, 4);
        assert.strictEqual(point.path, NodePath.join(machine.backups, `${point.id}.percy.json`));
        // Nothing else is written: no temporary file is left, and nothing outside the folder.
        assert.deepStrictEqual(pointFiles(machine), [`${point.id}.percy.json`]);
        if (HostProcessPlatform.defaultValue() !== "win32")
          assert.strictEqual(NodeFS.statSync(point.path).mode & 0o777, 0o600);

        const saved = JSON.parse(NodeFS.readFileSync(point.path, "utf8"));
        assert.strictEqual(saved.projectId, PERCY);
        assert.deepStrictEqual(saved.assistant, {
          title: "Percy on Laptop",
          icon: { kind: "lucide", name: "sparkles", color: "violet" },
          instructions: "Answer briefly.",
          repositories: originalSettings.environment.repositories,
          localOnlyMemoryFiles: ["health.md"],
        });
        assert.deepStrictEqual(
          saved.memory.map((file: Patch) => [file.name, file.content, file.localOnly]),
          [
            ["MEMORY.md", "# Memory\n\n- [Health](health.md)\n- [Work](work.md)\n", false],
            ["health.md", "private, kept on this machine\n", true],
            ["notes.md", "line one\r\nline two, no final newline", false],
            ["work.md", "the office", false],
          ],
        );
        assert.deepStrictEqual(saved.link, {
          logicalProjectId: null,
          members: [],
          routineOwner: true,
        });
        // The other project's memory is not in the point.
        assert.notInclude(NodeFS.readFileSync(point.path, "utf8"), "the code project's own memory");
      }),
    ),
  );

  it.effect("records the link the assistant was in, for information", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        const members = ["laptop", "desktop"].map((name) => ({
          environmentId: EnvironmentId.make(`env-${name}`),
          projectId: ProjectId.make(`percy-${name}`),
          coordinatorThreadId: ThreadId.make(`project-coordinator:percy-${name}`),
        }));
        machine.change((project) => ({
          ...project,
          workspaceSettings: {
            ...project.workspaceSettings!,
            logicalProject: {
              id: "logical:percy:test",
              title: "Percy",
              coordinatorId: members[0]!.coordinatorThreadId,
              members,
            },
            coordinatorBinding: { epoch: 0, state: "active", routineOwner: false },
          },
        }));
        const point = yield* machine.points.capture(PERCY, "before-undo");
        assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(point.path, "utf8")).link, {
          logicalProjectId: "logical:percy:test",
          members: members.map(({ environmentId, projectId }) => ({ environmentId, projectId })),
          routineOwner: false,
        });
      }),
    ),
  );

  it.effect("lists this assistant's points newest first, even on one clock tick", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        const first = yield* machine.points.capture(PERCY, "before-link");
        const second = yield* machine.points.capture(PERCY, "before-undo");
        const third = yield* machine.points.capture(PERCY, "before-link");
        assert.deepStrictEqual(yield* machine.points.list(PERCY), [third, second, first]);
        assert.isTrue(first.savedAt < second.savedAt && second.savedAt < third.savedAt);
        assert.deepStrictEqual(yield* machine.points.list(OTHER), []);
      }),
    ),
  );

  it.effect("refuses a project that is not a personal assistant, or is not there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        const code = yield* Effect.flip(machine.points.capture(OTHER, "before-link"));
        assert.instanceOf(code, PersonalRestoreAssistantError);
        assert.strictEqual(code.reason, "not_personal");
        const missing = yield* Effect.flip(
          machine.points.capture(ProjectId.make("nobody"), "before-link"),
        );
        assert.instanceOf(missing, PersonalRestoreAssistantError);
        assert.strictEqual(missing.reason, "not_found");
        assert.deepStrictEqual(pointFiles(machine), []);
      }),
    ),
  );
});

describe("PersonalRestorePoint.restore", () => {
  it.effect("puts memory and settings back byte for byte and leaves no tombstone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        const memoryBefore = yield* machine.memoryOf(PERCY);
        const assistantBefore = machine.assistant();
        const point = yield* machine.points.capture(PERCY, "before-link");
        yield* changeEverything(machine);
        assert.notDeepEqual(yield* machine.memoryOf(PERCY), memoryBefore);
        assert.property((yield* machine.history).tombstones, "notes.md");

        const result = yield* machine.points.restore(PERCY);
        assert.deepStrictEqual(result.restored, point);
        assert.deepStrictEqual(result.memory, { rewritten: 2, recreated: 1, removed: 2 });
        assert.isTrue(result.repositoriesRestored);
        assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memoryBefore);
        assert.deepStrictEqual(machine.assistant(), assistantBefore);
        // The files added after the capture are gone, and nothing tells a peer to delete them.
        const history = yield* machine.history;
        assert.deepStrictEqual(history.tombstones, {});
        assert.notProperty(history.files, "home.md");
        assert.notProperty(history.files, "notes.from-laptop.md");
        // A rewritten file starts over: no version from the link is remembered as its past.
        assert.deepStrictEqual(history.files["work.md"]?.history, [
          LinkedMemoryHistory.memoryContentHash("the office"),
        ]);
        // The restore is not a new edit of what linked seats share.
        assert.deepStrictEqual(
          machine.updates.map((update) => update.sharedStampMode),
          ["suppress"],
        );
        // Another project's memory is untouched.
        assert.deepStrictEqual(yield* machine.memoryOf(OTHER), {
          "README.md": "the code project's own memory",
        });
      }),
    ),
  );

  it.effect("saves the state before it, so an undo can itself be undone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        const memoryBefore = yield* machine.memoryOf(PERCY);
        yield* machine.points.capture(PERCY, "before-link");
        yield* changeEverything(machine);
        const memoryMerged = yield* machine.memoryOf(PERCY);
        const assistantMerged = machine.assistant();

        const undone = yield* machine.points.restore(PERCY);
        assert.strictEqual(undone.savedBefore.reason, "before-undo");
        assert.deepStrictEqual(
          (yield* machine.points.list(PERCY)).map((point) => point.reason),
          ["before-undo", "before-link"],
        );
        assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memoryBefore);

        const redone = yield* machine.points.restore(PERCY, undone.savedBefore.id);
        assert.deepStrictEqual(redone.restored, undone.savedBefore);
        assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memoryMerged);
        assert.deepStrictEqual(machine.assistant(), assistantMerged);
        assert.deepStrictEqual((yield* machine.history).tombstones, {});
        // With no id, a "before-link" point older than the last undo is never picked by itself:
        // it belongs to an earlier series (1448 D-16). Named, it is restored again.
        const again = yield* Effect.flip(machine.points.restore(PERCY));
        assert.instanceOf(again, PersonalRestorePointMissingError);
        assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memoryMerged);
        const named = yield* machine.points.restore(PERCY, undone.restored.id);
        assert.strictEqual(named.restored.reason, "before-link");
        assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memoryBefore);
      }),
    ),
  );

  it.effect("changes nothing when the assistant already matches the point", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        yield* machine.points.capture(PERCY, "before-link");
        const result = yield* machine.points.restore(PERCY);
        assert.deepStrictEqual(result.memory, { rewritten: 0, recreated: 0, removed: 0 });
        assert.deepStrictEqual(machine.updates, []);
      }),
    ),
  );

  it.effect("restores the rest when this machine refuses the repository list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        machine.change((project) => ({
          ...project,
          workspaceSettings: {
            ...project.workspaceSettings!,
            environment: {
              additionalFolders: [],
              repositories: [
                {
                  id: "taxes",
                  url: "https://github.com/example/taxes.git",
                  localPath: GONE_FOLDER,
                },
              ],
            },
          },
        }));
        yield* machine.points.capture(PERCY, "before-link");
        yield* changeEverything(machine);
        const linked = machine.assistant().repositories;

        const result = yield* machine.points.restore(PERCY);
        assert.isFalse(result.repositoriesRestored);
        assert.deepStrictEqual(machine.assistant().repositories, linked);
        assert.strictEqual(machine.assistant().title, "Percy on Laptop");
        assert.strictEqual(machine.assistant().instructions, "Answer briefly.");
        assert.strictEqual((yield* machine.memoryOf(PERCY))["work.md"], "the office");
      }),
    ),
  );

  it.effect("refuses a damaged point and changes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        const point = yield* machine.points.capture(PERCY, "before-link");
        yield* changeEverything(machine);
        const memory = yield* machine.memoryOf(PERCY);
        const project = machine.current();
        const text = NodeFS.readFileSync(point.path, "utf8");
        const saved = JSON.parse(text);
        const damaged: ReadonlyArray<readonly [string, string]> = [
          // Cut short, as after a full disk.
          ["unreadable or cut short", text.slice(0, text.length / 2)],
          ["not JSON", "not a restore point"],
          ["another version", JSON.stringify({ ...saved, version: 2 })],
          ["a field missing", JSON.stringify({ ...saved, assistant: undefined })],
          ["another assistant's", JSON.stringify({ ...saved, projectId: OTHER })],
          [
            "a memory file changed after it was saved",
            JSON.stringify({
              ...saved,
              memory: saved.memory.map((file: Patch) =>
                file.name === "work.md" ? { ...file, content: "edited in the file" } : file,
              ),
            }),
          ],
          [
            "a memory name that is a path",
            JSON.stringify({
              ...saved,
              memory: [{ ...saved.memory[0], name: "../outside.md" }],
            }),
          ],
        ];
        for (const [what, content] of damaged) {
          NodeFS.writeFileSync(point.path, content);
          const error = yield* Effect.flip(machine.points.restore(PERCY, point.id));
          assert.instanceOf(error, PersonalRestorePointInvalidError, what);
          assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memory, what);
          assert.strictEqual(machine.current(), project, what);
          // Not even the "before-undo" point is written.
          assert.deepStrictEqual(pointFiles(machine), [`${point.id}.percy.json`], what);
        }
        assert.deepStrictEqual(machine.updates, []);
      }),
    ),
  );

  it.effect("refuses a missing point, and an id it did not make", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        const none = yield* Effect.flip(machine.points.restore(PERCY));
        assert.instanceOf(none, PersonalRestorePointMissingError);
        const unknown = yield* Effect.flip(
          machine.points.restore(PERCY, "20261124T093015123Z-before-link-0a1b2c3d"),
        );
        assert.instanceOf(unknown, PersonalRestorePointMissingError);
        // A path is never followed: only ids this service made name a file.
        const outside = NodePath.join(machine.backups, "..", "elsewhere.percy.json");
        NodeFS.mkdirSync(machine.backups, { recursive: true });
        NodeFS.writeFileSync(outside, "{}");
        for (const id of ["../elsewhere", "elsewhere", "", "a/b"]) {
          const error = yield* Effect.flip(machine.points.restore(PERCY, id));
          assert.instanceOf(error, PersonalRestorePointInvalidError, id);
          assert.strictEqual(error.problem, "id");
        }
        // Only a "before-undo" point is saved: there is still no default point to restore.
        yield* machine.points.capture(PERCY, "before-undo");
        assert.instanceOf(
          yield* Effect.flip(machine.points.restore(PERCY)),
          PersonalRestorePointMissingError,
        );
        assert.deepStrictEqual(machine.updates, []);
      }),
    ),
  );

  it.effect("refuses while the assistant is still linked to other machines", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        const point = yield* machine.points.capture(PERCY, "before-link");
        yield* changeEverything(machine);
        const members = ["laptop", "desktop"].map((name) => ({
          environmentId: EnvironmentId.make(`env-${name}`),
          projectId: ProjectId.make(`percy-${name}`),
          coordinatorThreadId: ThreadId.make(`project-coordinator:percy-${name}`),
        }));
        machine.change((project) => ({
          ...project,
          workspaceSettings: {
            ...project.workspaceSettings!,
            logicalProject: {
              id: "logical:percy:test",
              title: "Percy",
              coordinatorId: members[0]!.coordinatorThreadId,
              members,
            },
          },
        }));
        const memory = yield* machine.memoryOf(PERCY);
        const error = yield* Effect.flip(machine.points.restore(PERCY));
        assert.instanceOf(error, PersonalRestoreStillLinkedError);
        assert.strictEqual(error.members, 2);
        assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memory);
        assert.deepStrictEqual(pointFiles(machine), [`${point.id}.percy.json`]);
        assert.deepStrictEqual(machine.updates, []);

        // Once the caller left the link (a one-member identity), the same restore runs.
        machine.change((project) => ({
          ...project,
          workspaceSettings: {
            ...project.workspaceSettings!,
            logicalProject: {
              ...project.workspaceSettings!.logicalProject!,
              members: members.slice(0, 1),
            },
          },
        }));
        yield* machine.points.restore(PERCY);
        assert.strictEqual((yield* machine.memoryOf(PERCY))["work.md"], "the office");
      }),
    ),
  );

  it.effect("stops before memory when the settings cannot be written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        yield* seed(machine);
        yield* machine.points.capture(PERCY, "before-link");
        yield* changeEverything(machine);
        const memory = yield* machine.memoryOf(PERCY);
        machine.moveSettingsOn();
        const error = yield* Effect.flip(machine.points.restore(PERCY));
        assert.instanceOf(error, PersonalRestoreStorageError);
        assert.strictEqual(error.stage, "restore-settings");
        assert.deepStrictEqual(yield* machine.memoryOf(PERCY), memory);
      }),
    ),
  );
});
