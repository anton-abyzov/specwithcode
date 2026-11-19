// @effect-diagnostics nodeBuiltinImport:off - these tests drive real Git repositories.
/**
 * The hand off batch where it is cut or lied to (1390): a server that stops
 * between two writes, a destination that changes build before a repeat, a
 * folder outside the granted project, a file Git does not show, and a window
 * that names threads the rule would not take.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  HANDOFF_PLAN_CAPABILITY,
  HANDOFF_V2_CAPABILITY,
  type HandoffBatchRun,
  type HandoffTransferDocument,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import { applyFolderWork, coordinatorStays } from "./HandoffBatch.ts";
import { makeRig, type Rig, type RigMachine } from "./handoffTransfer.test.fixture.ts";
import type { TakeoverRequest } from "./handoffWire.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
// Not through `git`, which trims: a status line starts with a space.
const statusOf = (root: string) =>
  NodeChildProcess.execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line !== "")
    .toSorted();

const t1 = ThreadId.make("thread:one");
const AUTOMATIC = { kind: "automatic", key: "limit-handoff:thread:one:run-1" } as const;
const BATCH_ID = "0a1b2c3d-1111-4222-8333-444455557777";
const BRANCH = "swc/from-a/uncommitted-20261119-140000-abc123";

const two = (rig: Rig) => rig.machines as [RigMachine, RigMachine];
const rowOf = (run: HandoffBatchRun | undefined, id: string) =>
  run?.rows.find((row) => row.id === id);
const takeovers = (rig: Rig) =>
  rig.callsOf("takeover").map((call) => call.request as TakeoverRequest);
const leaseOf = (machine: RigMachine, id: ThreadId) => machine.document.threads[id]?.lease ?? null;
const recordOf = (machine: RigMachine) => Object.values(machine.transfers.document.transfers)[0];
const caller = (machine: RigMachine) => ({
  sourceEnvironmentId: machine.environmentId,
  grant: unscopedGrant(machine.environmentId),
});
const signal = (deferred: Deferred.Deferred<void>) =>
  Deferred.succeed(deferred, undefined).pipe(Effect.asVoid);
const ready = (destination: RigMachine) => ({
  destinationEnvironmentId: destination.environmentId,
  start: "manual" as const,
  threads: [{ threadId: t1, disposition: "ready" as const }],
});
/** A machine on a build that keeps transfer records and plans, and takes no batch. */
const BEFORE_BATCHES = [HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY];

/** A repository with one commit, and a snapshot branch one commit on top of it. */
const repositoryWithSnapshot = (root: string, branch = BRANCH) => {
  NodeFS.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  snapshotOnTop(root, branch);
};
/** Adds a snapshot branch on top of the folder's commit and leaves the folder as it was. */
const snapshotOnTop = (root: string, branch = BRANCH) => {
  const head = git(root, "rev-parse", "HEAD");
  const blob = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: "export const moved = 1;\n",
  }).trim();
  const index = NodePath.join(root, ".git", "snapshot-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  NodeChildProcess.execFileSync("git", ["read-tree", head], { cwd: root, env });
  NodeChildProcess.execFileSync(
    "git",
    ["update-index", "--add", "--cacheinfo", `100644,${blob},moved.ts`],
    { cwd: root, env },
  );
  const tree = NodeChildProcess.execFileSync("git", ["write-tree"], {
    cwd: root,
    env,
    encoding: "utf8",
  }).trim();
  NodeFS.rmSync(index, { force: true });
  const commit = git(root, "commit-tree", tree, "-p", head, "-m", "snapshot");
  git(root, "update-ref", `refs/heads/${branch}`, commit);
};

describe("a Ready thread stays Ready through a restart (AC-19, AC-41)", () => {
  it.effect("the source stops after the hold and before the send", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      // The checkpoint alone would continue this run on arrival.
      a.runEnding = "usage-limit";
      const held = yield* Deferred.make<void>();
      a.onDocument = (document) =>
        document.threads[t1]?.lease?.state === "handing-off"
          ? signal(held).pipe(Effect.andThen(Effect.never))
          : Effect.void;

      const window = yield* a.moves.handOffBatch(ready(b)).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      expect(takeovers(rig)).toHaveLength(0);
      const batchId = recordOf(a)?.batchId;

      // The server stops here and starts again.
      a.onDocument = null;
      yield* rig.restart(a);
      yield* Fiber.interrupt(window);
      yield* a.moves.tick;

      const sent = takeovers(rig);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.batch).toMatchObject({ batchId, disposition: "ready" });
      expect(b.launches).toHaveLength(1);
      expect(b.launches[0]?.initialMessage).toBeUndefined();
      expect(recordOf(a)).toMatchObject({ state: "ready", disposition: "ready" });
      expect(recordOf(a)?.receipt?.resumed).toBe(false);
    }),
  );

  it.effect("the source stops after a send that never arrived", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      rig.network.rule = (call) => (call.path === "takeover" ? "lose-request" : undefined);
      const run = yield* a.moves.handOffBatch(ready(b));
      expect(rowOf(run, t1)?.state).toBe("unknown");

      rig.network.rule = null;
      yield* rig.restart(a);
      yield* a.moves.tick;

      const sent = takeovers(rig);
      expect(sent).toHaveLength(2);
      expect(sent[0]?.batch?.disposition).toBe("ready");
      expect(sent[1]?.batch).toEqual(sent[0]?.batch);
      expect(b.launches).toHaveLength(1);
      expect(b.launches[0]?.initialMessage).toBeUndefined();
      expect(recordOf(a)).toMatchObject({ state: "ready", disposition: "ready" });
    }),
  );

  it.effect("the destination stops after it accepted and before it launched", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      const launching = yield* Deferred.make<void>();
      b.onLaunch = () => signal(launching).pipe(Effect.andThen(Effect.never));

      const window = yield* a.moves.handOffBatch(ready(b)).pipe(Effect.forkChild);
      yield* Deferred.await(launching);
      expect(b.launches).toHaveLength(0);
      const record = recordOf(a)!;

      // The destination stops here and starts again; the source asks what it has.
      b.onLaunch = null;
      yield* rig.restart(b);
      const status = yield* b.receiver.transferStatus(caller(a), {
        sourceEnvironmentId: a.environmentId,
        sourceThreadId: t1,
        epoch: record.lineage.epoch,
        operationId: record.operationId,
      });
      yield* Fiber.interrupt(window);

      expect(status.status).toBe("accepted");
      expect(b.launches).toHaveLength(1);
      expect(b.launches[0]?.initialMessage).toBeUndefined();
      expect(status.receipt?.resumed).toBe(false);
    }),
  );

  it.effect("a repeat that lost the batch's fields does not turn it into a resume", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      const launching = yield* Deferred.make<void>();
      b.onLaunch = () => signal(launching).pipe(Effect.andThen(Effect.never));

      const window = yield* a.moves.handOffBatch(ready(b)).pipe(Effect.forkChild);
      yield* Deferred.await(launching);
      const { batch: _batch, ...bare } = takeovers(rig)[0]!;

      b.onLaunch = null;
      yield* rig.restart(b);
      const receipt = yield* b.receiver.takeover(caller(a), bare);
      yield* Fiber.interrupt(window);

      expect(b.launches).toHaveLength(1);
      expect(b.launches[0]?.initialMessage).toBeUndefined();
      expect(receipt.resumed).toBe(false);
    }),
  );
});

describe("the revision is compared before anything is placed (AC-46)", () => {
  it.effect("another revision is refused with the folder and its worktrees as they were", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t1] });
      const sequence = a.document.threads[t1]?.checkpoint?.sequence ?? 0;
      const placed = () => [git(b.root, "worktree", "list", "--porcelain"), statusOf(b.root)];
      const before = placed();

      const refused = yield* b.receiver
        .takeover(caller(a), {
          sourceEnvironmentId: a.environmentId,
          sourceThreadId: t1,
          epoch: 2,
          sequence,
          reason: "machine-handoff",
          modelSelection: null,
          operationId: "0a1b2c3d-1111-4222-8333-444455556666",
          trigger: { kind: "manual" },
          batch: {
            batchId: BATCH_ID,
            disposition: "ready",
            context: { sequence, commit: "0".repeat(40) },
          },
        })
        .pipe(Effect.flip);

      expect(refused.message).toContain("another revision");
      expect(b.launches).toHaveLength(0);
      expect(placed()).toEqual(before);
    }),
  );
});

describe("folder work stays inside the granted project (AC-20)", () => {
  const request = (a: RigMachine, repositoryPath: string) => ({
    sourceEnvironmentId: a.environmentId,
    sourceLabel: "A",
    sourceProjectId: a.projectId,
    repositoryPath,
    operationId: BATCH_ID,
    branch: BRANCH,
  });

  it.effect("a link inside the project to another checkout is refused", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      const outside = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-outside-")),
      );
      temporary.push(outside);
      repositoryWithSnapshot(outside);
      NodeFS.symlinkSync(outside, NodePath.join(b.root, "linked"));

      const answered = yield* b.folderWork(caller(a), request(a, "linked")).pipe(Effect.result);

      expect(statusOf(outside)).toEqual([]);
      expect(answered._tag).toBe("Failure");
    }),
  );

  it.effect("a project inside a larger checkout does not reach that checkout", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      const inner = NodePath.join(b.root, "packages", "app");
      NodeFS.mkdirSync(inner, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(inner, "index.ts"), "export {};\n");
      git(b.root, "add", "-A");
      git(b.root, "commit", "-q", "-m", "a package");
      snapshotOnTop(b.root);
      b.projectRoot = inner;
      yield* rig.restart(b);
      const before = statusOf(b.root);

      const answered = yield* b.folderWork(caller(a), request(a, "../..")).pipe(Effect.result);

      expect(statusOf(b.root)).toEqual(before);
      expect(answered._tag).toBe("Failure");
    }),
  );

  it.effect("a repository below the project that is not one of its repositories is refused", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      const nested = NodePath.join(b.root, "vendor", "lib");
      repositoryWithSnapshot(nested);
      b.folderSource = {
        inventory: () => Effect.die("not read here"),
        sendExtras: () => Effect.die("not sent here"),
        repositories: () => Effect.succeed([""]),
      } as never;
      yield* rig.restart(b);

      const answered = yield* b
        .folderWork(caller(a), request(a, "vendor/lib"))
        .pipe(Effect.result);
      expect(statusOf(nested)).toEqual([]);
      expect(answered._tag).toBe("Failure");

      // The project's own repository is still answered for.
      const own = yield* b.folderWork(caller(a), request(a, ""));
      expect(own).toMatchObject({ applied: false });
    }),
  );
});

describe("folder work never replaces a file only the destination has (AC-20)", () => {
  it("leaves a local file Git ignores, and the snapshot stays a branch", async () => {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-folder-ignored-")),
    );
    temporary.push(base);
    repositoryWithSnapshot(base);
    // Only this folder has it, and Git does not list it.
    NodeFS.appendFileSync(NodePath.join(base, ".git", "info", "exclude"), "moved.ts\n");
    NodeFS.writeFileSync(NodePath.join(base, "moved.ts"), "local only\n");
    expect(statusOf(base)).toEqual([]);

    const done = await applyFolderWork({ root: base, branch: BRANCH, operationId: BATCH_ID });

    expect(NodeFS.readFileSync(NodePath.join(base, "moved.ts"), "utf8")).toBe("local only\n");
    expect(done.applied).toBe(false);
    expect(done.reason).toContain("moved.ts");
    expect(statusOf(base)).toEqual([]);
    expect(git(base, "rev-parse", "--verify", `refs/heads/${BRANCH}`)).toHaveLength(40);
  });
});

describe("a batch on file always ends (AC-23, AC-43)", () => {
  const stored = (a: RigMachine, b: RigMachine, rows: ReadonlyArray<unknown>) => {
    a.transfers.document = {
      ...a.transfers.document,
      batches: {
        ...a.transfers.document.batches,
        [BATCH_ID]: {
          batchId: BATCH_ID,
          targetEnvironmentId: b.environmentId,
          trigger: { kind: "manual" },
          operationIds: [],
          createdAt: new Date().toISOString(),
          start: "manual",
          targetLabel: "B",
          rows,
          finishedAt: null,
        },
      },
    } as HandoffTransferDocument;
  };
  const row = (a: RigMachine, kind: "thread" | "folder-work") => ({
    kind,
    id: kind === "thread" ? t1 : a.projectId,
    title: kind === "thread" ? "Fix the parser" : "App",
    projectId: a.projectId,
    operationId: null,
    disposition: "ready",
    state: "pending",
    detail: null,
  });

  it.effect("no write leaves a thread's row waiting without its transfer record", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      let unlinked = 0;
      a.transfers.failWrite = (next) => {
        for (const batch of Object.values(next.batches)) {
          for (const entry of batch.rows ?? []) {
            if (entry.kind === "thread" && entry.state === "pending" && entry.operationId === null) {
              unlinked += 1;
            }
          }
        }
        return false;
      };

      const run = yield* a.moves.handOffBatch(ready(b));

      expect(rowOf(run, t1)?.state).toBe("ready");
      expect(unlinked).toBe(0);
    }),
  );

  it.effect("a thread row a stopped server never linked reads Stayed after the restart", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      stored(a, b, [row(a, "thread")]);
      yield* rig.restart(a);

      yield* a.moves.tick;

      const [read] = yield* a.moves.readBatches({ batchId: BATCH_ID });
      expect(rowOf(read, t1)?.state).toBe("stayed");
      expect(read?.finishedAt).not.toBeNull();
      expect(takeovers(rig)).toHaveLength(0);
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 1 });
    }),
  );

  it.effect("unfinished folder work is sent again under the batch's own operation", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      const sent: Array<string> = [];
      a.folderSource = {
        inventory: () =>
          Effect.succeed({
            scanLimited: false,
            repositories: [
              {
                path: "",
                notPushed: [],
                onlyHere: [{ branch: "feature", head: "a".repeat(40), commits: 2 }],
                branchesNotListed: 0,
                changedFiles: 0,
                untrackedFiles: 0,
                stashes: 0,
                leftOut: [],
                leftOutNotListed: 0,
              },
            ],
          }),
        sendExtras: (input: { readonly operationId: string }) =>
          Effect.sync(() => {
            sent.push(input.operationId);
            return {
              items: [
                {
                  kind: "branch",
                  path: "",
                  branch: "feature",
                  status: "sent",
                  arrivedAs: "swc/from-a/feature",
                  stays: null,
                  detail: null,
                },
              ],
            };
          }),
        repositories: () => Effect.succeed([""]),
      } as never;
      stored(a, b, [row(a, "folder-work")]);
      yield* rig.restart(a);

      yield* a.moves.tick;

      expect(sent).toEqual([BATCH_ID]);
      const [read] = yield* a.moves.readBatches({ batchId: BATCH_ID });
      expect(rowOf(read, a.projectId)).toMatchObject({ state: "ready" });
      expect(rowOf(read, a.projectId)?.detail).toContain("On B as branch swc/from-a/feature.");
      expect(read?.finishedAt).not.toBeNull();
      // Once: the next tick finds nothing left to do.
      yield* a.moves.tick;
      expect(sent).toEqual([BATCH_ID]);
    }),
  );
});

describe("a repeat never goes to a machine that stopped taking batches (EC2-04)", () => {
  it.effect("a send that never arrived is asked about, not sent again", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      rig.network.rule = (call) => (call.path === "takeover" ? "lose-request" : undefined);
      yield* a.moves.handOffBatch(ready(b));
      expect(leaseOf(a, t1)?.state).toBe("handing-off");

      // The destination comes back on a build from before batches.
      rig.network.rule = null;
      b.capabilities = BEFORE_BATCHES;
      yield* rig.restart(a);
      yield* a.moves.tick;

      expect(takeovers(rig)).toHaveLength(1);
      expect(b.launches).toHaveLength(0);
      expect(rig.callsOf("transfer-status").length).toBeGreaterThan(0);
      // It said, in writing, that it never accepted: only then does the thread run here again.
      expect(recordOf(a)?.state).toBe("failed");
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 2 });
    }),
  );

  it.effect("a send that arrived is confirmed by its status, not by a second takeover", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      rig.network.rule = (call) => (call.path === "takeover" ? "lose-answer" : undefined);
      yield* a.moves.handOffBatch(ready(b));
      expect(b.launches).toHaveLength(1);

      rig.network.rule = null;
      b.capabilities = BEFORE_BATCHES;
      yield* rig.restart(a);
      yield* a.moves.tick;

      expect(takeovers(rig)).toHaveLength(1);
      expect(b.launches).toHaveLength(1);
      expect(b.launches[0]?.initialMessage).toBeUndefined();
      expect(recordOf(a)).toMatchObject({ state: "ready", disposition: "ready" });
      expect(leaseOf(a, t1)?.state).not.toBe("active");
    }),
  );

  it.effect("a thread held and never sent stays here", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      const held = yield* Deferred.make<void>();
      a.onDocument = (document) =>
        document.threads[t1]?.lease?.state === "handing-off"
          ? signal(held).pipe(Effect.andThen(Effect.never))
          : Effect.void;
      const window = yield* a.moves.handOffBatch(ready(b)).pipe(Effect.forkChild);
      yield* Deferred.await(held);

      a.onDocument = null;
      b.capabilities = BEFORE_BATCHES;
      yield* rig.restart(a);
      yield* Fiber.interrupt(window);
      yield* a.moves.tick;

      expect(takeovers(rig)).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
      expect(recordOf(a)?.state).toBe("stayed");
      expect(leaseOf(a, t1)?.state).toBe("active");
    }),
  );
});

describe("an automatic start is admitted by the server, not by the window (AC-41)", () => {
  const automatic = (destination: RigMachine) => ({
    destinationEnvironmentId: destination.environmentId,
    start: "automatic" as const,
    trigger: AUTOMATIC,
    threads: [{ threadId: t1, disposition: "resume" as const }],
  });

  it.effect("a thread that works now is not interrupted for it", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1, { running: true });

      const run = yield* a.moves.handOffBatch(automatic(b));

      expect(rowOf(run, t1)).toMatchObject({ state: "stayed", operationId: null });
      expect(a.dispatched.filter((command) => command.type === "run.interrupt")).toHaveLength(0);
      expect(a.threads.get(t1)?.activeRunId).not.toBeNull();
      expect(takeovers(rig)).toHaveLength(0);
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 1 });
    }),
  );

  it.effect("the rule's own answer keeps a thread it does not take", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      const asked: Array<string> = [];
      a.admission = {
        automatic: (input) =>
          Effect.sync(() => {
            asked.push(input.threadId);
            return "The usage-limit rule is off for this project.";
          }),
      };
      yield* rig.restart(a);

      const run = yield* a.moves.handOffBatch(automatic(b));

      expect(asked).toEqual([t1]);
      expect(rowOf(run, t1)).toMatchObject({
        state: "stayed",
        detail: "The usage-limit rule is off for this project.",
      });
      expect(takeovers(rig)).toHaveLength(0);
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 1 });
    }),
  );

  it.effect("with no rule to read, nothing moves automatically, and a person's batch still does", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";
      a.admission = null;
      yield* rig.restart(a);

      const run = yield* a.moves.handOffBatch(automatic(b));

      expect(rowOf(run, t1)?.state).toBe("stayed");
      expect(takeovers(rig)).toHaveLength(0);

      const asked = yield* a.moves.handOffBatch(ready(b));
      expect(rowOf(asked, t1)?.state).toBe("ready");
    }),
  );
});

describe("a coordinator conversation never moves on a guess (AC-46)", () => {
  it.effect("a project that cannot be read keeps the row here", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      const coordinator = ThreadId.make(`project-coordinator:${a.projectId}`);
      rig.addThread(a, coordinator);
      a.projectLookupFails = 1;

      const run = yield* a.moves.handOffBatch({
        destinationEnvironmentId: b.environmentId,
        start: "manual",
        threads: [{ threadId: coordinator }],
      });

      expect(rowOf(run, coordinator)).toMatchObject({ state: "stayed", operationId: null });
      expect(rowOf(run, coordinator)?.detail).not.toBe(coordinatorStays("A"));
      expect(takeovers(rig)).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
      expect(leaseOf(a, coordinator)).toMatchObject({ state: "active", epoch: 1 });
    }),
  );
});

describe("asking again for a thread that already moved", () => {
  it.effect("names the same thread on the destination", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1, { running: true });
      const input = {
        destinationEnvironmentId: b.environmentId,
        start: "manual" as const,
        threads: [{ threadId: t1 }],
      };
      const first = yield* a.moves.handOffBatch(input);
      const continued = rowOf(first, t1)?.continuedThreadId;
      expect(continued).toBe(b.launches[0]?.threadId);

      const again = yield* a.moves.handOffBatch(input);

      expect(rowOf(again, t1)?.continuedThreadId).toBe(continued);
      expect(["resumed", "ready"]).toContain(rowOf(again, t1)?.state);
      expect(b.launches).toHaveLength(1);
      const [read] = yield* a.moves.readBatches({ batchId: again.batchId });
      expect(rowOf(read, t1)?.continuedThreadId).toBe(continued);
    }),
  );
});
