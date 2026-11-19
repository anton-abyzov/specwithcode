// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The project sync services as the server runs them: the real scan, the real
 * running-threads query on an in-memory database, and extras sent through the
 * wire messages to the real receiver of another "machine".
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  planProjectSync,
  type Project,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import { ExtrasReceiver, layer as extrasReceiverLayer } from "../handoff/ExtrasReceiver.ts";
import {
  cleanUp,
  commit,
  filesOf,
  git,
  gitHooks,
  isolateGit,
  restoreGit,
  snapshot,
  stagingFolder,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import { HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import { ExtrasNegotiateRequest, ExtrasReplicateMeta } from "../handoff/handoffWire.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSync from "./ProjectSync.ts";
import * as ProjectSyncExtras from "./ProjectSyncExtras.ts";
import { unscopedGrant } from "./workGrantPolicy.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const m4 = EnvironmentId.make("env-m4");
const m5 = EnvironmentId.make("env-m5");
const projectA = ProjectId.make("project-m4");
const projectB = ProjectId.make("project-m5");
const members = [
  { environmentId: m4, projectId: projectA },
  { environmentId: m5, projectId: projectB },
];
const project = (id: ProjectId, workspaceRoot: string, kind?: string) =>
  ({
    id,
    title: "App",
    workspaceRoot,
    workspaceSettings: { ...(kind === undefined ? {} : { kind }), logicalProject: { members } },
  }) as unknown as Project;

const projectsLayer = (projects: ReadonlyArray<Project>) =>
  Layer.mock(ProjectService.ProjectService)({
    snapshot: Effect.succeed({ projects, updatedAt: "2026-11-18T00:00:00.000Z" }),
  });
const machineLayer = (environmentId: EnvironmentId, machineLabel: string) =>
  Layer.mock(HandoffMode)({ environmentId, machineLabel });

/** The sync service of one machine, on the real scan and an in-memory database. */
const syncLayer = (projects: ReadonlyArray<Project>) =>
  ProjectSync.layer.pipe(
    Layer.provide(projectsLayer(projects)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const createdAt = "2026-11-18T00:00:00.000Z";
/** A thread with a run going, working in `worktreePath` or, without one, in its project's folder. */
const runningThread = (input: {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (${input.projectId}, 'App', ${input.workspaceRoot}, '[]', ${createdAt}, ${createdAt})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${input.id}, ${input.projectId}, ${input.title}, 'codex', 'full-access', 'default',
        ${createdAt}, ${createdAt}, ${JSON.stringify({ worktreePath: input.worktreePath })}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (${`run-${input.id}`}, ${input.id}, 1, 'codex', 'running', ${createdAt}, '{}')
    `;
  });

/** Machine A's project with a nested repository and a thread's worktree inside the folder. */
function umbrella() {
  const f = twoMachines();
  commit(f.a, ".gitignore", "ignored.log\nrepositories/\nworktrees/\n");
  git(f.a, "push", "-q", "origin", "main");
  git(f.b, "pull", "-q", "--ff-only");
  const libRemote = NodePath.join(f.base, "lib.git");
  git(f.base, "init", "-q", "--bare", "-b", "main", libRemote);
  const nested = NodePath.join(f.a, "repositories", "lib");
  git(f.base, "clone", "-q", libRemote, nested);
  git(nested, "checkout", "-q", "-b", "main");
  commit(nested, "lib.ts", "export const lib = 1;\n");
  git(nested, "push", "-q", "-u", "origin", "main");
  const worktree = NodePath.join(f.a, "worktrees", "thread-1");
  git(f.a, "worktree", "add", "-q", "-b", "thread-1", worktree, "origin/main");
  return { ...f, libRemote, nested, worktree };
}

const input = { projectId: projectA };

describe("the project sync service (1390 AC-10, AC-11)", () => {
  it.effect("lists the root and nested repositories, and never a thread's worktree", () => {
    const f = umbrella();
    return Effect.gen(function* () {
      const sync = yield* ProjectSync.ProjectSync;
      const status = yield* sync.status(input);
      expect(status.scanLimited).toBe(false);
      expect(
        status.repositories.map((entry) => `${entry.path} ${entry.branch} ${entry.clean}`),
      ).toEqual([". main true", "repositories/lib main true"]);
      const fetched = yield* sync.fetch(input);
      expect(fetched.repositories.map((entry) => `${entry.path} ${entry.fetch}`)).toEqual([
        ". ok",
        "repositories/lib ok",
      ]);
      // Asked for by name, the worktree is still not moved.
      const before = snapshot(f.worktree);
      const run = yield* sync.run({
        ...input,
        fastForward: [{ path: "worktrees/thread-1", otherBranch: null }],
        clone: [],
      });
      expect(run.repositories[0]).toMatchObject({ action: "none", reason: "refused" });
      expect(snapshot(f.worktree)).toEqual(before);
    }).pipe(Effect.provide(syncLayer([project(projectA, f.a)])));
  });

  it.effect("holds back a checkout a running thread works in, and only that one", () => {
    const f = umbrella();
    // Both repositories fall behind their remotes.
    const publisher = NodePath.join(f.base, "publisher");
    git(f.base, "clone", "-q", f.remote, publisher);
    commit(publisher, "app.ts", "export const a = 2;\n");
    git(publisher, "push", "-q", "origin", "HEAD");
    const libPublisher = NodePath.join(f.base, "lib-publisher");
    git(f.base, "clone", "-q", f.libRemote, libPublisher);
    const libTip = commit(libPublisher, "lib.ts", "export const lib = 2;\n");
    git(libPublisher, "push", "-q", "origin", "HEAD");
    const outside = NodePath.join(f.base, "threads", "thread-2");
    git(f.nested, "worktree", "add", "-q", "-b", "thread-2", outside, "origin/main");
    return Effect.gen(function* () {
      const sync = yield* ProjectSync.ProjectSync;
      // A thread in the project folder's own worktree, and one in a worktree of the
      // nested repository outside the folder: neither works in a listed checkout.
      yield* runningThread({
        id: "t1",
        title: "In its worktree",
        projectId: projectA,
        workspaceRoot: f.a,
        worktreePath: f.worktree,
      });
      yield* runningThread({
        id: "t2",
        title: "Outside the folder",
        projectId: projectA,
        workspaceRoot: f.a,
        worktreePath: outside,
      });
      const free = yield* sync.fetch(input);
      expect(
        free.repositories.map((entry) => `${entry.path} ${entry.inUseBy} ${entry.behind}`),
      ).toEqual([". null 1", "repositories/lib null 1"]);
      // A thread of another project whose folder is the nested repository itself.
      yield* runningThread({
        id: "t3",
        title: "Fix the library",
        projectId: "project-lib",
        workspaceRoot: f.nested,
        worktreePath: null,
      });
      const second = yield* sync.fetch(input);
      const facts = second.repositories;
      expect(facts.map((entry) => `${entry.path} ${entry.inUseBy}`)).toEqual([
        ". null",
        "repositories/lib Fix the library",
      ]);
      const plan = planProjectSync(facts, facts);
      expect(plan.map((step) => `${step.path} ${step.action}:${step.reason}`)).toEqual([
        ". fast-forward:behind",
        "repositories/lib fetch:in-use",
      ]);
      const nestedBefore = snapshot(f.nested);
      const run = yield* sync.run({
        ...input,
        fetchId: second.fetchId,
        fastForward: [
          { path: ".", otherBranch: "main" },
          { path: "repositories/lib", otherBranch: "main" },
        ],
        clone: [],
      });
      expect(
        run.repositories.map((entry) => `${entry.path} ${entry.action} ${entry.moved}`),
      ).toEqual([". fast-forward 1", "repositories/lib fetch 0"]);
      expect(snapshot(f.nested)).toEqual(nestedBefore);
      expect(git(f.nested, "rev-parse", "origin/main")).toBe(libTip);
      // A thread in the project folder itself reaches every repository in it.
      yield* runningThread({
        id: "t4",
        title: "Coordinator",
        projectId: projectA,
        workspaceRoot: f.a,
        worktreePath: null,
      });
      const all = (yield* sync.fetch(input)).repositories;
      expect(all[0]!.inUseBy).toBe("Coordinator");
      expect(["Coordinator", "Fix the library"]).toContain(all[1]!.inUseBy);
    }).pipe(Effect.provide(syncLayer([project(projectA, f.a)])));
  });

  it.effect(
    "removes what a dead clone left behind at the next run, and moves the repository above it (P2-19)",
    () => {
      const f = twoMachines();
      // A server stopped mid-clone: the folder it was filling stayed, here and one level down.
      const leftovers = [".swc-clone-lib-Ab12Cd", "packages/.swc-clone-ui-Zz99Zz"];
      for (const leftover of leftovers) stagingFolder(f.a, leftover);
      write(f.b, "app.ts", "export const a = 2;\n");
      git(f.b, "commit", "-q", "-am", "ahead");
      git(f.b, "push", "-q", "origin", "HEAD:main");
      const head = git(f.b, "rev-parse", "HEAD");
      return Effect.gen(function* () {
        const sync = yield* ProjectSync.ProjectSync;
        // Never a repository of the project, and never work of the repository above it.
        expect((yield* sync.status(input)).repositories).toMatchObject([
          { path: ".", clean: true },
        ]);
        const fetched = yield* sync.fetch(input);
        expect(fetched.repositories.map((entry) => entry.path)).toEqual(["."]);
        expect(fetched.repositories[0]).toMatchObject({ behind: 1, uncommitted: 0 });
        // Reading leaves the leftovers where they are; the next run removes them.
        for (const leftover of leftovers)
          expect(NodeFS.existsSync(NodePath.join(f.a, leftover))).toBe(true);
        const run = yield* sync.run({
          ...input,
          fetchId: fetched.fetchId,
          fastForward: [{ path: ".", otherBranch: "main" }],
          clone: [],
        });
        expect(run.repositories).toMatchObject([{ path: ".", action: "fast-forward", moved: 1 }]);
        expect(git(f.a, "rev-parse", "HEAD")).toBe(head);
        for (const leftover of leftovers)
          expect(NodeFS.existsSync(NodePath.join(f.a, leftover))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(f.a, "packages"))).toBe(true);
      }).pipe(Effect.provide(syncLayer([project(projectA, f.a)])));
    },
  );

  it.effect("lists the root alone when the folder cannot be scanned in full", () => {
    const f = umbrella();
    // A nested folder whose Git data is gone, as a removed worktree leaves behind.
    write(f.a, "worktrees/broken/.git", "gitdir: /nonexistent/worktrees/broken\n");
    return Effect.gen(function* () {
      const sync = yield* ProjectSync.ProjectSync;
      const status = yield* sync.status(input);
      expect(status).toMatchObject({ scanLimited: true });
      expect(status.repositories.map((entry) => entry.path)).toEqual(["."]);
      NodeFS.rmSync(NodePath.join(f.a, "worktrees", "broken"), { recursive: true });
      // A link to a folder stops the scan the same way.
      NodeFS.symlinkSync(f.b, NodePath.join(f.a, "linked"));
      expect(yield* sync.status(input)).toMatchObject({ scanLimited: true });
    }).pipe(Effect.provide(syncLayer([project(projectA, f.a)])));
  });

  it.effect(
    "refuses a project this machine lacks, a personal one, and a folder that is no repository",
    () => {
      const f = twoMachines();
      const plain = NodePath.join(f.base, "plain");
      NodeFS.mkdirSync(plain);
      const personal = ProjectId.make("personal");
      const noGit = ProjectId.make("no-git");
      return Effect.gen(function* () {
        const sync = yield* ProjectSync.ProjectSync;
        const code = (projectId: ProjectId) =>
          Effect.result(sync.status({ projectId })).pipe(
            Effect.map((result) => (Result.isFailure(result) ? result.failure.code : "ok")),
          );
        expect(yield* code(ProjectId.make("unknown"))).toBe("not_found");
        expect(yield* code(personal)).toBe("personal");
        expect(yield* code(noGit)).toBe("invalid");
        expect(yield* code(projectA)).toBe("ok");
        expect(Result.isFailure(yield* Effect.result(sync.fetch({ projectId: personal })))).toBe(
          true,
        );
        expect(
          Result.isFailure(
            yield* Effect.result(sync.run({ projectId: personal, fastForward: [], clone: [] })),
          ),
        ).toBe(true);
      }).pipe(
        Effect.provide(
          syncLayer([
            project(projectA, f.a),
            project(personal, f.b, "personal"),
            project(noGit, plain),
          ]),
        ),
      );
    },
  );
});

describe("a cancelled call and the project's lock (P2-09)", () => {
  /** A promise the work under test resolves itself: the test waits on what happened, not on time. */
  const signal = () => {
    let fire = () => {};
    const fired = new Promise<void>((resolve) => (fire = resolve));
    return { fire, wait: Effect.promise(() => fired) };
  };
  /** Lets every fiber that can run do so, many times over: a cancel that could go through would have. */
  const settle = Effect.forEach(Array.from({ length: 200 }), () => Effect.yieldNow, {
    discard: true,
  });

  it.effect("keeps the lock until stopped Git work has ended and cleaned up", () =>
    Effect.gen(function* () {
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const events: Array<string> = [];
      const started = signal();
      // Git work that ends some time after it is told to stop, as a killed clone does.
      const work = ProjectSync.stoppedWhenCancelled(
        (cancel) =>
          new Promise<string>((resolve) => {
            events.push("started");
            started.fire();
            cancel.addEventListener("abort", () => {
              events.push("told to stop");
              // Not at once: the process ends and the folder is removed a few turns later.
              void Promise.resolve()
                .then(() => undefined)
                .then(() => undefined)
                .then(() => {
                  events.push("ended and cleaned up");
                  resolve("stopped");
                });
            });
          }),
      );
      const first = yield* Effect.forkChild(admission.withLock(projectA, work));
      yield* started.wait;
      const second = yield* Effect.forkChild(
        admission.withLock(
          projectA,
          Effect.sync(() => events.push("next call has the lock")),
        ),
      );
      yield* Fiber.interrupt(first);
      yield* Fiber.join(second);
      expect(events).toEqual([
        "started",
        "told to stop",
        "ended and cleaned up",
        "next call has the lock",
      ]);
      // Work that ends by itself is not told to stop, and gives its result.
      expect(
        yield* ProjectSync.stoppedWhenCancelled(async (cancel) => (cancel.aborted ? "no" : "yes")),
      ).toBe("yes");
    }).pipe(Effect.provide(ProjectAdmission.layer)),
  );

  it.effect("never cuts a move short: a cancelled call waits for it under the lock", () =>
    Effect.gen(function* () {
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const events: Array<string> = [];
      const started = signal();
      let finish = () => {};
      const work = ProjectSync.untilGitEnds(
        () =>
          new Promise<void>((resolve) => {
            events.push("move started");
            started.fire();
            finish = () => {
              events.push("move ended");
              resolve();
            };
          }),
      );
      const first = yield* Effect.forkChild(admission.withLock(projectA, work));
      yield* started.wait;
      const second = yield* Effect.forkChild(
        admission.withLock(
          projectA,
          Effect.sync(() => events.push("next call has the lock")),
        ),
      );
      const cancelled = yield* Effect.forkChild(Fiber.interrupt(first));
      // The cancel is asked for; the move still runs and the lock is still held.
      yield* settle;
      expect(events).toEqual(["move started"]);
      finish();
      yield* Fiber.join(cancelled);
      yield* Fiber.join(second);
      expect(events).toEqual(["move started", "move ended", "next call has the lock"]);
    }).pipe(Effect.provide(ProjectAdmission.layer)),
  );

  it.effect(
    "stops a cancelled clone, removes its folder, and only then lets the next call in",
    () => {
      const f = twoMachines();
      // A server that accepts and never answers: the clone waits until it is stopped.
      const sockets: Array<NodeNet.Socket> = [];
      let connected = () => {};
      const connection = new Promise<void>((resolve) => (connected = resolve));
      const server = NodeNet.createServer((socket) => {
        sockets.push(socket);
        connected();
      });
      return Effect.gen(function* () {
        const sync = yield* ProjectSync.ProjectSync;
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const port = (server.address() as NodeNet.AddressInfo).port;
        // An address another machine could use, read here from the server above.
        const config = NodePath.join(f.base, "slow.gitconfig");
        NodeFS.writeFileSync(
          config,
          `[url "git://127.0.0.1:${port}/"]\n\tinsteadOf = git://sync.test/\n`,
        );
        process.env.GIT_CONFIG_GLOBAL = config;
        const parent = NodePath.join(f.a, "repositories");
        const target = NodePath.join(parent, "slow");
        const run = yield* Effect.forkChild(
          sync.run({
            ...input,
            fastForward: [],
            clone: [{ path: "repositories/slow", remote: "git://sync.test/acme/slow.git" }],
          }),
        );
        yield* Effect.promise(() => connection);
        // The clone is filling a folder of its own beside the target, which is not there yet.
        expect(NodeFS.readdirSync(parent).map((name) => name.slice(0, 16))).toEqual([
          ".swc-clone-slow-",
        ]);
        expect(NodeFS.existsSync(target)).toBe(false);
        // Status takes no lock: it runs now, and does not list the folder being filled (P2-19).
        const staging = `repositories/${NodeFS.readdirSync(parent)[0]!}`;
        expect(NodeFS.existsSync(NodePath.join(f.a, staging, "clone", ".git"))).toBe(true);
        expect((yield* sync.status(input)).repositories.map((entry) => entry.path)).toEqual(["."]);
        // A clone that is still running keeps its folder when leftovers are swept.
        expect(
          yield* Effect.promise(() => ProjectSync.sweepCloneLeftovers(f.a, [staging])),
        ).toEqual({ failed: [], live: [] });
        expect(NodeFS.existsSync(NodePath.join(f.a, staging, "clone", ".git"))).toBe(true);
        // A second call waits for the lock the clone holds.
        const seen: Array<boolean> = [];
        const next = yield* Effect.forkChild(
          sync
            .fetch(input)
            .pipe(Effect.tap(() => Effect.sync(() => seen.push(NodeFS.existsSync(parent))))),
        );
        yield* Fiber.interrupt(run);
        // The cancel returned: Git has ended and the folder it was filling is gone.
        expect(NodeFS.existsSync(parent)).toBe(false);
        yield* Fiber.join(next);
        // The next call got the lock only after the folder was removed.
        expect(seen).toEqual([false]);
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            process.env.GIT_CONFIG_GLOBAL = "/dev/null";
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve) => server.close(resolve));
          }),
        ),
        Effect.provide(syncLayer([project(projectA, f.a)])),
      );
    },
  );
});

describe("extras through the peer messages to the real receiver (1390 AC-13)", () => {
  const OPERATION = "0a1b2c3d-1111-4222-8333-444455556666";

  /** Machine B's receiver, and a peer sender on machine A that carries each message to it. */
  const withMachines = <A, E>(
    f: { readonly a: string; readonly b: string },
    grant: ReturnType<typeof unscopedGrant> | null,
    body: (extras: ProjectSyncExtras.ProjectSyncExtras["Service"]) => Effect.Effect<A, E>,
    /** Runs as a bundle reaches the other machine, before it lands; a test holds it there. */
    onArrival: () => Promise<void> = async () => {},
  ) =>
    Effect.gen(function* () {
      const receiver = yield* Effect.service(ExtrasReceiver).pipe(
        Effect.provide(
          extrasReceiverLayer.pipe(
            Layer.provide(projectsLayer([project(projectB, f.b)])),
            Layer.provide(machineLayer(m5, "M5")),
          ),
        ),
      );
      const caller = { sourceEnvironmentId: m4, grant };
      // Each message crosses as its JSON form, as it does between two servers.
      const overWire = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
        Schema.decodeUnknownSync(schema as never)(
          JSON.parse(JSON.stringify(Schema.encodeSync(schema as never)(value as never))),
        ) as S["Type"];
      const refused = (error: { readonly code: string; readonly message: string }) =>
        new HandoffPeerError({
          code: error.code as never,
          message: error.message,
          uncertain: false,
        });
      const peers = Layer.mock(HandoffPeers)({
        extrasNegotiate: (_, request) =>
          receiver
            .negotiate(caller, overWire(ExtrasNegotiateRequest, request))
            .pipe(Effect.mapError(refused)),
        extrasReplicate: (_, meta, bundle) =>
          Effect.promise(onArrival).pipe(
            Effect.andThen(receiver.replicate(caller, overWire(ExtrasReplicateMeta, meta), bundle)),
            Effect.mapError(refused),
          ),
      });
      return yield* Effect.service(ProjectSyncExtras.ProjectSyncExtras).pipe(
        Effect.flatMap(body),
        Effect.provide(
          ProjectSyncExtras.layer.pipe(
            Layer.provide(peers),
            Layer.provide(machineLayer(m4, "M4")),
            Layer.provide(syncLayer([project(projectA, f.a)])),
          ),
        ),
      );
    });

  it.effect(
    "lands a nested repository's branch and the root's uncommitted work as branches",
    () => {
      const f = umbrella();
      // Machine B has the nested repository too.
      git(f.base, "clone", "-q", f.libRemote, NodePath.join(f.b, "repositories", "lib"));
      const nestedB = NodePath.join(f.b, "repositories", "lib");
      const libTip = commit(f.nested, "lib.ts", "export const lib = 'not pushed';\n");
      write(f.a, "app.ts", "export const a = 'uncommitted';\n");
      // Hidden refs a send and an arrival left behind when a server stopped mid-way (P2-08).
      git(f.nested, "update-ref", "refs/specwithcode/extras/dead-op/0", libTip);
      git(
        nestedB,
        "update-ref",
        "refs/specwithcode/extras-incoming/dead-op/0123456789abcdef",
        "HEAD",
      );
      const before = { root: snapshot(f.b), nested: snapshot(nestedB), source: snapshot(f.a) };
      return withMachines(f, unscopedGrant(m4), (extras) =>
        Effect.gen(function* () {
          const inventory = yield* extras.inventory({ projectId: projectA });
          expect(
            inventory.repositories.map(
              (entry) => `${entry.path} ${entry.notPushed.length} ${entry.changedFiles}`,
            ),
          ).toEqual([". 0 1", "repositories/lib 1 0"]);
          const sent = yield* extras.sendExtras({
            projectId: projectA,
            targetEnvironmentId: m5,
            operationId: OPERATION,
            items: [
              { kind: "branch", path: "repositories/lib", branch: "main" },
              { kind: "uncommitted", path: ".", sendAnyway: [] },
              { kind: "branch", path: "worktrees/thread-1", branch: "thread-1" },
            ],
          });
          expect(
            sent.items.map((item) => `${item.path} ${item.status} ${item.landed ?? item.stays}`),
          ).toEqual([
            "repositories/lib sent created",
            ". sent created",
            // A thread's worktree is not a repository of the project for Sync.
            "worktrees/thread-1 stays failed",
          ]);
          expect(sent.items[0]!.arrivedAs).toBe("swc/from-M4/main");
          expect(git(nestedB, "rev-parse", "refs/heads/swc/from-M4/main")).toBe(libTip);
          expect(sent.items[1]!.arrivedAs).toMatch(
            /^swc\/from-M4\/uncommitted-\d{8}-\d{6}-0a1b2c$/,
          );
          expect(git(f.b, "show", `${sent.items[1]!.arrivedAs}:app.ts`)).toBe(
            "export const a = 'uncommitted';",
          );
          expect(filesOf(f.b, sent.items[1]!.arrivedAs!)).toContain("app.ts");
          for (const repository of [f.a, f.b])
            expect(git(repository, "for-each-ref", "refs/specwithcode")).toBe("");
          // A send removes only its own refs: one it did not write stays, at its commit (R5-06).
          expect(
            git(f.nested, "for-each-ref", "--format=%(refname) %(objectname)", "refs/specwithcode"),
          ).toBe(`refs/specwithcode/extras/dead-op/0 ${libTip}`);
          expect(git(nestedB, "for-each-ref", "refs/specwithcode/extras-incoming")).toBe("");
          // Nothing arrived in a working folder, and the source is as it was.
          expect(snapshot(f.b)).toEqual(before.root);
          expect(snapshot(nestedB)).toEqual(before.nested);
          expect(snapshot(f.a)).toEqual(before.source);
        }),
      );
    },
  );

  it.effect("finishes a send that was cancelled mid-way and leaves no hidden ref (P2-08)", () => {
    const f = twoMachines();
    const tip = commit(f.a, "app.ts", "export const a = 2;\n");
    let arrived = () => {};
    const arrival = new Promise<void>((resolve) => (arrived = resolve));
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    return withMachines(
      f,
      unscopedGrant(m4),
      (extras) =>
        Effect.gen(function* () {
          const send = yield* Effect.forkChild(
            extras.sendExtras({
              projectId: projectA,
              targetEnvironmentId: m5,
              operationId: OPERATION,
              items: [{ kind: "branch", path: ".", branch: "main" }],
            }),
          );
          yield* Effect.promise(() => arrival);
          expect(git(f.a, "for-each-ref", "refs/specwithcode/extras")).not.toBe("");
          const cancelled = yield* Effect.forkChild(Fiber.interrupt(send));
          yield* Effect.forEach(Array.from({ length: 200 }), () => Effect.yieldNow, {
            discard: true,
          });
          // Cancelled, and still under way: the bundle is with the other machine.
          expect(git(f.b, "for-each-ref", "refs/heads/swc")).toBe("");
          release();
          yield* Fiber.join(cancelled);
          expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/main")).toBe(tip);
          for (const repository of [f.a, f.b])
            expect(git(repository, "for-each-ref", "refs/specwithcode")).toBe("");
        }),
      async () => {
        arrived();
        await held;
      },
    );
  });

  it.effect(
    "keeps the hidden ref of a send under way while another send runs (P2-14, R5-06)",
    () => {
      const f = twoMachines();
      const tip = commit(f.a, "app.ts", "export const a = 2;\n");
      const OTHER = "1b2c3d4e-1111-4222-8333-444455556666";
      let arrivals = 0;
      let held = () => {};
      const holding = new Promise<void>((resolve) => (held = resolve));
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      // The first send waits at the other machine with its hidden ref written; a second send
      // runs to its end meanwhile.
      const onArrival = async () => {
        arrivals += 1;
        if (arrivals !== 1) return;
        held();
        await released;
      };
      return withMachines(
        f,
        unscopedGrant(m4),
        (extras) =>
          Effect.gen(function* () {
            const send = (operationId: string) =>
              extras.sendExtras({
                projectId: projectA,
                targetEnvironmentId: m5,
                operationId,
                items: [{ kind: "branch", path: ".", branch: "main" }],
              });
            const first = yield* Effect.forkChild(send(OPERATION));
            yield* Effect.promise(() => holding);
            const own = `refs/specwithcode/extras/${OPERATION}/0`;
            expect(git(f.a, "for-each-ref", "--format=%(objectname)", own)).toBe(tip);
            const second = yield* send(OTHER);
            expect(second.items[0]).toMatchObject({ status: "sent", stays: null });
            // The second send removed only its own ref.
            expect(git(f.a, "for-each-ref", "--format=%(objectname)", own)).toBe(tip);
            release();
            const firstSent = yield* Fiber.join(first);
            expect(firstSent.items[0]).toMatchObject({ status: "sent", stays: null });
            expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/main")).toBe(tip);
            for (const repository of [f.a, f.b])
              expect(git(repository, "for-each-ref", "refs/specwithcode")).toBe("");
          }),
        onArrival,
      );
    },
  );

  it.effect("never offers a clone's staging folder as work to send (P2-19)", () => {
    const f = twoMachines();
    stagingFolder(f.a, ".swc-clone-lib-Ab12Cd");
    return withMachines(f, unscopedGrant(m4), (extras) =>
      Effect.gen(function* () {
        const inventory = yield* extras.inventory({ projectId: projectA });
        expect(inventory.repositories).toMatchObject([
          { path: ".", changedFiles: 0, untrackedFiles: 0, leftOut: [] },
        ]);
        const sent = yield* extras.sendExtras({
          projectId: projectA,
          targetEnvironmentId: m5,
          operationId: OPERATION,
          items: [{ kind: "branch", path: ".swc-clone-lib-Ab12Cd/clone", branch: "main" }],
        });
        expect(sent.items[0]).toMatchObject({ status: "stays", stays: "failed" });
      }),
    );
  });

  it.effect("keeps every extra of a folder it could not read, and lists none (P3-09)", () => {
    const f = umbrella();
    const nested = NodeFS.realpathSync(f.nested);
    commit(f.nested, "lib.ts", "export const lib = 2;\n");
    // Git never answers whether the nested folder is a thread's worktree.
    gitHooks.before = (command) => {
      if (command.cwd === nested && command.args.includes("--git-common-dir"))
        throw new Error("git rev-parse timed out");
    };
    return withMachines(f, unscopedGrant(m4), (extras) =>
      Effect.gen(function* () {
        const inventory = yield* extras.inventory({ projectId: projectA });
        expect(
          inventory.repositories.find((entry) => entry.path === "repositories/lib"),
        ).toMatchObject({ notPushed: [], onlyHere: [], unreadDetail: expect.any(String) });
        const sent = yield* extras.sendExtras({
          projectId: projectA,
          targetEnvironmentId: m5,
          operationId: OPERATION,
          items: [{ kind: "branch", path: "repositories/lib", branch: "main" }],
        });
        expect(sent.items[0]).toMatchObject({
          status: "stays",
          stays: "failed",
          detail: "This folder could not be read, so Sync skipped it.",
        });
      }),
    );
  });

  it.effect("keeps an extra when the other machine's grant does not cover the project", () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    return withMachines(f, null, (extras) =>
      Effect.gen(function* () {
        const sent = yield* extras.sendExtras({
          projectId: projectA,
          targetEnvironmentId: m5,
          operationId: OPERATION,
          items: [{ kind: "branch", path: ".", branch: "main" }],
        });
        expect(sent.items[0]).toMatchObject({ status: "stays", stays: "refused", arrivedAs: null });
        expect(sent.items[0]!.detail).toContain("no work grant");
        expect(git(f.b, "for-each-ref", "refs/heads/swc")).toBe("");
        const self = yield* Effect.result(
          extras.sendExtras({
            projectId: projectA,
            targetEnvironmentId: m4,
            operationId: OPERATION,
            items: [],
          }),
        );
        expect(Result.isFailure(self) && self.failure.code).toBe("invalid");
      }),
    );
  });
});
