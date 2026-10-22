// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Temp project folders for design tests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ThreadId, type DesignActor } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as DesignService from "./DesignService.ts";

export const HERE = EnvironmentId.make("env-here");
export const REMOTE = EnvironmentId.make("env-remote");
export const PROJECT_A = ProjectId.make("project-a");
export const PROJECT_B = ProjectId.make("project-b");
export const SCRATCH = ProjectId.make("project-scratch");
/** This machine's checkout of the logical project whose other member is REMOTE_PROJECT. */
export const LINKED = ProjectId.make("project-linked");
export const REMOTE_PROJECT = ProjectId.make("project-remote");

/** Real-browser export tests run only when this names a chrome-headless-shell. */
export const TEST_BROWSER_ENV = "STUDIO_TEST_HEADLESS_SHELL";

export interface DesignFixture {
  readonly roots: Readonly<Record<string, string>>;
  readonly cleanup: () => void;
}

export const makeDesignFixture = (): DesignFixture => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-design-service-"));
  const roots = Object.fromEntries(
    [PROJECT_A, PROJECT_B, SCRATCH, LINKED].map((id) => {
      const root = NodePath.join(base, id);
      NodeFS.mkdirSync(root, { recursive: true });
      return [id, root];
    }),
  );
  return { roots, cleanup: () => NodeFS.rmSync(base, { recursive: true, force: true }) };
};

const row = (projectId: ProjectId, title: string, workspaceRoot: string, linkedTo?: ProjectId) =>
  ({
    projectId,
    title,
    workspaceRoot,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    workspaceSettings:
      linkedTo === undefined
        ? null
        : {
            logicalProject: {
              id: "logical-web",
              title,
              coordinatorId: "coordinator",
              members: [
                { environmentId: HERE, projectId, coordinatorThreadId: ThreadId.make("c-here") },
                {
                  environmentId: REMOTE,
                  projectId: linkedTo,
                  coordinatorThreadId: ThreadId.make("c-remote"),
                },
              ],
            },
          },
    scripts: [],
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    deletedAt: null,
  }) as unknown as ProjectStore.ProjectRow;

/** Everything `DesignService.layerWithRender` needs, over the fixture's projects. */
export const layerDesignDependencies = (fixture: DesignFixture, executable?: string) => {
  const rows = [
    row(PROJECT_A, "Alpha", fixture.roots[PROJECT_A]!),
    row(PROJECT_B, "Beta", fixture.roots[PROJECT_B]!),
    row(SCRATCH, "Scratch", fixture.roots[SCRATCH]!),
    row(LINKED, "Web", fixture.roots[LINKED]!, REMOTE_PROJECT),
  ];
  return Layer.mergeAll(
    Layer.succeed(
      PreviewBrowser.PreviewBrowser,
      PreviewBrowser.PreviewBrowser.of({
        executable:
          executable === undefined
            ? Effect.die("This test has no preview browser.")
            : Effect.succeed(executable),
        installed: Effect.succeed(Option.fromUndefinedOr(executable)),
      }),
    ),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.succeed(Option.fromUndefinedOr(rows.find((entry) => entry.projectId === projectId))),
      list: () => Effect.succeed(rows),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused",
      isScratch: (projectId) => Effect.succeed(projectId === SCRATCH),
    }),
    Layer.succeed(
      ServerEnvironment.ServerEnvironmentIdentity,
      ServerEnvironment.ServerEnvironmentIdentity.of({ getEnvironmentId: Effect.succeed(HERE) }),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-design-home-" })),
    Layer.provideMerge(NodeServices.layer),
  );
};

export const layerDesignService = (fixture: DesignFixture, executable?: string) =>
  DesignService.layerWithRender.pipe(
    Layer.provideMerge(layerDesignDependencies(fixture, executable)),
  );

export const owner = DesignService.ownerCaller;
export const member: DesignService.DesignCaller = { actor: { kind: "user" }, audience: "members" };
const agentActor = (threadId: string): DesignActor => ({
  kind: "agent",
  threadId: ThreadId.make(threadId),
  provider: "claudeAgent",
  model: "claude-opus-5-5",
});
export const agentIn = (projectId: ProjectId): DesignService.DesignCaller => ({
  actor: agentActor(`thread-${projectId}`),
  audience: "agents",
  scope: { kind: "project", projectId },
});
export const scratchAgent: DesignService.DesignCaller = {
  actor: agentActor("thread-scratch"),
  audience: "agents",
  scope: { kind: "playground" },
};
