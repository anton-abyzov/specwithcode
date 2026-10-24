import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectFolderCheck,
  ProjectId,
  type RuntimeRequestId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as ProjectActionRequests from "./ProjectActionRequests.ts";
import { ProjectFolderService } from "./ProjectFolderChange.ts";
import * as ProjectService from "./ProjectService.ts";
import { projectFixture } from "./ProjectWorkspace.testkit.ts";

const projectId = ProjectId.make("easychamp");
const otherProjectId = ProjectId.make("old-site");
const threadId = ThreadId.make("coordinator");

interface World {
  readonly projects: Map<ProjectId, Project>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  readonly updates: Array<ProjectService.ProjectUpdateInput>;
  readonly deletes: Array<ProjectService.ProjectDeleteInput>;
  readonly folderChanges: Array<{ workspaceRoot: string; confirmDifferentRepository?: boolean }>;
  failFolderChange: boolean;
  /** Another thread in the project is running: the service denies non-additive folder edits. */
  otherThreadActive: boolean;
}

function newWorld(): World {
  return {
    projects: new Map([
      [projectId, projectFixture(projectId, { title: "easychamp", workspaceRoot: "/p/stub" })],
      [
        otherProjectId,
        projectFixture(otherProjectId, { title: "Old site", workspaceRoot: "/p/old" }),
      ],
    ]),
    dispatched: [],
    updates: [],
    deletes: [],
    folderChanges: [],
    failFolderChange: false,
    otherThreadActive: false,
  };
}

const folderCheck = (workspaceRoot: string): ProjectFolderCheck => ({
  projectId,
  currentRoot: "/p/stub",
  targetRoot: workspaceRoot,
  unchanged: false,
  targetExists: true,
  currentRepository: null,
  targetRepository: "github.com/easychamp/easychamp",
  sameRepository: false,
  conflictingProject: null,
  activeThreads: [],
  threadCount: 14,
  reboundWorktreeCount: 0,
  keptInPlaceCount: 0,
  specweaveWorkspace: true,
});

const layerFor = (world: World) =>
  ProjectActionRequests.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Persistence.layerMemory,
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.fromNullishOr(world.projects.get(id))),
          update: (input) => {
            const project = world.projects.get(input.projectId)!;
            const environment = input.workspaceSettings?.environment;
            const prior = project.workspaceSettings?.environment ?? {
              additionalFolders: [],
              repositories: [],
            };
            if (
              environment !== undefined &&
              world.otherThreadActive &&
              !ProjectService.isAdditiveEnvironmentChange(prior, environment)
            )
              return Effect.fail(
                new ProjectService.ProjectRequestDeniedError({
                  projectId: input.projectId,
                  reason: "environment_active",
                }),
              );
            world.updates.push(input);
            const next = {
              ...project,
              workspaceSettings: {
                ...project.workspaceSettings,
                archived: input.workspaceSettings?.archived ?? false,
                ...(environment === undefined ? {} : { environment }),
              } as Project["workspaceSettings"],
            };
            world.projects.set(input.projectId, next);
            return Effect.succeed(next);
          },
          delete: (input) => {
            world.deletes.push(input);
            const project = world.projects.get(input.projectId)!;
            world.projects.delete(input.projectId);
            return Effect.succeed(project);
          },
        }),
        Layer.mock(ProjectFolderService)({
          check: (input) => Effect.succeed(folderCheck(input.workspaceRoot)),
          change: (input) => {
            world.folderChanges.push({
              workspaceRoot: input.workspaceRoot,
              ...(input.confirmDifferentRepository === undefined
                ? {}
                : { confirmDifferentRepository: input.confirmDifferentRepository }),
            });
            if (world.failFolderChange)
              return Effect.fail(
                new ProjectService.ProjectFolderChangeError({
                  projectId,
                  reason: "active_work",
                  detail: 'Stop the running work first: "Worker".',
                }),
              );
            const project = {
              ...world.projects.get(projectId)!,
              workspaceRoot: input.workspaceRoot,
            };
            world.projects.set(projectId, project);
            return Effect.succeed({
              project,
              previousRoot: "/p/stub",
              reboundWorktrees: 0,
              keptInPlace: 0,
              relocatedSessions: 0,
            });
          },
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [{ id: threadId, projectId, deletedAt: null }],
              archivedThreads: [],
            } as never),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: "run-1", ordinal: 1, status: "running", rootNodeId: "node-1" }],
            } as never),
          getThreadShell: () =>
            Effect.succeed({ id: threadId, projectId } as OrchestrationV2ThreadShell),
          dispatch: (command) => {
            world.dispatched.push(command as OrchestrationV2ServerCommand);
            return Effect.succeed({ sequence: world.dispatched.length, storedEvents: [] });
          },
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const answer = (requestId: RuntimeRequestId, choice: string) =>
  ProjectActionRequests.ProjectActionRequests.pipe(
    Effect.flatMap((requests) =>
      requests.answer({
        type: "runtime-request.respond",
        commandId: CommandId.make(`answer:${requestId}`),
        threadId,
        requestId,
        answers: { approval: choice },
      }),
    ),
  );

const request = (input: Omit<ProjectActionRequests.ProjectActionRequestInput, "threadId">) =>
  ProjectActionRequests.ProjectActionRequests.pipe(
    Effect.flatMap((requests) => requests.request({ threadId, ...input })),
  );

const auditRow = (requestId: RuntimeRequestId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      status: string;
      outcome: string | null;
      action: string;
    }>`SELECT status, outcome, action FROM project_action_requests WHERE request_id = ${requestId}`;
    return rows[0];
  });

function card(world: World) {
  const recorded = world.dispatched.find((command) => command.type === "user_input_request.record");
  if (recorded?.type !== "user_input_request.record") throw new Error("no card");
  return recorded;
}

function lastAnswer(world: World) {
  const respond = world.dispatched.findLast(
    (command) => command.type === "runtime-request.respond",
  );
  return respond?.type === "runtime-request.respond" ? respond.answers?.approval : undefined;
}

it.effect("an approved folder change re-points the project and tells the agent", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { requestId } = yield* request({
      projectId,
      action: "change_folder",
      workspaceRoot: "/p",
      reason: "The project points at a managed stub, not the repository.",
    });
    expect(ProjectActionRequests.isProjectActionRequestId(requestId)).toBe(true);
    const shown = card(world);
    expect(shown.requestId).toBe(requestId);
    expect(shown.questions[0]?.allowCustomAnswer).toBe(false);
    expect(shown.questions[0]?.options.map((option) => option.label)).toEqual([
      "Approve",
      "Decline",
    ]);
    expect(shown.questions[0]?.question).toContain(
      'Change the folder of the project "easychamp" from /p/stub to /p?',
    );
    expect(shown.questions[0]?.question).toContain("Approving confirms it is the right folder.");
    expect(world.folderChanges).toEqual([]);
    expect((yield* auditRow(requestId))?.status).toBe("pending");

    yield* answer(requestId, "Approve");
    expect(world.folderChanges).toEqual([
      { workspaceRoot: "/p", confirmDifferentRepository: true },
    ]);
    expect(lastAnswer(world)).toBe(
      'Approve. Changed the folder of "easychamp" from /p/stub to /p. Threads run there from their next turn.',
    );
    expect(yield* auditRow(requestId)).toMatchObject({
      status: "approved",
      action: "change_folder",
    });
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("a declined request changes nothing and is recorded", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { requestId } = yield* request({
      projectId: otherProjectId,
      action: "archive",
      reason: "Finished.",
    });
    yield* answer(requestId, "Decline");
    expect(world.updates).toEqual([]);
    expect(lastAnswer(world)).toBe("Decline. Nothing changed.");
    expect((yield* auditRow(requestId))?.status).toBe("declined");
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("archiving another project applies first, then reports", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { requestId } = yield* request({
      projectId: otherProjectId,
      action: "archive",
      reason: "Finished.",
    });
    yield* answer(requestId, "Approve");
    expect(world.updates).toMatchObject([
      { projectId: otherProjectId, workspaceSettings: { archived: true } },
    ]);
    expect(lastAnswer(world)).toContain('Approve. Archived the project "Old site".');
    expect((yield* auditRow(requestId))?.status).toBe("approved");

    const restore = yield* request({
      projectId: otherProjectId,
      action: "unarchive",
      reason: "Needed again.",
    });
    yield* answer(restore.requestId, "Approve");
    expect(world.updates.at(-1)).toMatchObject({ workspaceSettings: { archived: false } });
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("archiving the asking thread's own project answers before archiving", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { requestId } = yield* request({ projectId, action: "archive", reason: "Done." });
    yield* answer(requestId, "Approve");
    const respondIndex = world.dispatched.findIndex(
      (command) => command.type === "runtime-request.respond",
    );
    expect(respondIndex).toBeGreaterThan(-1);
    expect(world.updates).toHaveLength(1);
    expect(lastAnswer(world)).toContain("Archiving the project now");
    expect((yield* auditRow(requestId))?.status).toBe("approved");
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("delete runs only on approval, with the card exempt from the active-work check", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { requestId } = yield* request({
      projectId: otherProjectId,
      action: "delete",
      reason: "Replaced by the new site.",
    });
    // The first paragraph is what the card asks; consequences and the reason sit below it.
    expect(card(world).questions[0]?.question.split("\n\n")).toEqual([
      'Delete the project "Old site" and its 0 threads?',
      "This cannot be undone. Project memory, plans and routines are removed; source folders and Git branches stay. Archiving keeps everything instead.",
      "Reason: Replaced by the new site.",
    ]);
    expect(world.deletes).toEqual([]);
    yield* answer(requestId, "Approve");
    expect(world.deletes).toMatchObject([
      {
        projectId: otherProjectId,
        force: true,
        confirmationTitle: "Old site",
        approvalRequestId: requestId,
      },
    ]);
    expect(lastAnswer(world)).toBe('Approve. Deleted the project "Old site" and its threads.');
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("deleting the asking thread's own project leaves no card to resolve", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { requestId } = yield* request({ projectId, action: "delete", reason: "Wrong project." });
    const result = yield* answer(requestId, "Approve");
    expect(result.sequence).toBe(0);
    expect(world.deletes).toHaveLength(1);
    expect(world.dispatched.some((command) => command.type === "runtime-request.respond")).toBe(
      false,
    );
    expect((yield* auditRow(requestId))?.status).toBe("approved");
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("an approved change that fails says why and records the failure", () => {
  const world = newWorld();
  world.failFolderChange = true;
  return Effect.gen(function* () {
    const { requestId } = yield* request({
      projectId,
      action: "change_folder",
      workspaceRoot: "/p",
      reason: "Wrong folder.",
    });
    yield* answer(requestId, "Approve");
    expect(lastAnswer(world)).toBe(
      'Approve, but nothing changed: Stop the running work first: "Worker".',
    );
    expect((yield* auditRow(requestId))?.status).toBe("failed");
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("refuses requests that cannot apply", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const restore = yield* request({ projectId, action: "unarchive", reason: "x" }).pipe(
      Effect.flip,
    );
    expect(restore.message).toBe('The project "easychamp" is not archived.');
    const noFolder = yield* request({ projectId, action: "change_folder", reason: "x" }).pipe(
      Effect.flip,
    );
    expect(noFolder.message).toContain("Pass workspaceRoot");
    expect(world.dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("a repeated answer to a decided card goes to the orchestrator unchanged", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { requestId } = yield* request({
      projectId: otherProjectId,
      action: "archive",
      reason: "Finished.",
    });
    yield* answer(requestId, "Decline");
    const before = world.dispatched.length;
    yield* answer(requestId, "Approve");
    expect(world.updates).toEqual([]);
    expect(world.dispatched).toHaveLength(before + 1);
    expect(lastAnswer(world)).toBe("Approve");
  }).pipe(Effect.provide(layerFor(world)));
});

/**
 * Gives `world`'s project a real folder: add_folder resolves real paths. The folders live
 * in a scoped temporary directory removed when the test ends.
 */
const withFolders = Effect.fn("withFolders")(function* (
  world: World,
  settings: Partial<NonNullable<Project["workspaceSettings"]>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs
    .makeTempDirectoryScoped({ prefix: "add-folder-" })
    .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
  const dir = (name: string) =>
    fs
      .makeDirectory(path.join(base, name), { recursive: true })
      .pipe(Effect.as(path.join(base, name)));
  const link = (target: string, name: string) =>
    fs
      .remove(path.join(base, name), { force: true })
      .pipe(
        Effect.andThen(fs.symlink(target, path.join(base, name))),
        Effect.as(path.join(base, name)),
      );
  const root = yield* dir("project");
  world.projects.set(
    projectId,
    projectFixture(projectId, {
      title: "easychamp",
      workspaceRoot: root,
      workspaceSettings: {
        revision: 3,
        environment: { additionalFolders: [], repositories: [] },
        ...settings,
      } as Project["workspaceSettings"],
    }),
  );
  return { base, root, dir, link };
});

const setApprovedFolders = (world: World, additionalFolders: ReadonlyArray<string>) => {
  const project = world.projects.get(projectId)!;
  world.projects.set(projectId, {
    ...project,
    workspaceSettings: {
      ...project.workspaceSettings,
      environment: { additionalFolders, repositories: [] },
    } as Project["workspaceSettings"],
  });
};

const folderLayer = (world: World) => Layer.mergeAll(layerFor(world), NodeServices.layer);

it.effect("add_folder approved while another thread runs adds the folder's real path", () => {
  const world = newWorld();
  world.otherThreadActive = true;
  return Effect.gen(function* () {
    const { dir, link } = yield* withFolders(world);
    const shared = yield* dir("shared");
    const alias = yield* link(shared, "alias");
    const { requestId } = yield* request({
      projectId,
      action: "add_folder",
      folder: alias,
      reason: "The app checkout lives outside the project folder.",
    });
    // The thread toolkit refuses agents answering any card with this prefix.
    expect(ProjectActionRequests.isProjectActionRequestId(requestId)).toBe(true);
    const question = card(world).questions[0]?.question ?? "";
    expect(question.split("\n\n")[0]).toBe(
      `Let agents in the project "easychamp" read and write ${shared}?`,
    );
    expect(question).toContain(`You asked for ${alias}, which resolves to it.`);
    expect(question).toContain("This is the project's first extra folder");
    expect(question).not.toContain("personal project");
    expect(question).toContain("Reason: The app checkout lives outside the project folder.");
    expect(world.updates).toEqual([]);

    yield* answer(requestId, "Approve");
    expect(world.updates).toMatchObject([
      {
        projectId,
        approvalRequestId: requestId,
        workspaceSettings: {
          expectedRevision: 3,
          environment: { additionalFolders: [shared], repositories: [] },
        },
      },
    ]);
    expect(lastAnswer(world)).toBe(
      `Approve. Added ${shared} to the approved folders of "easychamp". Threads there can use it from their next turn.`,
    );
    expect(yield* auditRow(requestId)).toMatchObject({ status: "approved", action: "add_folder" });
  }).pipe(Effect.scoped, Effect.provide(folderLayer(world)));
});

it.effect("a declined add_folder changes nothing", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { dir } = yield* withFolders(world);
    const { requestId } = yield* request({
      projectId,
      action: "add_folder",
      folder: yield* dir("shared"),
      reason: "x",
    });
    yield* answer(requestId, "Decline");
    expect(world.updates).toEqual([]);
    expect(lastAnswer(world)).toBe("Decline. Nothing changed.");
    expect((yield* auditRow(requestId))?.status).toBe("declined");
  }).pipe(Effect.scoped, Effect.provide(folderLayer(world)));
});

it.effect("add_folder refuses protected, reachable, unknown and over-limit folders", () => {
  const world = newWorld();
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const refused = (folder: string | undefined, target = projectId) =>
    request({
      projectId: target,
      action: "add_folder",
      reason: "x",
      ...(folder === undefined ? {} : { folder }),
    }).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    );
  return Effect.gen(function* () {
    const { base, root, dir } = yield* withFolders(world);
    const home = yield* dir("home");
    const ssh = yield* dir("home/.ssh");
    const approved = yield* dir("approved");
    const fresh = yield* dir("fresh");
    // The protected-location check reads the home folder from os.homedir(): HOME, or
    // USERPROFILE on Windows.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    setApprovedFolders(world, [approved]);
    expect(yield* refused(home)).toContain("it is the home folder");
    expect(yield* refused(ssh)).toContain("such as ~/.ssh");
    // A case-insensitive volume (macOS, Windows) resolves another spelling to the same
    // folder; it must be refused the same way, not approved under the new spelling.
    const fs = yield* FileSystem.FileSystem;
    for (const variant of [`${home}/.SSH`, home.toUpperCase()])
      expect(yield* refused(variant)).toContain(
        (yield* fs.exists(variant)) ? "cannot be approved" : "does not exist",
      );
    expect(yield* refused("/")).toContain("cannot be approved");
    expect(yield* refused(approved)).toBe(`Agents in "easychamp" can already reach ${approved}.`);
    expect(yield* refused(root)).toBe(`Agents in "easychamp" can already reach ${root}.`);
    expect(yield* refused(yield* dir("project/src"))).toContain(`it is inside ${root}`);
    expect(yield* refused(`${base}/missing`)).toContain("does not exist");
    expect(yield* refused("relative/folder")).toContain("Pass an absolute folder");
    expect(yield* refused(undefined)).toContain("Pass folder");
    expect(yield* refused(fresh, otherProjectId)).toContain("its own project");
    const full = yield* Effect.forEach(
      Array.from({ length: 16 }, (_, index) => `full-${index}`),
      dir,
    );
    setApprovedFolders(world, full);
    expect(yield* refused(fresh)).toContain("already has 16 approved folders");
    expect(world.dispatched).toEqual([]);
    expect(world.updates).toEqual([]);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousProfile;
      }),
    ),
    Effect.scoped,
    Effect.provide(folderLayer(world)),
  );
});

it.effect("add_folder changes nothing when the folder's real path moved before approval", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { dir, link } = yield* withFolders(world);
    const shown = yield* dir("shown");
    const swapped = yield* dir("swapped");
    const alias = yield* link(shown, "link");
    const { requestId } = yield* request({
      projectId,
      action: "add_folder",
      folder: alias,
      reason: "x",
    });
    expect(card(world).questions[0]?.question).toContain(`read and write ${shown}?`);
    yield* link(swapped, "link");
    yield* answer(requestId, "Approve");
    expect(world.updates).toEqual([]);
    expect(lastAnswer(world)).toBe(
      `Approve, but nothing changed: ${alias} now resolves to ${swapped}, not the ${shown} the card named. Ask again.`,
    );
    expect((yield* auditRow(requestId))?.status).toBe("failed");
  }).pipe(Effect.scoped, Effect.provide(folderLayer(world)));
});

it.effect("an add_folder card on a personal project says the assistant can route there", () => {
  const world = newWorld();
  return Effect.gen(function* () {
    const { dir } = yield* withFolders(world, { kind: "personal" });
    setApprovedFolders(world, [yield* dir("existing")]);
    yield* request({
      projectId,
      action: "add_folder",
      folder: yield* dir("projects"),
      reason: "x",
    });
    const question = card(world).questions[0]?.question ?? "";
    expect(question).toContain(
      "This is a personal project: the assistant can then also route work into projects inside this folder.",
    );
    expect(question).not.toContain("first extra folder");
  }).pipe(Effect.scoped, Effect.provide(folderLayer(world)));
});
