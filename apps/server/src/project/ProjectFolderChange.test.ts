// @effect-diagnostics nodeBuiltinImport:off - The protected-folder case needs the real home folder.
import { expect, it } from "@effect/vitest";
import * as NodeOs from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { encodeClaudeProjectDir } from "../usage/projectFolderSessions.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFolderChange from "./ProjectFolderChange.ts";
import * as ProjectService from "./ProjectService.ts";
import { projectFixture } from "./ProjectWorkspace.testkit.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const projectId = ProjectId.make("easychamp");
const otherProjectId = ProjectId.make("EasyChamp");

function shell(
  id: string,
  patch: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    worktreePath: null,
    activeRunId: null,
    pendingRuntimeRequest: null,
    archivedAt: null,
    deletedAt: null,
    ...patch,
  } as OrchestrationV2ThreadShell;
}

interface Scenario {
  readonly root: string;
  readonly projects: Map<ProjectId, Project>;
  readonly threads: Array<OrchestrationV2ThreadShell>;
  /** Folder → repository key; folders not listed have no remote. */
  readonly repositories: Map<string, string>;
  readonly updates: Array<ProjectService.ProjectUpdateInput>;
  readonly dispatched: Array<OrchestrationV2Command>;
  readonly released: Array<string>;
  /** Thread → its Claude session, for the transcript relocation case. */
  readonly claudeSessions: Map<ThreadId, { sessionId: string; cwd: string }>;
  readonly claudeHome: string;
  /** Every thread command fails, as when the orchestrator is unavailable. */
  failDispatch: boolean;
  /** Fails only the matching thread commands; the rest succeed. */
  failCommand: ((command: OrchestrationV2Command) => boolean) | null;
  /** Runs after each successful thread command, e.g. to start work meanwhile. */
  afterDispatch: ((command: OrchestrationV2Command) => void) | null;
  /** projects.update fails, as when its own checks refuse the change. */
  failUpdate: boolean;
  /** projects.update commits the new root, then fails reading it back. */
  failUpdateAfterCommit: boolean;
  /** Folders whose git identity cannot be read (git fails, not "no remote"). */
  readonly unreadable: Set<string>;
  /** Soft-deleted projects, listed only with includeDeleted. */
  readonly deletedProjects: Array<Project>;
}

/** A temp tree like ~/Projects/sw-easychamp with the managed stub inside it. */
const makeScenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "folder-change-" }));
  const parent = path.join(root, "sw-easychamp");
  const stub = path.join(parent, "easychamp");
  yield* fs.makeDirectory(stub, { recursive: true });
  yield* fs.makeDirectory(path.join(parent, ".specweave"));
  const claudeHome = path.join(root, "claude-home");
  yield* fs.makeDirectory(claudeHome);
  const scenario: Scenario = {
    root,
    projects: new Map([
      [projectId, projectFixture(projectId, { title: "easychamp", workspaceRoot: stub })],
    ]),
    threads: [shell("coordinator"), shell("worker")],
    repositories: new Map([[parent, "github.com/easychamp/easychamp"]]),
    updates: [],
    dispatched: [],
    released: [],
    claudeSessions: new Map(),
    claudeHome,
    failDispatch: false,
    failCommand: null,
    afterDispatch: null,
    failUpdate: false,
    failUpdateAfterCommit: false,
    unreadable: new Set(),
    deletedProjects: [],
  };
  return { scenario, parent, stub };
});

const layerFor = (scenario: Scenario) =>
  ProjectFolderChange.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspacePaths.layer,
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.fromNullishOr(scenario.projects.get(id))),
          getByWorkspaceRoot: (root) =>
            Effect.succeed(
              Option.fromNullishOr(
                [...scenario.projects.values()].find((project) => project.workspaceRoot === root),
              ),
            ),
          update: (input) => {
            if (scenario.failUpdate)
              return Effect.fail(
                new ProjectService.ProjectRequestDeniedError({
                  projectId: input.projectId,
                  reason: "environment_active",
                }),
              );
            scenario.updates.push(input);
            const project = {
              ...scenario.projects.get(input.projectId)!,
              ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
            };
            scenario.projects.set(input.projectId, project);
            if (scenario.failUpdateAfterCommit)
              return Effect.fail(
                new ProjectService.ProjectOperationError({
                  operation: "read-project",
                  projectId: input.projectId,
                  cause: new Error("read failed"),
                }),
              );
            return Effect.succeed(project);
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({ threads: scenario.threads, archivedThreads: [] } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) => {
            if (
              scenario.failDispatch ||
              scenario.failCommand?.(command as OrchestrationV2Command) === true
            )
              return Effect.fail({ _tag: "DispatchFailed" } as never);
            scenario.dispatched.push(command as OrchestrationV2Command);
            scenario.afterDispatch?.(command as OrchestrationV2Command);
            return Effect.succeed({ sequence: scenario.dispatched.length, storedEvents: [] });
          },
          getThreadRecords: (threadId) => {
            const session = scenario.claudeSessions.get(threadId);
            return Effect.succeed({
              providerThreads:
                session === undefined
                  ? []
                  : [
                      {
                        driver: "claudeAgent",
                        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                        nativeThreadRef: { nativeId: session.sessionId },
                      },
                    ],
              providerSessions:
                session === undefined
                  ? []
                  : [{ id: `session-${threadId}`, status: "ready", cwd: session.cwd }],
            } as never);
          },
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: (folder) =>
            Effect.succeed(
              scenario.repositories.has(folder) && !scenario.unreadable.has(folder)
                ? ({ canonicalKey: scenario.repositories.get(folder)! } as never)
                : null,
            ),
          resolveStrict: (folder) =>
            scenario.unreadable.has(folder)
              ? Effect.fail(
                  new RepositoryIdentityResolver.RepositoryIdentityReadError({
                    cwd: folder,
                    detail: "fatal: detected dubious ownership in repository",
                  }),
                )
              : Effect.succeed(
                  scenario.repositories.has(folder)
                    ? ({ canonicalKey: scenario.repositories.get(folder)! } as never)
                    : null,
                ),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          list: (options) =>
            Effect.succeed(
              [
                ...[...scenario.projects.values()].map((project) => ({ project, deleted: false })),
                ...(options?.includeDeleted === true
                  ? scenario.deletedProjects.map((project) => ({ project, deleted: true }))
                  : []),
              ].map(
                ({ project, deleted }) =>
                  ({
                    projectId: project.id,
                    title: project.title,
                    workspaceRoot: project.workspaceRoot,
                    deletedAt: deleted ? "2026-10-20T00:00:00.000Z" : null,
                  }) as never,
              ),
            ),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          getMetadata: () =>
            Effect.succeed({
              driver: "claudeAgent",
              continuationKey: `claude:home:${scenario.claudeHome}`,
              enabled: true,
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          release: (input) => {
            scenario.released.push(input.providerSessionId);
            return Effect.void as never;
          },
        }),
      ),
    ),
  );

const withFolders = <A, E>(
  scenario: Scenario,
  use: (folders: ProjectFolderChange.ProjectFolderService["Service"]) => Effect.Effect<A, E>,
) =>
  ProjectFolderChange.ProjectFolderService.pipe(
    Effect.flatMap(use),
    Effect.provide(layerFor(scenario)),
  );

const commandId = CommandId.make("move-easychamp");

it.layer(NodeServices.layer)("ProjectFolderService", (it) => {
  it.effect("re-points easychamp from the managed stub to the repository root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* makeScenario;
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: `${parent}/` }),
        );
        expect(check).toMatchObject({
          currentRoot: stub,
          targetRoot: parent,
          unchanged: false,
          targetExists: true,
          conflictingProject: null,
          activeThreads: [],
          threadCount: 2,
          specweaveWorkspace: true,
          // The stub has no remote, so the user confirms the folder.
          sameRepository: false,
          currentRepository: null,
          targetRepository: "github.com/easychamp/easychamp",
        });
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({ commandId, projectId, workspaceRoot: parent }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "repository_mismatch" });
        expect(refused.message).toContain("Confirm that this is the right folder");
        expect(scenario.updates).toHaveLength(0);

        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        );
        expect(changed.previousRoot).toBe(stub);
        expect(changed.project.workspaceRoot).toBe(parent);
        expect(scenario.updates).toEqual([{ commandId, projectId, workspaceRoot: parent }]);
      }),
    ),
  );

  it.effect("refuses a folder another project owns and names it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent } = yield* makeScenario;
        scenario.projects.set(
          otherProjectId,
          projectFixture(otherProjectId, {
            title: "EasyChamp",
            workspaceRoot: parent,
            workspaceSettings: { archived: false } as Project["workspaceSettings"],
          }),
        );
        scenario.threads.push(shell("old-1", { projectId: otherProjectId }));
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "folder_conflict" });
        expect(refused.message).toContain('belongs to the project "EasyChamp" (1 thread)');
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses a missing folder and running work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent } = yield* makeScenario;
        const missing = yield* withFolders(scenario, (folders) =>
          folders.change({ commandId, projectId, workspaceRoot: `${parent}-gone` }),
        ).pipe(Effect.flip);
        expect(missing).toMatchObject({ reason: "folder_missing" });

        scenario.threads[0] = shell("coordinator", {
          title: "Coordinator",
          activeRunId: RunId.make("run-1"),
        });
        const busy = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(busy).toMatchObject({ reason: "active_work" });
        expect(busy.message).toContain('"Coordinator"');
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("ignores the approval card that asked for the change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent } = yield* makeScenario;
        const approvalRequestId = RuntimeRequestId.make("project-action:card");
        scenario.threads[0] = shell("coordinator", {
          pendingRuntimeRequest: {
            id: approvalRequestId,
            kind: "user_input",
            createdAt: "2026-10-15T00:00:00Z",
          } as unknown as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
        });
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent, approvalRequestId }),
        );
        expect(check.activeThreads).toEqual([]);
        const unrelated = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(unrelated.activeThreads).toHaveLength(1);
      }),
    ),
  );

  it.effect("moves between checkouts of one repository without a confirmation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { scenario, parent, stub } = yield* makeScenario;
        const moved = path.join(scenario.root, "moved-checkout");
        yield* fs.makeDirectory(moved);
        scenario.repositories.set(stub, "github.com/easychamp/easychamp");
        scenario.repositories.set(moved, "github.com/easychamp/easychamp");
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({ commandId, projectId, workspaceRoot: moved }),
        );
        expect(changed.project.workspaceRoot).toBe(moved);
        expect(parent).not.toBe(moved);
      }),
    ),
  );

  it.effect("rebinds thread checkouts inside the old folder that exist in the new one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { scenario, parent, stub } = yield* makeScenario;
        const boundOld = path.join(stub, ".worktrees", "fix");
        const boundNew = path.join(parent, ".worktrees", "fix");
        const stale = path.join(stub, ".worktrees", "stale");
        yield* fs.makeDirectory(boundOld, { recursive: true });
        yield* fs.makeDirectory(boundNew, { recursive: true });
        yield* fs.makeDirectory(stale, { recursive: true });
        scenario.threads.push(
          shell("bound", { worktreePath: boundOld }),
          shell("unmatched", { worktreePath: stale }),
          shell("elsewhere", { worktreePath: path.join(scenario.root, "other") }),
        );
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        );
        expect(changed.reboundWorktrees).toBe(1);
        expect(scenario.dispatched).toEqual([
          {
            type: "thread.metadata.update",
            commandId: CommandId.make(`${commandId}:worktree:bound`),
            threadId: ThreadId.make("bound"),
            worktreePath: boundNew,
            expectedWorktreePath: boundOld,
          },
        ]);
      }),
    ),
  );

  it.effect("copies Claude sessions to the new folder and closes idle agents in the old one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario, parent, stub } = yield* makeScenario;
        const sessionId = "0b7c2c1e-3f7d-4f4e-9d61-2b7b9a3c1d11";
        const oldDir = `${scenario.claudeHome}/projects/${encodeClaudeProjectDir(stub)}`;
        yield* fs.makeDirectory(oldDir, { recursive: true });
        yield* fs.writeFileString(`${oldDir}/${sessionId}.jsonl`, '{"type":"user"}\n');
        scenario.claudeSessions.set(ThreadId.make("coordinator"), { sessionId, cwd: stub });
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        );
        expect(changed.relocatedSessions).toBe(1);
        const copied = `${scenario.claudeHome}/projects/${encodeClaudeProjectDir(parent)}/${sessionId}.jsonl`;
        expect(yield* fs.readFileString(copied)).toBe('{"type":"user"}\n');
        // The original stays, so the old folder's history is still readable.
        expect(yield* fs.exists(`${oldDir}/${sessionId}.jsonl`)).toBe(true);
        expect(scenario.released).toEqual(["session-coordinator"]);
      }),
    ),
  );

  it.effect("keeps a repository's threads in place when the project moves up to its umbrella", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario, parent, stub } = yield* makeScenario;
        // Like specweave: a real checkout of its own repository inside the umbrella.
        scenario.repositories.set(stub, "github.com/anton-abyzov/specweave");
        scenario.repositories.set(parent, "github.com/anton-abyzov/specweave-umb");
        yield* fs.makeDirectory(`${stub}/.worktrees/fix`, { recursive: true });
        yield* fs.makeDirectory(`${parent}/.worktrees/fix`, { recursive: true });
        scenario.projects.set(
          projectId,
          projectFixture(projectId, {
            title: "specweave",
            workspaceRoot: stub,
            workspaceSettings: {
              coordinatorThreadId: ThreadId.make("coordinator"),
            } as Project["workspaceSettings"],
          }),
        );
        scenario.threads.push(
          shell("archived", { archivedAt: "2026-10-12T00:00:00Z" as never }),
          shell("bound", { worktreePath: `${stub}/.worktrees/fix` }),
        );
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(check).toMatchObject({ keptInPlaceCount: 2, reboundWorktreeCount: 0 });

        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        );
        expect(changed).toMatchObject({ keptInPlace: 2, reboundWorktrees: 0 });
        expect(changed.project.workspaceRoot).toBe(parent);
        // The worker and the archived thread stay in the repository; the coordinator
        // and the thread already on a checkout are left alone.
        expect(scenario.dispatched).toEqual(
          ["worker", "archived"].map((id) => ({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${commandId}:keep:${id}`),
            threadId: ThreadId.make(id),
            worktreePath: stub,
            expectedWorktreePath: null,
          })),
        );
      }),
    ),
  );

  it.effect("leaves the folder unchanged when a thread cannot stay in place", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* makeScenario;
        scenario.repositories.set(stub, "github.com/anton-abyzov/specweave");
        scenario.failDispatch = true;
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(refused.message).toContain(
          `could not stay in ${stub}, so the folder did not change`,
        );
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("keeps umbrella increments in reach and reports the umbrella layout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario, parent } = yield* makeScenario;
        yield* fs.writeFileString(`${parent}/.specweave/config.json`, "{}");
        yield* fs.makeDirectory(`${parent}/.specweave/increments/0001-start`, { recursive: true });
        yield* fs.makeDirectory(`${parent}/repositories/acme/api/.git`, { recursive: true });
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        // The stub plans in its umbrella already, so plan cards read the same increments.
        expect(check.planning).toMatchObject({
          currentRoot: parent,
          targetRoot: parent,
          currentIncrements: 1,
          changes: false,
        });
        expect(check.layout).toMatchObject({
          kind: "umbrella",
          repositories: ["repositories/acme/api"],
        });
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        );
        expect(changed.project.workspaceRoot).toBe(parent);
      }),
    ),
  );

  it.effect("refuses to leave the planning root until the user confirms it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario, parent, stub } = yield* makeScenario;
        yield* fs.writeFileString(`${parent}/.specweave/config.json`, "{}");
        yield* fs.makeDirectory(`${parent}/.specweave/increments/0001-start`, { recursive: true });
        const elsewhere = (yield* Path.Path).join(scenario.root, "elsewhere");
        yield* fs.makeDirectory(`${elsewhere}/.git`, { recursive: true });
        scenario.repositories.set(elsewhere, "github.com/easychamp/easychamp");
        scenario.repositories.set(stub, "github.com/easychamp/easychamp");
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: elsewhere }),
        );
        expect(check.layout?.kind).toBe("single");
        expect(check.planning).toMatchObject({
          currentRoot: parent,
          targetRoot: null,
          changes: true,
        });
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({ commandId, projectId, workspaceRoot: elsewhere }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "planning_impact" });
        expect(refused.message).toContain(`changing the folder back to ${stub} restores them`);
        expect(scenario.updates).toHaveLength(0);
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: elsewhere,
            confirmPlanningImpact: true,
          }),
        );
        expect(changed.previousRoot).toBe(stub);
        expect(scenario.updates).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "counts manual increment links through SQLite provided from outside, as the server does",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { scenario, parent, stub } = yield* makeScenario;
          yield* fs.writeFileString(`${parent}/.specweave/config.json`, "{}");
          yield* fs.makeDirectory(`${parent}/.specweave/increments/0001-start`, {
            recursive: true,
          });
          yield* fs.makeDirectory(`${parent}/.specweave/increments/0657E-followup`, {
            recursive: true,
          });
          const ownCheckout = path.join(scenario.root, "own-checkout");
          yield* fs.makeDirectory(`${ownCheckout}/.specweave/increments/0002-own`, {
            recursive: true,
          });
          scenario.threads.push(shell("isolated", { worktreePath: ownCheckout }));
          const elsewhere = path.join(scenario.root, "elsewhere");
          yield* fs.makeDirectory(`${elsewhere}/.git`, { recursive: true });
          scenario.repositories.set(elsewhere, "github.com/easychamp/easychamp");
          scenario.repositories.set(stub, "github.com/easychamp/easychamp");
          // The folder layer itself is built without SQLite; the client arrives from
          // an outer layer, like Sqlite.layerConfig in server.ts.
          const check = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const [threadId, incrementId] of [
              ["worker", "0657E-followup"],
              ["coordinator", "0001-start"],
              ["isolated", "0002-own"],
              ["someone-elses", "0001-start"],
            ])
              yield* sql`INSERT INTO thread_increment_links (thread_id, project_id, increment_id, linked_at) VALUES (${threadId}, ${projectId}, ${incrementId}, '2026-10-25T00:00:00.000Z')`;
            const folders = yield* ProjectFolderChange.ProjectFolderService;
            return yield* folders.check({ projectId, workspaceRoot: elsewhere });
          }).pipe(
            Effect.provide(
              layerFor(scenario).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
            ),
          );
          // A thread with its own increments keeps reading them, and other projects' links don't count.
          expect(check.planning).toMatchObject({
            currentRoot: parent,
            currentIncrements: 2,
            targetRoot: null,
            brokenLinks: ["0001-start", "0657E-followup"],
            changes: true,
          });
        }),
      ),
  );

  it.effect("changes a folder without SpecWeave exactly as before", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario, stub } = yield* makeScenario;
        const plain = (yield* Path.Path).join(scenario.root, "plain");
        yield* fs.makeDirectory(plain);
        scenario.repositories.set(plain, "github.com/easychamp/easychamp");
        scenario.repositories.set(stub, "github.com/easychamp/easychamp");
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: plain }),
        );
        expect(check.planning).toBeUndefined();
        expect(check.layout?.kind).toBe("plain");
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({ commandId, projectId, workspaceRoot: plain }),
        );
        expect(changed.project.workspaceRoot).toBe(plain);
      }),
    ),
  );

  it.effect("reports an unchanged folder without updating the project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, stub } = yield* makeScenario;
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({ commandId, projectId, workspaceRoot: stub }),
        );
        expect(changed.project.workspaceRoot).toBe(stub);
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses a file at the path and says it is not a folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario } = yield* makeScenario;
        const file = `${scenario.root}/notes.txt`;
        yield* fs.writeFileString(file, "notes");
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: file }),
        );
        // A file is not a folder the project can use: it reads as missing.
        expect(check).toMatchObject({
          targetExists: false,
          refusal: { reason: "folder_not_directory" },
        });
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: file,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "folder_not_directory" });
        expect(refused.message).toContain("is a file, not a folder");
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses the home folder as a protected folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario } = yield* makeScenario;
        const home = NodeOs.homedir();
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: home }),
        );
        expect(check).toMatchObject({
          targetExists: true,
          refusal: { reason: "folder_protected" },
        });
        // Nothing inside a protected folder is read.
        expect(check.layout).toBeUndefined();
        expect(check.nestedProjects).toBeUndefined();
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: home,
            confirmDifferentRepository: true,
            confirmPlanningImpact: true,
          }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "folder_protected" });
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses when git fails to read either folder instead of reading it as no remote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* makeScenario;
        // Like the umbrella move: the stub is its own repository, so its threads would stay.
        scenario.repositories.set(stub, "github.com/anton-abyzov/specweave");
        scenario.unreadable.add(stub);
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(check).toMatchObject({
          refusal: { reason: "repository_unreadable" },
          keptInPlaceCount: 0,
        });
        expect(check.refusal?.detail).toContain(`repository of ${stub}`);
        expect(check.refusal?.detail).toContain("dubious ownership");
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "repository_unreadable" });
        expect(scenario.dispatched).toEqual([]);
        expect(scenario.updates).toHaveLength(0);

        scenario.unreadable.clear();
        scenario.unreadable.add(parent);
        const target = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(target.refusal?.detail).toContain(`repository of ${parent}`);
      }),
    ),
  );

  it.effect("refuses a folder the project already approves as an extra folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* makeScenario;
        scenario.projects.set(
          projectId,
          projectFixture(projectId, {
            title: "easychamp",
            workspaceRoot: stub,
            workspaceSettings: {
              environment: { additionalFolders: [parent], repositories: [] },
            } as unknown as Project["workspaceSettings"],
          }),
        );
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(check.refusal).toEqual({
          reason: "environment_invalid",
          detail: `${parent} is already one of the project's approved extra folders. Remove it from the approved folders first, then choose it again.`,
        });
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "environment_invalid" });
        expect(scenario.dispatched).toEqual([]);
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("lists projects inside the new folder or holding it, deleted ones too", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent } = yield* makeScenario;
        const api = ProjectId.make("api");
        const umbrella = ProjectId.make("old-umbrella");
        scenario.projects.set(
          api,
          projectFixture(api, { title: "api", workspaceRoot: `${parent}/repositories/api` }),
        );
        // A sibling that only shares the name's prefix is not inside.
        scenario.projects.set(
          ProjectId.make("sibling"),
          projectFixture(ProjectId.make("sibling"), {
            title: "sibling",
            workspaceRoot: `${parent}-archive`,
          }),
        );
        scenario.deletedProjects.push(
          projectFixture(umbrella, { title: "old umbrella", workspaceRoot: scenario.root }),
        );
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(check.nestedProjects).toEqual([
          {
            id: api,
            title: "api",
            workspaceRoot: `${parent}/repositories/api`,
            relation: "inside",
            deleted: false,
          },
          {
            id: umbrella,
            title: "old umbrella",
            workspaceRoot: scenario.root,
            relation: "contains",
            deleted: true,
          },
        ]);
      }),
    ),
  );

  /** The umbrella move: specweave's own checkout keeps its threads when the project moves up. */
  const keepScenario = Effect.gen(function* () {
    const made = yield* makeScenario;
    const { scenario, parent, stub } = made;
    scenario.repositories.set(stub, "github.com/anton-abyzov/specweave");
    scenario.repositories.set(parent, "github.com/anton-abyzov/specweave-umb");
    scenario.projects.set(
      projectId,
      projectFixture(projectId, {
        title: "specweave",
        workspaceRoot: stub,
        workspaceSettings: {
          coordinatorThreadId: ThreadId.make("coordinator"),
        } as Project["workspaceSettings"],
      }),
    );
    return made;
  });
  const keepCommand = (id: string, stub: string) => ({
    type: "thread.metadata.update",
    commandId: CommandId.make(`${commandId}:keep:${id}`),
    threadId: ThreadId.make(id),
    worktreePath: stub,
    expectedWorktreePath: null,
  });
  const undoCommand = (id: string, stub: string) => ({
    type: "thread.metadata.update",
    commandId: CommandId.make(`${commandId}:unkeep:${id}`),
    threadId: ThreadId.make(id),
    worktreePath: null,
    expectedWorktreePath: stub,
  });

  it.effect("undoes the kept threads when the project update fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* keepScenario;
        scenario.threads.push(shell("second"));
        scenario.failUpdate = true;
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "ProjectRequestDeniedError" });
        expect(scenario.dispatched).toEqual([
          keepCommand("worker", stub),
          keepCommand("second", stub),
          undoCommand("worker", stub),
          undoCommand("second", stub),
        ]);
        expect(scenario.projects.get(projectId)?.workspaceRoot).toBe(stub);
      }),
    ),
  );

  it.effect("keeps the kept threads bound when the update committed before failing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* keepScenario;
        scenario.failUpdateAfterCommit = true;
        yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        // The root moved, so undoing would send the worker into the new folder.
        expect(scenario.projects.get(projectId)?.workspaceRoot).toBe(parent);
        expect(scenario.dispatched).toEqual([keepCommand("worker", stub)]);
      }),
    ),
  );

  it.effect("lists a deleted project that used exactly the new folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent } = yield* makeScenario;
        const gone = ProjectId.make("gone");
        scenario.deletedProjects.push(
          projectFixture(gone, { title: "gone", workspaceRoot: parent }),
        );
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(check.conflictingProject).toBeNull();
        expect(check.nestedProjects).toEqual([
          { id: gone, title: "gone", workspaceRoot: parent, relation: "same", deleted: true },
        ]);
      }),
    ),
  );

  it.effect("undoes the binds made so far when a later thread cannot stay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* keepScenario;
        scenario.threads.push(shell("second"), shell("third"));
        scenario.failCommand = (command) =>
          command.type === "thread.metadata.update" &&
          command.commandId === CommandId.make(`${commandId}:keep:second`);
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(refused.message).toContain(`"second" could not stay in ${stub}`);
        expect(scenario.dispatched).toEqual([
          keepCommand("worker", stub),
          undoCommand("worker", stub),
        ]);
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses when a thread appears or starts work while the folder changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* keepScenario;
        let added = false;
        scenario.afterDispatch = () => {
          if (added) return;
          added = true;
          scenario.threads.push(shell("newcomer", { title: "Newcomer" }));
        };
        const appeared = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(appeared).toMatchObject({ reason: "changed_meanwhile" });
        expect(appeared.message).toContain('"Newcomer" was created while the folder was changing');
        expect(scenario.dispatched).toEqual([
          keepCommand("worker", stub),
          undoCommand("worker", stub),
        ]);
        expect(scenario.updates).toHaveLength(0);

        scenario.threads.pop();
        scenario.dispatched.length = 0;
        let started = false;
        scenario.afterDispatch = () => {
          if (started) return;
          started = true;
          scenario.threads[1] = shell("worker", { title: "Worker", status: "queued" });
        };
        const busy = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        ).pipe(Effect.flip);
        expect(busy).toMatchObject({ reason: "changed_meanwhile" });
        expect(busy.message).toContain('"Worker" started work while the folder was changing');
        expect(scenario.dispatched).toEqual([
          keepCommand("worker", stub),
          undoCommand("worker", stub),
        ]);
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("never pins the default coordinator of a project that has not bound one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent, stub } = yield* keepScenario;
        scenario.projects.set(
          projectId,
          projectFixture(projectId, { title: "specweave", workspaceRoot: stub }),
        );
        scenario.threads.splice(0, 1, shell(`project-coordinator:${projectId}`));
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent }),
        );
        expect(check.keptInPlaceCount).toBe(1);
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        );
        expect(changed.keptInPlace).toBe(1);
        expect(scenario.dispatched).toEqual([keepCommand("worker", stub)]);
      }),
    ),
  );

  it.effect("counts queued runs, held messages and waiting runs as active work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario, parent } = yield* makeScenario;
        const approvalRequestId = RuntimeRequestId.make("project-action:card");
        scenario.threads.splice(
          0,
          scenario.threads.length,
          shell("queued", { status: "queued" }),
          shell("held", { status: "completed", heldQueuedCount: 2 }),
          shell("waiting", { status: "waiting" }),
          shell("idle", { status: "completed" }),
          // The thread that asked waits on this change itself.
          shell("asking", {
            status: "waiting",
            activityRunStatus: "waiting",
            pendingRuntimeRequest: {
              id: approvalRequestId,
              kind: "user_input",
              createdAt: "2026-10-15T00:00:00Z",
            } as unknown as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
          }),
        );
        const check = yield* withFolders(scenario, (folders) =>
          folders.check({ projectId, workspaceRoot: parent, approvalRequestId }),
        );
        expect(check.activeThreads.map((thread) => thread.id)).toEqual([
          "queued",
          "held",
          "waiting",
        ]);
        const refused = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
            approvalRequestId,
          }),
        ).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "active_work" });
        expect(scenario.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("leaves the session of a thread whose checkout could not be rebound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario, parent, stub } = yield* makeScenario;
        const boundOld = `${stub}/.worktrees/fix`;
        yield* fs.makeDirectory(boundOld, { recursive: true });
        yield* fs.makeDirectory(`${parent}/.worktrees/fix`, { recursive: true });
        scenario.threads.push(shell("bound", { worktreePath: boundOld }));
        scenario.claudeSessions.set(ThreadId.make("bound"), {
          sessionId: "4f1c2a9e-7b3d-4e2f-8a61-0c9d8e7f6a5b",
          cwd: boundOld,
        });
        scenario.failCommand = (command) =>
          command.type === "thread.metadata.update" && command.threadId === ThreadId.make("bound");
        const changed = yield* withFolders(scenario, (folders) =>
          folders.change({
            commandId,
            projectId,
            workspaceRoot: parent,
            confirmDifferentRepository: true,
          }),
        );
        expect(changed.project.workspaceRoot).toBe(parent);
        expect(changed.reboundWorktrees).toBe(0);
        // Its agent keeps running in the checkout it is still bound to.
        expect(scenario.released).not.toContain("session-bound");
      }),
    ),
  );
});

it("explains each refusal in the user's terms", () => {
  const base = {
    projectId,
    currentRoot: "/a",
    targetRoot: "/b",
    unchanged: false,
    targetExists: true,
    currentRepository: "github.com/x/a",
    targetRepository: "github.com/x/b",
    sameRepository: false,
    conflictingProject: null,
    activeThreads: [],
    threadCount: 3,
    reboundWorktreeCount: 0,
    keptInPlaceCount: 0,
    specweaveWorkspace: false,
  };
  expect(ProjectFolderChange.folderChangeRefusal(base, true)).toBeNull();
  expect(ProjectFolderChange.folderChangeRefusal(base, false)?.detail).toBe(
    "/b is a checkout of github.com/x/b, and the current folder is a checkout of github.com/x/a. Confirm that this is the right folder to use it.",
  );
  expect(
    ProjectFolderChange.folderChangeRefusal({ ...base, targetExists: false }, true)?.reason,
  ).toBe("folder_missing");
  const planning = {
    ...base,
    planning: {
      currentRoot: "/umb",
      currentIncrements: 12,
      targetRoot: null,
      targetIncrements: 0,
      brokenLinks: ["0007-auth"],
      changes: true,
    },
  };
  expect(ProjectFolderChange.folderChangeRefusal(planning, true)?.detail).toBe(
    'Plan cards read 12 increments in /umb now and would read none after the change. 1 thread link to 0007-auth would show "not found". Nothing is deleted or rewritten: changing the folder back to /a restores them. Confirm the planning change to use /b.',
  );
  expect(ProjectFolderChange.folderChangeRefusal(planning, true, true)).toBeNull();
  expect(
    ProjectFolderChange.folderChangeRefusal(
      { ...planning, planning: { ...planning.planning, changes: false } },
      true,
    ),
  ).toBeNull();
});
