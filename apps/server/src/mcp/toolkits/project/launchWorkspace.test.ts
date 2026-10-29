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
import { holdsSeparateClones, launchWorkspaceDefault } from "./launchWorkspace.ts";
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

    // An umbrella folder keeps its threads in the folder and says why.
    settings = withProjectMode("worktree");
    workspaceRoot = makeFolder({ "repositories/acme/api/.git": "dir" });
    const umbrella = yield* handle(base);
    expect(launched[3]?.workspaceStrategy).toEqual({ type: "root" });
    expect(umbrella.at(-1)?.result).toMatchObject({
      workspaceNotice: expect.stringContaining("holds separate clones"),
    });
    expect(statusReads).toHaveLength(1);
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
