import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  SourceControlRepositoryError,
  type SourceControlPublishRepositoryInput,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import * as ServerConfig from "../../../config.ts";
import { nodePath as NodePath } from "../../../nodePath.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const callerId = ThreadId.make("coordinator");
const providerInstanceId = ProviderInstanceId.make("codex");
const createdId = ProjectId.make("created");
const registeredId = ProjectId.make("registered");

type NamedInput = Parameters<
  ManagedProjectFolders.ManagedProjectFolders["Service"]["createNamedProject"]
>[0];

const setup = (
  options: {
    readonly existingFolder?: boolean;
    readonly folderFails?: ManagedProjectFolders.NamedProjectFolderError;
    readonly publishFails?: SourceControlRepositoryError;
    readonly commitError?: string;
  } = {},
) => {
  const named: NamedInput[] = [];
  const published: SourceControlPublishRepositoryInput[] = [];
  const caller = {
    id: callerId,
    projectId: ProjectId.make("project"),
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
  const created = projectFixture(createdId, {
    title: "Pinball Stats",
    workspaceRoot: "/home/example/Projects/pinball-stats-2",
  });
  const registered = projectFixture(registeredId, {
    title: "Already Here",
    workspaceRoot: "/work/already",
  });
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread: { threadId: callerId, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(Project.ProjectService)({
      create: (input) =>
        input.workspaceRoot === registered.workspaceRoot
          ? Effect.fail(
              new Project.ProjectConflictError({
                projectId: input.projectId,
                workspaceRoot: input.workspaceRoot,
                conflictingProjectId: registeredId,
              }),
            )
          : Effect.succeed({ ...created, id: input.projectId, workspaceRoot: input.workspaceRoot }),
      getById: (id) =>
        Effect.succeed(
          id === createdId
            ? Option.some(created)
            : id === registeredId
              ? Option.some(registered)
              : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/app/projects",
      suggestedProjectsRoot: "/home/example/Projects",
      createNamedProject: (input) => {
        named.push(input);
        if (options.folderFails !== undefined) return Effect.fail(options.folderFails);
        return Effect.succeed({
          projectId: createdId,
          workspaceRoot: created.workspaceRoot,
          ...(options.existingFolder ? { existing: true } : {}),
          ...(options.commitError === undefined ? {} : { commitError: options.commitError }),
        });
      },
    }),
    Layer.mock(Repositories.SourceControlRepositoryService)({
      publishRepository: (input) => {
        published.push(input);
        if (options.publishFails !== undefined) return Effect.fail(options.publishFails);
        return Effect.succeed({
          repository: {
            provider: "github",
            nameWithOwner: input.repository.includes("/")
              ? input.repository
              : `example/${input.repository}`,
            url: "https://github.com/example/pinball-stats-2",
          },
          remoteName: "origin",
          remoteUrl: "git@github.com:example/pinball-stats-2.git",
          branch: "main",
          status: options.commitError === undefined ? "pushed" : "remote_added",
        } as never);
      },
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "studio-project-create-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  const create = (params: Record<string, unknown>) =>
    ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle("studio_project_create", params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies)),
      ),
      Effect.map((results) => results.at(-1)?.result as unknown as Record<string, unknown>),
    );
  return { create, named, published };
};

describe("studio_project_create in a parent folder", () => {
  it.effect(
    "defaults to the projects folder, not the app's storage, and returns the final path",
    () => {
      const { create, named } = setup();
      return Effect.gen(function* () {
        const result = yield* create({ title: "Pinball Stats" });
        expect(named[0]).toEqual({ name: "Pinball Stats", parentPath: "/home/example/Projects" });
        expect(result).toMatchObject({
          id: createdId,
          workspaceRoot: "/home/example/Projects/pinball-stats-2",
        });
        expect(result.existing).toBeUndefined();
        // A personal assistant keeps the app's own folder.
        yield* create({ title: "Percy", kind: "personal" });
        expect(named[1]).toEqual({ name: "Percy", kind: "personal" });
      });
    },
  );

  it.effect("takes an absolute or ~ parent, and refuses a relative one", () => {
    const { create, named } = setup();
    return Effect.gen(function* () {
      yield* create({ title: "Pinball Stats", parentPath: "/srv/code" });
      yield* create({ title: "Pinball Stats", parentPath: "~/Code" });
      // Resolved the way this machine resolves folders (a drive letter on Windows).
      expect(named.map((input) => input.parentPath)).toEqual([
        NodePath.resolve("/srv/code"),
        NodePath.join(NodeOS.homedir(), "Code"),
      ]);
      const relative = yield* create({ title: "Pinball Stats", parentPath: "Code" });
      expect(relative).toMatchObject({ code: "invalid_request" });
      expect(named).toHaveLength(2);
    });
  });

  it.effect("says the parent is missing or refused, with the fix", () => {
    return Effect.gen(function* () {
      const missing = yield* setup({
        folderFails: new ManagedProjectFolders.NamedProjectFolderError({
          folder: "/srv/gone",
          reason: "parent_missing",
          cause: "missing",
        }),
      }).create({ title: "X", parentPath: "/srv/gone" });
      expect(missing).toMatchObject({ code: "invalid_request" });
      expect(String(missing.message)).toContain("'/srv/gone' does not exist");
      expect(String(missing.message)).toContain("Pass an existing folder as parentPath");
      const refused = yield* setup({
        folderFails: new ManagedProjectFolders.NamedProjectFolderError({
          folder: "/home/example/.ssh",
          reason: "refused",
          cause: "refused",
        }),
      }).create({ title: "X", parentPath: "/home/example/.ssh" });
      expect(String(refused.message)).toContain("Choose another parentPath");
    });
  });

  it.effect("returns a registered folder's project with existing:true and makes nothing", () => {
    const { create, named } = setup();
    return Effect.gen(function* () {
      const result = yield* create({ title: "Again", workspaceRoot: "/work/already" });
      expect(result).toMatchObject({ id: registeredId, existing: true });
      expect(named).toEqual([]);
    });
  });

  it.effect("passes on a folder used as it is, and never publishes it", () => {
    const { create, published } = setup({ existingFolder: true });
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", github: true });
      expect(result).toMatchObject({ id: createdId, existing: true });
      expect(published).toEqual([]);
    });
  });

  it.effect("refuses options it cannot apply instead of dropping them", () => {
    const { create, named } = setup();
    return Effect.gen(function* () {
      for (const params of [
        { title: "X", workspaceRoot: "/work/x", parentPath: "/srv" },
        { title: "X", workspaceRoot: "/work/x", github: true },
        { title: "X", kind: "personal", github: true },
      ]) {
        expect(yield* create(params)).toMatchObject({ code: "invalid_request" });
      }
      expect(named).toEqual([]);
    });
  });
});

describe("studio_project_create with github", () => {
  it.effect("publishes a private repository after the first commit", () => {
    const { create, published } = setup();
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", github: true });
      expect(published).toEqual([
        {
          cwd: "/home/example/Projects/pinball-stats-2",
          provider: "github",
          repository: "pinball-stats-2",
          visibility: "private",
        },
      ]);
      expect(result).toMatchObject({
        id: createdId,
        published: "published",
        repository: "example/pinball-stats-2",
      });
      yield* create({ title: "Pinball Stats", github: { account: "example-org" } });
      expect(published[1]!.repository).toBe("example-org/pinball-stats-2");
    });
  });

  it.effect("only adds the remote when there is no first commit", () => {
    const { create } = setup({ commitError: "Git has no name or email on this machine." });
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", github: true });
      expect(result).toMatchObject({ published: "remote_added", commitError: expect.any(String) });
    });
  });

  it.effect("keeps the project when publishing fails, and says why", () => {
    const { create } = setup({
      publishFails: new SourceControlRepositoryError({
        provider: "github",
        operation: "publishRepository",
        detail:
          "This machine is not signed in to GitHub. Run gh auth login there, then publish again.",
        publishFailure: "not_signed_in",
      }),
    });
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", github: true });
      expect(result).toMatchObject({
        id: createdId,
        publishFailure: "not_signed_in",
        repository: "pinball-stats-2",
      });
      expect(result.published).toBeUndefined();
      expect(String(result.publishError)).toContain("gh auth login");
      expect(String(result.publishError)).toContain("The project exists");
    });
  });
});
