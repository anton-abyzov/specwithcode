import { expect, it } from "@effect/vitest";
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

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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
            scenario.updates.push(input);
            const project = {
              ...scenario.projects.get(input.projectId)!,
              ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
            };
            scenario.projects.set(input.projectId, project);
            return Effect.succeed(project);
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({ threads: scenario.threads, archivedThreads: [] } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) => {
            if (scenario.failDispatch) return Effect.fail({ _tag: "DispatchFailed" } as never);
            scenario.dispatched.push(command as OrchestrationV2Command);
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
              scenario.repositories.has(folder)
                ? ({ canonicalKey: scenario.repositories.get(folder)! } as never)
                : null,
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
        const { scenario, parent, stub } = yield* makeScenario;
        const moved = `${scenario.root}/moved-checkout`;
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
        const { scenario, parent, stub } = yield* makeScenario;
        yield* fs.makeDirectory(`${stub}/.worktrees/fix`, { recursive: true });
        yield* fs.makeDirectory(`${parent}/.worktrees/fix`, { recursive: true });
        yield* fs.makeDirectory(`${stub}/.worktrees/stale`, { recursive: true });
        scenario.threads.push(
          shell("bound", { worktreePath: `${stub}/.worktrees/fix` }),
          shell("unmatched", { worktreePath: `${stub}/.worktrees/stale` }),
          shell("elsewhere", { worktreePath: `${scenario.root}/other` }),
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
            worktreePath: `${parent}/.worktrees/fix`,
            expectedWorktreePath: `${stub}/.worktrees/fix`,
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
        const elsewhere = `${scenario.root}/elsewhere`;
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

  it.effect("changes a folder without SpecWeave exactly as before", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scenario, stub } = yield* makeScenario;
        const plain = `${scenario.root}/plain`;
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
