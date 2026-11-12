// @effect-diagnostics nodeBuiltinImport:off - temporary folders stand in for both machines.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FolderCopyError,
  type FolderCopyOffer,
  type FolderCopySourceStatus,
  type FolderCopyStatus,
  type LogicalProjectMember,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectLink from "../../project/ProjectLink.ts";
import * as WorkspaceSensitivePaths from "../../workspace/WorkspaceSensitivePaths.ts";
import { TeamRules, teamRulesOf } from "../../teamRules/TeamRules.ts";
import * as MachineHandoff from "../MachineHandoff.ts";
import {
  AGENT_COPY_SELECTION,
  type AgentCopyReceiveInput,
  listRebuildableFolders,
  receiveAgentCopy,
  runAgentCopy,
} from "./agentCopy.ts";

const SOURCE = EnvironmentId.make("env-m4");
const M1 = { label: "M1", environmentId: EnvironmentId.make("env-m1") };
const projectId = ProjectId.make("project");
const copyId = ProjectId.make("copy-on-m1");
const kept: LogicalProjectMember = {
  environmentId: SOURCE,
  projectId,
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
};

const summary = {
  totals: {
    repository: { files: 0, bytes: 0 },
    tracked: { files: 0, bytes: 0 },
    untracked: { files: 4, bytes: 400 },
    ignoredData: { files: 0, bytes: 0 },
    rebuildable: { files: 3, bytes: 30 },
    secret: { files: 1, bytes: 10 },
  },
  repositories: [],
  secretFiles: [
    { path: ".env", size: 10 },
    { path: "~/.config/widgets/token.json", size: 5 },
  ],
  linksOutside: 0,
  warnings: [],
  skipped: { rebuildableFolders: 2, worktrees: [] },
};

interface World {
  readonly source: Array<string>;
  readonly destination: Array<string>;
  readonly link: Array<{ readonly step: string; readonly options?: unknown }>;
  started?: { readonly targetFolder: string; readonly selection: ReadonlyArray<string> };
}

/** The destination's own config, for the folders it never copies into. */
const config = ServerConfig.layerTest(process.cwd(), { prefix: "agent-copy-config-" }).pipe(
  Layer.provide(NodeServices.layer),
  Layer.orDie,
);

const setup = (options: {
  readonly workspaceRoot: string;
  /** Something appeared in the destination folder after the check. */
  readonly dirtyPreview?: boolean;
  readonly diskFull?: boolean;
  readonly teamRulesHold?: "source" | "destination";
  /** That machine runs a version without the receiving tool. */
  readonly olderDestination?: boolean;
  /** The copy applies there but registers no project. */
  readonly unregistered?: boolean;
  /** The destination's home, for its protected folders. */
  readonly homeDir?: string;
}) => {
  const world: World = { source: [], destination: [], link: [] };
  let state: FolderCopyStatus["state"] = "planned";
  const sourceStatus = (scanning: boolean): FolderCopySourceStatus => ({
    operationId: "op",
    projectId,
    mode: "copy-only",
    state: scanning ? "scanning" : "scanned",
    summary: scanning ? null : summary,
    error: null,
    releaseReason: null,
  });
  let scans = 0;
  const source = Layer.mock(MachineHandoff.MachineHandoff)({
    copyOffer: (input) => {
      world.source.push("offer");
      return Effect.succeed({
        operationId: input.operationId,
        sourceEnvironmentId: SOURCE,
        sourceProjectId: projectId,
        sourceUrl: "https://m4.example.test",
        sourceMachine: "M4",
        token: "token",
        title: "Widgets",
        mode: "copy-only",
        status: { ...sourceStatus(true), operationId: input.operationId },
      } as FolderCopyOffer);
    },
    copySourceStatus: (input) => {
      world.source.push("source-status");
      scans += 1;
      return Effect.succeed({ ...sourceStatus(scans < 2), operationId: input.operationId });
    },
    copySourceCancel: (input) => {
      world.source.push(`cancel:${input.reason}`);
      return Effect.succeed(sourceStatus(false));
    },
  });
  const status = (operationId: string, targetFolder: string): FolderCopyStatus => ({
    operationId,
    sourceEnvironmentId: SOURCE,
    sourceProjectId: projectId,
    sourceMachine: "M4",
    mode: "copy-only",
    targetFolder,
    projectFolder: targetFolder,
    title: "Widgets",
    selection: [...AGENT_COPY_SELECTION],
    mirror: false,
    state,
    failedStep: null,
    error: null,
    progress: null,
    disk: null,
    rows:
      options.dirtyPreview && state === "previewed"
        ? [
            {
              id: "files:.",
              kind: "files",
              path: ".",
              status: "conflict",
              detail: "",
              filesToMove: 1,
              bytesToMove: 1,
              bytesPresent: 1,
              choices: ["keep-mine", "take-theirs"],
              decision: null,
              needsDecision: true,
              conflicts: [],
              moreConflicts: 0,
              cloneAvailable: false,
              clone: false,
            },
          ]
        : [],
    totals: null,
    checks: [],
    warnings: [],
    unstable: [],
    committed: state === "applied",
    projectId: state === "applied" && !options.unregistered ? copyId : null,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
  });
  let target = "";
  const destination = Layer.mock(MachineHandoff.MachineHandoff)({
    copyStart: (input) => {
      world.destination.push("start");
      world.started = { targetFolder: input.targetFolder, selection: input.selection ?? [] };
      target = input.targetFolder;
      return Effect.succeed(status(input.operationId, target));
    },
    copyStatus: (input) => {
      world.destination.push("status");
      if (state === "planned") state = "previewed";
      else if (state === "approved") state = "applied";
      return Effect.succeed(status(input.operationId, target));
    },
    copyApprove: (input) => {
      world.destination.push("approve");
      if (options.diskFull)
        return Effect.fail(new FolderCopyError({ code: "disk_space", detail: "It needs 2 GB." }));
      state = "approved";
      return Effect.succeed(status(input.operationId, target));
    },
    copyCancel: (input) => {
      world.destination.push("cancel");
      state = "cancelled";
      return Effect.succeed(status(input.operationId, target));
    },
  });
  const link = Layer.mock(ProjectLink.ProjectLink)({
    prepare: (input) => {
      world.link.push({ step: "prepare" });
      return Effect.succeed({
        operationId: input.operationId,
        kept,
        logicalProject: {
          id: "logical:widgets",
          title: "Widgets",
          coordinatorId: "coordinator:logical:widgets",
          members: [kept],
        },
        coordinatorBinding: { epoch: 0, state: "active" as const },
        fingerprint: {
          root: "folder" as const,
          repositories: [],
          skippedLinks: 0,
          truncated: false,
        },
        adopted: false,
      });
    },
    accept: (input, acceptOptions) => {
      world.link.push({ step: "accept", options: acceptOptions });
      const member = {
        environmentId: M1.environmentId,
        projectId: input.projectId,
        coordinatorThreadId: ThreadId.make(`project-coordinator:${input.projectId}`),
      };
      return Effect.succeed({
        operationId: input.operationId,
        member,
        logicalProject: { ...input.logicalProject, members: [kept, member] },
        coordinatorBinding: {
          epoch: 0,
          state: "transferred" as const,
          operationId: input.operationId,
          successor: kept,
        },
        replayed: false,
      });
    },
    commit: (input) => {
      world.link.push({ step: "commit" });
      return Effect.succeed({
        operationId: input.operationId,
        logicalProject: {
          id: "logical:widgets",
          title: "Widgets",
          coordinatorId: "coordinator:logical:widgets",
          members: [kept, input.joining],
        },
        notesWritten: 0,
        replayed: false,
      });
    },
  });
  const rules = (side: "source" | "destination") =>
    teamRulesOf(
      options.teamRulesHold === side
        ? { status: "hold", issues: ["Unreadable rules"] }
        : { status: "none" },
    );
  const receive = (args: AgentCopyReceiveInput) =>
    options.olderDestination
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "machine_unsupported",
            message: "M1 needs a newer SpecWithCode for this.",
          }),
        )
      : receiveAgentCopy(args, { environmentId: SOURCE }).pipe(
          Effect.provide(Layer.mergeAll(destination, link, NodeServices.layer, config)),
          Effect.provideService(TeamRules, rules("destination")),
          Effect.provideService(
            WorkspaceSensitivePaths.SensitivePathsHomeDirectory,
            options.homeDir ?? NodeOS.homedir(),
          ),
        );
  const run = (targetFolder: string) =>
    runAgentCopy({
      projectId,
      workspaceRoot: options.workspaceRoot,
      machine: M1,
      targetFolder,
      receive,
      pollMs: 1,
    }).pipe(
      Effect.provide(Layer.mergeAll(source, link)),
      Effect.provideService(TeamRules, rules("source")),
    );
  return { world, run };
};

const tempFolder = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-copy-"))),
  (folder) => Effect.promise(() => NodeFSP.rm(folder, { recursive: true, force: true })),
);

/** A plain folder with build output, dependencies and a secret. */
const plainFolder = Effect.gen(function* () {
  const root = yield* tempFolder;
  for (const folder of [
    "src/out",
    "dist",
    "node_modules/left-pad",
    "tools/bin",
    "vendor/build/.git",
  ])
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, folder), { recursive: true }));
  yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, ".env"), "TOKEN=x\n"));
  return root;
});

describe("agent folder copy", () => {
  it.live("copies a plain folder, links it, and lists what stayed behind", () =>
    Effect.gen(function* () {
      const root = yield* plainFolder;
      const there = NodePath.join(yield* tempFolder, "widgets");
      const { world, run } = setup({ workspaceRoot: root });
      const result = yield* run(there);
      expect(result).toEqual({
        projectId: copyId,
        workspaceRoot: there,
        linked: true,
        leftOut: {
          files: 5,
          secretFiles: [".env", "~/.config/widgets/token.json"],
          rebuildableFolders: 2,
          rebuildableFolderPaths: ["dist", "node_modules", "src/out", "tools/bin"],
        },
      });
      // Every class but secrets and rebuildable folders, into the folder checked empty.
      expect(world.started).toEqual({
        targetFolder: there,
        selection: ["repository", "tracked", "untracked", "ignoredData"],
      });
      expect(world.destination).toEqual(["start", "status", "approve", "status", "status"]);
      expect(world.link).toEqual([
        { step: "prepare" },
        { step: "accept", options: { copiedFromKept: true } },
        { step: "commit" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("accepts an empty folder that already exists", () =>
    Effect.gen(function* () {
      const there = yield* tempFolder;
      const { run } = setup({ workspaceRoot: yield* plainFolder });
      expect((yield* run(there)).linked).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a folder that is not empty there and writes nothing", () =>
    Effect.gen(function* () {
      const there = yield* tempFolder;
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(there, "notes.md"), "mine"));
      const { world, run } = setup({ workspaceRoot: yield* plainFolder });
      const error = yield* Effect.flip(run(there));
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(error.message).toContain("is not empty");
      expect(world.source).toEqual([]);
      expect(world.destination).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a relative folder or one with .. in it, and writes nothing", () =>
    Effect.gen(function* () {
      const root = yield* tempFolder;
      for (const there of [
        "widgets",
        "../widgets",
        `${root}${NodePath.sep}a${NodePath.sep}..${NodePath.sep}widgets`,
      ]) {
        const { world, run } = setup({ workspaceRoot: yield* plainFolder });
        const error = yield* Effect.flip(run(there));
        expect(error).toMatchObject({ code: "invalid_request" });
        expect(world.source).toEqual([]);
        expect(world.destination).toEqual([]);
      }
      expect(yield* Effect.promise(() => NodeFSP.readdir(root))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a protected folder such as ~/.ssh there, even through a link", () =>
    Effect.gen(function* () {
      const home = yield* tempFolder;
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(home, ".ssh")));
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(home, ".ssh"), NodePath.join(home, "keys")),
      );
      for (const there of [
        NodePath.join(home, ".ssh", "widgets"),
        NodePath.join(home, "keys", "w"),
      ]) {
        const { world, run } = setup({ workspaceRoot: yield* plainFolder, homeDir: home });
        const error = yield* Effect.flip(run(there));
        expect(error).toMatchObject({ code: "invalid_request" });
        expect(error.message).toContain("does not copy folders into");
        expect(world.source).toEqual([]);
        expect(world.destination).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.live("says a copy that applied without registering a project finished unregistered", () =>
    Effect.gen(function* () {
      const there = NodePath.join(yield* tempFolder, "widgets");
      const { world, run } = setup({ workspaceRoot: yield* plainFolder, unregistered: true });
      const error = yield* Effect.flip(run(there));
      expect(error.message).toContain("finished but was not registered");
      expect(error.message).toContain(there);
      expect(world.link).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses when the folder there changed before Apply, and withdraws the offer", () =>
    Effect.gen(function* () {
      const there = NodePath.join(yield* tempFolder, "widgets");
      const { world, run } = setup({ workspaceRoot: yield* plainFolder, dirtyPreview: true });
      const error = yield* Effect.flip(run(there));
      expect(error.message).toContain("nothing was copied");
      expect(world.destination).toEqual(["start", "status", "cancel"]);
      expect(world.source.at(-1)).toBe("cancel:The copy did not finish.");
      expect(world.link).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("reports a refused Apply such as disk space, and withdraws the offer", () =>
    Effect.gen(function* () {
      const there = NodePath.join(yield* tempFolder, "widgets");
      const { world, run } = setup({ workspaceRoot: yield* plainFolder, diskFull: true });
      const error = yield* Effect.flip(run(there));
      expect(error.message).toContain("It needs 2 GB.");
      expect(world.source.at(-1)).toBe("cancel:The copy did not finish.");
    }).pipe(Effect.scoped),
  );

  it.live("tells the agent to update SpecWithCode on a machine without the receiving step", () =>
    Effect.gen(function* () {
      const { world, run } = setup({ workspaceRoot: yield* plainFolder, olderDestination: true });
      const error = yield* Effect.flip(run("~/widgets"));
      expect(error.code).toBe("machine_unsupported");
      expect(error.message).toContain("Update SpecWithCode on M1");
      expect(error.message).toContain("nothing was copied");
      expect(world.source).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses when team rules stop machines working together, on either side", () =>
    Effect.gen(function* () {
      const there = NodePath.join(yield* tempFolder, "widgets");
      for (const side of ["source", "destination"] as const) {
        const { world, run } = setup({ workspaceRoot: yield* plainFolder, teamRulesHold: side });
        const error = yield* Effect.flip(run(there));
        expect(error.code).toBe("capability_denied");
        expect(error.message).toContain("Folder copy is off");
        expect(world.source).toEqual([]);
        expect(world.destination).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.live("starts only a copy offered by the calling machine, links only its own project", () =>
    Effect.gen(function* () {
      const there = NodePath.join(yield* tempFolder, "widgets");
      const layer = Layer.mergeAll(
        Layer.mock(MachineHandoff.MachineHandoff)({}),
        Layer.mock(ProjectLink.ProjectLink)({}),
        NodeServices.layer,
        config,
      );
      const refused = yield* Effect.flip(
        receiveAgentCopy(
          {
            action: "start",
            start: {
              operationId: "0b0e9c4e-5d6f-4a1b-8c2d-3e4f5a6b7c8d",
              sourceEnvironmentId: EnvironmentId.make("env-m3"),
              sourceProjectId: projectId,
              sourceUrl: "https://m3.example.test",
              sourceMachine: "M3",
              token: "token",
              title: "Widgets",
              mode: "copy-only",
              targetFolder: there,
            },
          },
          { environmentId: SOURCE },
        ).pipe(Effect.provide(layer)),
      );
      expect(refused.message).toContain("Only the machine that offers a folder");
    }).pipe(Effect.scoped),
  );

  it.live("names rebuildable folders as the scan collapses them, skipping repositories", () =>
    Effect.gen(function* () {
      const root = yield* plainFolder;
      expect(yield* Effect.promise(() => listRebuildableFolders(root))).toEqual([
        "dist",
        "node_modules",
        "src/out",
        "tools/bin",
      ]);
    }).pipe(Effect.scoped),
  );
});
