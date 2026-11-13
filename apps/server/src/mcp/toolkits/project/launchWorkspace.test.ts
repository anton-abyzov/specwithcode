// @effect-diagnostics nodeBuiltinImport:off - Umbrella and submodule fixtures on disk.
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import { afterAll, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettings as ServerSettingsValue,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import {
  emptyThreadFolderLaunch,
  holdsSeparateClones,
  launchWorkspaceDefault,
} from "./launchWorkspace.ts";
import { ProjectToolkit } from "./tools.ts";

const projectId = ProjectId.make("project");

const withProjectMode = (
  mode: "worktree" | "local" | null,
  patch: Partial<ServerSettingsValue> = {},
): ServerSettingsValue => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...patch,
  projectSettingsFolded: true,
  projectSettingsOverrides: mode === null ? {} : { [projectId]: { defaultThreadEnvMode: mode } },
});

it("only the project's own Use worktrees choice gives a launch a worktree", () => {
  const resolve = (settings: ServerSettingsValue) => resolveProjectSettings(settings, projectId);
  expect(
    launchWorkspaceDefault({
      resolved: resolve(withProjectMode("worktree")),
      currentBranch: "main",
    }),
  ).toEqual({ type: "worktree", baseRef: "main", startFromOrigin: true });
  expect(
    launchWorkspaceDefault({
      resolved: resolve(withProjectMode("worktree", { newWorktreesStartFromOrigin: false })),
      currentBranch: "develop",
    }),
  ).toEqual({ type: "worktree", baseRef: "develop", startFromOrigin: false });
  // Off, unset, an environment-wide worktree default, or no branch: the project root.
  expect(
    launchWorkspaceDefault({ resolved: resolve(withProjectMode("local")), currentBranch: "main" }),
  ).toEqual({ type: "root" });
  expect(
    launchWorkspaceDefault({ resolved: resolve(withProjectMode(null)), currentBranch: "main" }),
  ).toEqual({ type: "root" });
  expect(
    launchWorkspaceDefault({
      resolved: resolve(withProjectMode(null, { defaultThreadEnvMode: "worktree" })),
      currentBranch: "main",
    }),
  ).toEqual({ type: "root" });
  expect(
    launchWorkspaceDefault({ resolved: resolve(withProjectMode("worktree")), currentBranch: null }),
  ).toEqual({ type: "root" });
});

it.effect("a coordinator's launch follows the project's Use worktrees switch", () =>
  Effect.gen(function* () {
    const coordinatorId = ThreadId.make("coordinator");
    const instanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId, model: "gpt-5" };
    const caller = {
      id: coordinatorId,
      projectId,
      title: "Coordinator",
      branch: null,
      worktreePath: null,
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as unknown as OrchestrationV2ThreadShell;
    let settings = withProjectMode("worktree");
    let workspaceRoot = "/repo";
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const statusReads: string[] = [];
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: coordinatorId,
          providerSessionId: "session",
          providerInstanceId: instanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: { thread: { id: input.threadId, projectId, modelSelection }, runs: [] },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            Option.some(
              projectFixture(id, {
                workspaceRoot,
                workspaceSettings: {
                  ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                  coordinatorThreadId: coordinatorId,
                },
              }),
            ),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => settings),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetailsLocal: (cwd) => {
          statusReads.push(cwd);
          return Effect.succeed({
            isRepo: true,
            branch: "feature/base",
          } as GitVcsDriver.GitStatusDetails);
        },
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-launch-workspace-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"studio_thread_launch">>[1]) =>
      toolkit
        .handle("studio_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const base = { title: "Fix", message: "Fix it", modelSelection, increment: "new" } as const;

    yield* handle(base);
    expect(launched[0]?.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "feature/base",
      startFromOrigin: true,
    });
    expect(statusReads).toEqual(["/repo"]);

    // An explicit strategy wins over the switch.
    yield* handle({ ...base, workspaceStrategy: { type: "root" } });
    expect(launched[1]?.workspaceStrategy).toEqual({ type: "root" });

    // With the switch off the thread starts in the project root without reading git.
    settings = withProjectMode("local");
    yield* handle(base);
    expect(launched[2]?.workspaceStrategy).toEqual({ type: "root" });
    expect(statusReads).toHaveLength(1);

    // A folder of separate clones: the thread starts in its own folder with no repository yet.
    settings = withProjectMode("worktree");
    workspaceRoot = makeFolder({ "repositories/acme/api/.git": "dir" });
    const umbrella = yield* handle(base);
    expect(launched[3]?.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "HEAD",
      startFromOrigin: true,
      repositories: [],
    });
    expect(umbrella.at(-1)?.result).toMatchObject({
      workspaceNotice: expect.stringContaining("its own folder on its own branch"),
    });
    expect(statusReads).toHaveLength(1);
    // An explicit root still wins there.
    yield* handle({ ...base, workspaceStrategy: { type: "root" } });
    expect(launched.pop()?.workspaceStrategy).toEqual({ type: "root" });

    // An increment that changes the umbrella's child gets a worktree set of it.
    const incrementFolder = NodePath.join(workspaceRoot, ".specweave/increments/0007-multi");
    NodeFS.mkdirSync(incrementFolder, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(incrementFolder, "metadata.json"),
      JSON.stringify({
        id: "0007-multi",
        status: "active",
        repositories: ["repositories/acme/api"],
      }),
    );
    NodeFS.writeFileSync(NodePath.join(incrementFolder, "spec.md"), "# Multi\n");
    const set = yield* handle({ ...base, increment: "0007" });
    expect(launched[4]?.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "feature/base",
      startFromOrigin: true,
      repositories: ["repositories/acme/api"],
    });
    expect(set.at(-1)?.result).toMatchObject({
      workspaceNotice: expect.stringContaining("one folder with a worktree of each"),
    });
    expect(launched[4]?.initialMessage?.text).toContain("SpecWeave planning stays");

    // With task files and no declaration, their owners make the set.
    NodeFS.writeFileSync(
      NodePath.join(incrementFolder, "metadata.json"),
      JSON.stringify({ id: "0007-multi", status: "active" }),
    );
    NodeFS.writeFileSync(
      NodePath.join(incrementFolder, "spec.md"),
      "# Multi\n\n### T-01 One\n- AC: AC-01 | Files: repositories/acme/api/src/a.ts | Test: x\n",
    );
    yield* handle({ ...base, increment: "0007" });
    expect(launched[5]?.workspaceStrategy).toMatchObject({
      repositories: ["repositories/acme/api"],
    });

    // Use worktrees off: the same launch stays in the project folder.
    settings = withProjectMode("local");
    yield* handle({ ...base, increment: "0007" });
    expect(launched[6]?.workspaceStrategy).toEqual({ type: "root" });
  }),
);

const folders: string[] = [];
function makeFolder(entries: Record<string, "dir" | "file">): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launch-workspace-"));
  folders.push(root);
  for (const [path, kind] of Object.entries(entries)) {
    const full = NodePath.join(root, path);
    if (kind === "dir") NodeFS.mkdirSync(full, { recursive: true });
    else {
      NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
      NodeFS.writeFileSync(full, "gitdir: elsewhere\n");
    }
  }
  return root;
}
afterAll(() => {
  for (const folder of folders) NodeFS.rmSync(folder, { recursive: true, force: true });
});

it("counts separate clones but not submodules or worktrees", async () => {
  expect(await holdsSeparateClones(makeFolder({ ".git": "dir", "src/index.ts": "file" }))).toBe(
    false,
  );
  expect(
    await holdsSeparateClones(
      makeFolder({ ".git": "dir", ".gitmodules": "file", "vendor-lib/.git": "file" }),
    ),
  ).toBe(false);
  expect(
    await holdsSeparateClones(
      makeFolder({
        ".git": "dir",
        "repositories/acme/api/.git": "dir",
        "repositories/acme/web/.git": "dir",
      }),
    ),
  ).toBe(true);
  expect(await holdsSeparateClones("/does/not/exist")).toBe(false);
});

it("gives an empty thread folder only to a folder of separate clones", async () => {
  const umbrella = makeFolder({ ".git": "dir", "repositories/acme/api/.git": "dir" });
  const single = makeFolder({ ".git": "dir" });
  const worktree = { type: "worktree", baseRef: "main" } as const;
  const project = (workspaceRoot: string) => ({ id: workspaceRoot, workspaceRoot });
  const empty = await emptyThreadFolderLaunch(worktree, project(umbrella));
  expect(empty.workspaceStrategy).toEqual({ ...worktree, repositories: [] });
  expect(empty.notice).toContain("studio_worktree_add_repository");
  expect(empty.notice).toContain("Do not edit or commit in the project folder's clones");
  expect(empty.notice).toContain("- api: repositories/acme/api (no remote, no branch checked out)");
  expect(empty.notice).toContain(umbrella);
  // One repository with no clones inside keeps its single worktree, even with an empty list.
  expect(await emptyThreadFolderLaunch({ ...worktree, repositories: [] }, project(single))).toEqual(
    { workspaceStrategy: worktree, notice: null },
  );
  // A named repository, a named set and root are left as they came.
  for (const strategy of [
    { ...worktree, repository: "repositories/acme/api" },
    { ...worktree, repositories: ["."] },
    { type: "root" },
  ] as const)
    expect(await emptyThreadFolderLaunch(strategy, project(umbrella))).toEqual({
      workspaceStrategy: strategy,
      notice: null,
    });
});

/** An umbrella whose clones under `committed` are real repositories with one commit. */
function makeUmbrella(committed: ReadonlyArray<string>, fresh: ReadonlyArray<string> = []): string {
  const root = makeFolder({
    ".git": "dir",
    ...Object.fromEntries(fresh.map((path) => [`${path}/.git`, "dir" as const])),
  });
  for (const path of committed) {
    const folder = NodePath.join(root, path);
    NodeFS.mkdirSync(folder, { recursive: true });
    const git = (...args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { stdio: "ignore" },
      );
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
  }
  return root;
}

it("starts with the repositories the task names by path, and says why", async () => {
  const umbrella = makeUmbrella(
    ["repositories/acme/api", "repositories/acme/api-dev", "repositories/acme/web"],
    ["repositories/acme/fresh"],
  );
  const worktree = { type: "worktree", baseRef: "main" } as const;
  const project = { id: umbrella, workspaceRoot: umbrella };
  const named = await emptyThreadFolderLaunch(
    worktree,
    project,
    "Fix repositories/acme/api/src/a.ts. SpecWithCode and web need nothing.",
  );
  expect(named.workspaceStrategy).toEqual({ ...worktree, repositories: ["repositories/acme/api"] });
  expect(named.notice).toContain(
    "It starts with a worktree of api (repositories/acme/api), because its task names repositories/acme/api/src/a.ts.",
  );
  expect(named.notice).toContain("Before changing any other repository, add it");
  // A path written on another machine, and a name in backticks.
  const remote = await emptyThreadFolderLaunch(
    worktree,
    project,
    "See /home/other/umb/repositories/acme/web/x.ts and `api-dev`",
  );
  expect(remote.workspaceStrategy).toEqual({
    ...worktree,
    repositories: ["repositories/acme/web", "repositories/acme/api-dev"],
  });
  expect(remote.notice).toContain(
    "web (repositories/acme/web, named as /home/other/umb/repositories/acme/web/x.ts)",
  );
  // A repository this machine has not cloned is not picked and does not fail the launch.
  const missing = await emptyThreadFolderLaunch(
    worktree,
    project,
    "Fix repositories/acme/billing/a.ts",
  );
  expect(missing.workspaceStrategy).toEqual({ ...worktree, repositories: [] });
  expect(missing.notice).toContain("with no repository yet");
  // A clone with no commit cannot give a worktree: it is named in the notice, not picked.
  const fresh = await emptyThreadFolderLaunch(
    worktree,
    project,
    "Fix repositories/acme/fresh/a.ts and repositories/acme/web/b.ts",
  );
  expect(fresh.workspaceStrategy).toEqual({ ...worktree, repositories: ["repositories/acme/web"] });
  expect(fresh.notice).toContain(
    "Its task also names fresh, which has no commit to start a worktree from, so it was not added.",
  );
});

it("treats more than four named repositories as a list and starts with none", async () => {
  const names = ["a", "b", "c", "d", "e"];
  const umbrella = makeFolder({
    ".git": "dir",
    ...Object.fromEntries(names.map((name) => [`repositories/acme/${name}/.git`, "dir" as const])),
  });
  const launch = await emptyThreadFolderLaunch(
    { type: "worktree", baseRef: "main" },
    { id: umbrella, workspaceRoot: umbrella },
    names.map((name) => `- repositories/acme/${name}`).join("\n"),
  );
  expect(launch.workspaceStrategy).toEqual({ type: "worktree", baseRef: "main", repositories: [] });
  expect(launch.notice).toContain(
    "its task names 5 repositories (a, b and 3 more), which reads as a list",
  );
});
