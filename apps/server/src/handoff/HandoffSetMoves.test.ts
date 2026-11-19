// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A thread in a worktree set moves whole or stays (1390, T-09), between real
 * machines in one process and on real Git repositories: every member's
 * branch, commits and uncommitted files arrive in a worktree set on the other
 * machine under the thread's transfer record, or nothing of the thread moves
 * and the row says which member stopped it and why.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  HANDOFF_V2_CAPABILITY,
  type HandoffTransferRecord,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import { worktreeSetManifestPath } from "../worktreeSet.ts";
import { resolveRepositoryPath } from "./bundleGit.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import {
  bundleSetMember,
  checkArrivedSet,
  checkpointFolder,
  checkpointSetMembers,
  materializeSet,
  type PreparedMember,
  readSourceSet,
  SET_LIMITS,
  startedSetFolder,
} from "./HandoffSetMoves.ts";
import { findIncoming } from "./handoffState.ts";
import {
  makeRig,
  modelSelection,
  type Rig,
  type RigMachine,
} from "./handoffTransfer.test.fixture.ts";
import {
  HANDOFF_CAPABILITIES,
  decodeFrame,
  encodeFrame,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_WORKTREE_SET_CAPABILITY,
  PeerPreflightRequest,
  PeerPreflightResponse,
  ReplicateMeta,
  type ReplicateSet,
  TakeoverRequest,
} from "./handoffWire.ts";
import {
  PREVIOUS_PROTOCOL_VERSION,
  PreviousPeerPreflightRequest,
  PreviousPeerPreflightResponse,
  PreviousTakeoverResponse,
  encodePreviousPreflightRequest,
  encodePreviousTakeoverRequest,
  overTheWire,
  previousReadAnswer,
  previousTakeoverFailure,
} from "./previousRelease383.test.fixture.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Set Test", "-c", "user.email=set@example.invalid", "-C", cwd, ...args],
    { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const write = (root: string, path: string, content: string | Uint8Array) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), content);
};
const read = (root: string, path: string) => NodeFS.readFileSync(NodePath.join(root, path), "utf8");

/** The capability a machine must name at both ends before a worktree set travels to it. */
const SET_CAPABILITY = "handoff.worktree-set";
/** A frame as it travels: encoded, framed with its bundle, and read back on the other side. */
const overTheFrame = (meta: ReplicateMeta) =>
  decodeMeta(decodeFrame(encodeFrame(encodeMeta(meta), new Uint8Array([1, 2, 3]))).meta);
const t1 = ThreadId.make("thread:set");
const t2 = ThreadId.make("thread:plain");
const LIB = "packages/lib";
const ELEVEN_MB = new Uint8Array(11 * 1024 * 1024).fill(97);

const transfersOf = (machine: RigMachine, threadId: ThreadId): Array<HandoffTransferRecord> =>
  Object.values(machine.transfers.document.transfers).filter(
    (record) => record.lineage.sourceThreadId === threadId,
  );
const leaseOf = (machine: RigMachine, threadId: ThreadId) =>
  machine.document.threads[threadId]?.lease ?? null;
const caller = (machine: RigMachine) => ({
  sourceEnvironmentId: machine.environmentId,
  grant: unscopedGrant(machine.environmentId),
});
const encodeProbe = Schema.encodeSync(PeerPreflightRequest);
const encodeAnswer = Schema.encodeSync(PeerPreflightResponse);
const encodeMeta = Schema.encodeSync(ReplicateMeta);
const decodeMeta = Schema.decodeUnknownSync(ReplicateMeta);
const readAsRequest = Schema.decodeUnknownOption(PeerPreflightRequest);
const readAsTakeover = Schema.decodeUnknownOption(TakeoverRequest);
const readAsPreviousTakeover = Schema.decodeUnknownOption(PreviousTakeoverResponse);
const readAsPreviousRequest = Schema.decodeUnknownOption(PreviousPeerPreflightRequest);
const readAsPreviousResponse = Schema.decodeUnknownOption(PreviousPeerPreflightResponse);
/** Every ref this app keeps in a repository. */
const appRefs = (root: string) =>
  git(root, "for-each-ref", "--format=%(refname)", "refs/specwithcode/incoming");
const replicated = (rig: Rig, to?: RigMachine) =>
  rig.callsOf("replicate", to).map((call) => call.request as ReplicateMeta);

/**
 * A second repository nested in the project on every machine, and on the first
 * machine a thread whose folder holds a worktree of both on one branch. The
 * nested member carries a commit that exists nowhere else and an uncommitted
 * file; the project's own member carries an uncommitted change.
 */
const withSet = (rig: Rig, threadId: ThreadId, options?: { readonly running?: boolean }) => {
  const [a, ...others] = rig.machines as [RigMachine, ...Array<RigMachine>];
  const lib = NodePath.join(a.root, LIB);
  NodeFS.mkdirSync(lib, { recursive: true });
  git(lib, "init", "-q", "-b", "main");
  write(lib, "lib.ts", "export const lib = 1;\n");
  git(lib, "add", "-A");
  git(lib, "commit", "-q", "-m", "lib base");
  NodeFS.appendFileSync(NodePath.join(a.root, ".git", "info", "exclude"), "packages/\n");
  for (const other of others) {
    NodeFS.mkdirSync(NodePath.join(other.root, "packages"), { recursive: true });
    git(other.root, "clone", "-q", lib, NodePath.join(other.root, LIB));
    NodeFS.appendFileSync(NodePath.join(other.root, ".git", "info", "exclude"), "packages/\n");
  }
  const folder = NodePath.join(NodePath.dirname(a.root), "source-sets", "feature-set");
  NodeFS.mkdirSync(NodePath.dirname(folder), { recursive: true });
  git(a.root, "worktree", "add", "-q", "-b", "feature/set", folder);
  git(lib, "worktree", "add", "-q", "-b", "feature/set", NodePath.join(folder, LIB));
  NodeFS.writeFileSync(
    worktreeSetManifestPath(folder, NodePath),
    JSON.stringify({
      version: 1,
      members: [
        { repository: a.root, relativePath: "" },
        { repository: lib, relativePath: LIB },
      ],
    }),
  );
  write(folder, "app.ts", "export const a = 2;\n");
  write(folder, "notes.md", "root member, not committed\n");
  const member = NodePath.join(folder, LIB);
  write(member, "lib.ts", "export const lib = 2;\n");
  git(member, "commit", "-q", "-am", "lib work that was never pushed");
  write(member, "draft.ts", "export const draft = true;\n");
  rig.addThread(a, threadId, options);
  a.threads.get(threadId)!.worktreePath = folder;
  return { folder, member, lib };
};

const handOffSet = (a: RigMachine, to: RigMachine) =>
  a.moves.handOff({ threadId: t1, destinationEnvironmentId: to.environmentId });

/** One thread asked for as a batch: its row is what the user reads. */
const batchOf = (a: RigMachine, to: RigMachine, threadId: ThreadId) =>
  a.moves
    .handOffMachine({
      destinationEnvironmentId: to.environmentId,
      reason: "manual",
      threadIds: [threadId],
    })
    .pipe(Effect.map((run) => run.results[0]!));

describe("a thread in a worktree set", () => {
  it.effect("moves whole: every member's branch, commits and uncommitted files arrive", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      const set = withSet(rig, t1, { running: true });
      const unpushed = git(set.member, "rev-parse", "HEAD");

      const result = yield* handOffSet(a, b);

      const launch = b.launches[0]!;
      expect(b.launches).toHaveLength(1);
      expect(launch.threadId).toBe(result.threadId);
      const strategy = launch.workspaceStrategy as {
        readonly type: string;
        readonly worktreePath: string;
      };
      expect(strategy.type).toBe("existing_worktree");
      const arrived = strategy.worktreePath;
      const arrivedLib = NodePath.join(arrived, LIB);
      // The project's own member: its branch and its uncommitted work.
      expect(git(arrived, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/set");
      expect(read(arrived, "app.ts")).toBe("export const a = 2;\n");
      expect(read(arrived, "notes.md")).toBe("root member, not committed\n");
      expect(git(arrived, "status", "--porcelain")).toContain("app.ts");
      // The nested member: the commit that was only on the source, and its uncommitted file.
      expect(git(arrivedLib, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/set");
      expect(git(arrivedLib, "rev-parse", "HEAD")).toBe(unpushed);
      expect(read(arrivedLib, "lib.ts")).toBe("export const lib = 2;\n");
      expect(read(arrivedLib, "draft.ts")).toBe("export const draft = true;\n");
      expect(git(arrivedLib, "status", "--porcelain")).toContain("draft.ts");
      // It is a worktree set there: the manifest names both members by this machine's checkouts.
      const manifest = JSON.parse(
        NodeFS.readFileSync(worktreeSetManifestPath(arrived, NodePath), "utf8"),
      ) as { members: Array<{ repository: string; relativePath: string }> };
      expect(manifest.members).toEqual([
        { repository: b.root, relativePath: "" },
        { repository: NodePath.join(b.root, LIB), relativePath: LIB },
      ]);
      // One transfer record carried the whole set, and one copy of the thread is kept there.
      expect(transfersOf(a, t1)).toHaveLength(1);
      expect(transfersOf(a, t1)[0]?.state).toBe("resumed");
      expect(b.document.incoming).toHaveLength(1);
      const copy = findIncoming(b.document, a.environmentId, t1);
      expect(copy?.checkpoint.commit).toBe(a.document.threads[t1]?.checkpoint?.commit);
      // A member that moved is not listed as left behind.
      expect(result.notice ?? "").not.toContain("Not carried over");
      // The member's bundle travels first; the thread's own names every member last.
      const last = replicated(rig, b).at(-1) as ReplicateMeta & {
        readonly set?: { readonly members: ReadonlyArray<{ readonly repositoryPath: string }> };
      };
      expect(last.set?.members.map((member) => member.repositoryPath)).toEqual(["", LIB]);
      const frames = replicated(rig, b);
      const part = frames.find((frame) => frame.setPart !== undefined);
      expect(part?.repositoryPath).toBe(LIB);
      expect(part?.setPart?.commit).toBe(last.set?.members[1]?.commit);
      expect(frames.indexOf(part!)).toBeLessThan(frames.lastIndexOf(last));
      // Both kinds of frame survive the wire as they are.
      expect(overTheFrame(part!)).toEqual(part);
      expect(overTheFrame(last)).toEqual(last);
    }),
  );

  it.effect("is not copied by the standby tick: only a hand off sends it, whole", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1);
      rig.addThread(a, t2);
      // Both threads have a checkpoint (the check of a move wrote it) and no standby copy on record.
      yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t1, t2] });
      a.document = {
        ...a.document,
        threads: Object.fromEntries(
          Object.entries(a.document.threads).map(([id, record]) => [
            id,
            { ...record, replicas: [] },
          ]),
        ),
      };
      rig.network.calls.length = 0;

      yield* a.moves.replicate;

      // The thread in one repository was copied; of the set, not one repository.
      const sent = replicated(rig, b);
      expect(sent.map((frame) => frame.sourceThreadId)).toEqual([t2]);
      expect(rig.network.calls.every((call) => call.path !== "preflight")).toBe(true);
    }),
  );

  it.effect("leaves nothing behind when a member cannot be built at the takeover", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1, { running: true });
      // The member's repository goes away after every check passed, as the takeover leaves.
      rig.network.rule = (call) => {
        if (call.path === "takeover") {
          NodeFS.rmSync(NodePath.join(b.root, LIB), { recursive: true, force: true });
        }
        return undefined;
      };

      const row = yield* batchOf(a, b, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain(LIB);
      // It was sent and definitely not accepted: the record says so, and the thread runs here.
      expect(transfersOf(a, t1)[0]?.state).toBe("failed");
      expect(leaseOf(a, t1)?.state).toBe("active");
      expect(b.launches).toHaveLength(0);
      expect(Object.values(b.transfers.document.acceptances)).toHaveLength(0);
      // The project's own member is built first; it is not left there alone.
      expect(git(b.root, "worktree", "list").split("\n")).toHaveLength(1);
      expect(git(b.root, "branch", "--format=%(refname:short)")).toBe("main");
    }),
  );

  it.effect("leaves no ref on the other machine when the connection drops between frames", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1, { running: true });
      // The other member's frame arrives; the thread's own, which names the set, is lost.
      rig.network.rule = (call) =>
        call.path === "replicate" && (call.request as ReplicateMeta).set !== undefined
          ? "lose-request"
          : undefined;

      const row = yield* batchOf(a, b, t1);

      expect(row.outcome).toBe("stayed");
      expect(replicated(rig, b).some((frame) => frame.setPart !== undefined)).toBe(true);
      // The member that arrived is pinned nowhere: its repository holds no ref of this thread.
      expect(appRefs(NodePath.join(b.root, LIB))).toBe("");
      expect(appRefs(b.root)).toBe("");
      expect(b.document.incoming).toHaveLength(0);
      expect(leaseOf(a, t1)?.state).toBe("active");
      // Handed off again with the connection back, the whole set arrives.
      rig.network.rule = null;
      const result = yield* handOffSet(a, b);
      expect(b.launches.map((launch) => launch.threadId)).toEqual([result.threadId]);
    }),
  );

  it.effect("asks again at the run: a machine rolled back after the check gets no frame", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1, { running: true });
      const checked = yield* a.moves.preflight({
        destinationEnvironmentId: b.environmentId,
        threadIds: [t1],
      });
      expect(checked[0]?.failures).toEqual([]);
      // Between the check and the run the other machine goes back to a build without sets.
      const current = b.receiver;
      b.receiver = {
        ...current,
        preflight: (from, request) =>
          current
            .preflight(from, request)
            .pipe(Effect.map((answer) => ({ ...answer, capabilities: [HANDOFF_V2_CAPABILITY] }))),
      };
      rig.network.calls.length = 0;

      const row = yield* batchOf(a, b, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain("Update SpecWithCode on B");
      expect(replicated(rig, b)).toHaveLength(0);
      expect(rig.callsOf("takeover", b)).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
    }),
  );

  it.effect("refuses a set frame it never agreed to take, before it imports anything", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1);
      rig.addThread(a, t2);
      yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t2] });
      const plain = replicated(rig, b)[0]!;
      const there = NodePath.join(b.root, LIB);
      const commit = git(there, "rev-parse", "HEAD");
      const frame = {
        ...plain,
        sourceThreadId: t1,
        repositoryPath: LIB,
        setPart: { offer: "never-offered", repositoryPath: LIB, commit },
      } as ReplicateMeta;

      const refusal = yield* b.receiver.replicate(caller(a), frame, null).pipe(Effect.flip);

      expect(refusal.message).toContain("did not agree");
      expect(appRefs(there)).toBe("");
      // The thread's own frame is held to the same rule.
      const whole = {
        ...plain,
        sourceThreadId: t1,
        set: { offer: "never-offered", members: [] },
      } as ReplicateMeta;
      const second = yield* b.receiver.replicate(caller(a), whole, null).pipe(Effect.flip);
      expect(second.message).toContain("did not agree");
      expect(findIncoming(b.document, a.environmentId, t1)).toBeUndefined();
    }),
  );

  it.effect("sends frames a one-repository receiver cannot place, whatever it answered", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1);
      yield* handOffSet(a, b);

      const frames = replicated(rig, b);
      expect(frames.length).toBeGreaterThan(1);
      // A build from before sets reads only `repositoryPath`, and refuses each of these there.
      for (const frame of frames) {
        yield* Effect.promise(() =>
          expect(resolveRepositoryPath(b.root, frame.repositoryPath)).rejects.toThrow(
            /does not map into this project/,
          ),
        );
      }
    }),
  );

  it.effect("stays whole when the other machine lacks one member's repository", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1, { running: true });
      NodeFS.rmSync(NodePath.join(b.root, LIB), { recursive: true, force: true });

      const row = yield* batchOf(a, b, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain(LIB);
      expect(row.detail).toContain("not a Git repository");
      expect(transfersOf(a, t1)[0]?.state).toBe("stayed");
      expect(transfersOf(a, t1)[0]?.detail).toContain(LIB);
      // Nothing of the thread is on the other machine: no bundle, no copy, no thread.
      expect(replicated(rig, b)).toHaveLength(0);
      expect(b.document.incoming).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
      expect(git(b.root, "worktree", "list").split("\n")).toHaveLength(1);
      // It still runs here.
      expect(leaseOf(a, t1)?.state).toBe("active");
      expect(a.threads.get(t1)?.activeRunId).not.toBeNull();
    }),
  );

  it.effect("stays, naming the member and the file, when one member holds a file over 10 MB", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      const set = withSet(rig, t1);
      write(set.member, "assets/video.bin", ELEVEN_MB);

      const row = yield* batchOf(a, b, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain(LIB);
      expect(row.detail).toContain("assets/video.bin");
      expect(row.detail).toContain("10 MB");
      expect(transfersOf(a, t1)[0]?.state).toBe("stayed");
      // The other member was within its limits and still did not travel.
      expect(replicated(rig, b)).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
    }),
  );

  it.effect("stays when a member grew past a limit between the check and the run", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      const set = withSet(rig, t1, { running: true });
      // The running turn writes the file as it is stopped: after the check passed.
      a.onDispatch = (command) =>
        Effect.sync(() => {
          if (command.type === "run.interrupt") write(set.member, "late.bin", ELEVEN_MB);
        });

      const row = yield* batchOf(a, b, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain(LIB);
      expect(row.detail).toContain("late.bin");
      expect(transfersOf(a, t1)[0]?.state).toBe("stayed");
      expect(rig.callsOf("takeover", b)).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
      // Given back: the thread is this machine's again.
      expect(leaseOf(a, t1)?.state).toBe("active");
    }),
  );

  it.effect("moves to another model on the same machine as a new set", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a] = rig.machines as [RigMachine, RigMachine];
      const set = withSet(rig, t1);

      const result = yield* a.moves.handOff({
        threadId: t1,
        destinationEnvironmentId: a.environmentId,
        modelSelection,
      });

      expect(rig.network.calls).toHaveLength(0);
      const strategy = a.launches[0]!.workspaceStrategy as { readonly worktreePath: string };
      expect(a.launches[0]!.threadId).toBe(result.threadId);
      expect(strategy.worktreePath).not.toBe(set.folder);
      expect(read(strategy.worktreePath, "notes.md")).toBe("root member, not committed\n");
      expect(read(NodePath.join(strategy.worktreePath, LIB), "draft.ts")).toBe(
        "export const draft = true;\n",
      );
    }),
  );
});

describe("the worktree set capability with a machine that does not name it", () => {
  /** A machine on the build before worktree sets: it keeps transfer records and nothing more. */
  const beforeSets = (machine: RigMachine) => {
    const current = machine.receiver;
    machine.receiver = {
      ...current,
      preflight: (from, request) =>
        current
          .preflight(from, request)
          .pipe(Effect.map((answer) => ({ ...answer, capabilities: [HANDOFF_V2_CAPABILITY] }))),
    };
  };

  it("is named beside the transfer record, never instead of it", () => {
    expect(HANDOFF_CAPABILITIES).toContain(HANDOFF_V2_CAPABILITY);
    expect(HANDOFF_CAPABILITIES).toContain(SET_CAPABILITY);
    expect(HANDOFF_WORKTREE_SET_CAPABILITY).toBe(SET_CAPABILITY);
  });

  it.effect("as the destination: the set thread stays and no repository is sent", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      withSet(rig, t1, { running: true });
      rig.addThread(a, t2, { running: true });
      beforeSets(b);

      const row = yield* batchOf(a, b, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain("Update SpecWithCode on B");
      expect(transfersOf(a, t1)[0]?.state).toBe("stayed");
      // Not one repository of the set was offered or sent.
      expect(rig.callsOf("negotiate", b)).toHaveLength(0);
      expect(replicated(rig, b)).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
      expect(leaseOf(a, t1)?.state).toBe("active");
      // A thread in one repository still moves between the two.
      const plain = yield* a.moves.handOff({
        threadId: t2,
        destinationEnvironmentId: b.environmentId,
      });
      expect(b.launches.map((launch) => launch.threadId)).toEqual([plain.threadId]);
    }),
  );

  it.effect("as the source: its one-repository thread still arrives here", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t2, { running: true });
      // What that build sends: the transfer record's capability alone, and no set fields.
      const asked = yield* b.receiver.preflight(caller(a), {
        sourceEnvironmentId: a.environmentId,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "1.0.384",
        capabilities: [HANDOFF_V2_CAPABILITY],
        threads: [],
      });
      expect(asked.results).toEqual([]);
      expect(asked.capabilities).toEqual(expect.arrayContaining([HANDOFF_V2_CAPABILITY]));
      // Its thread, replicated, passes every check here though it names no set capability.
      const checked = yield* a.moves.preflight({
        destinationEnvironmentId: b.environmentId,
        threadIds: [t2],
      });
      expect(checked[0]?.failures).toEqual([]);
      const copy = findIncoming(b.document, a.environmentId, t2);
      const own = yield* b.receiver.preflight(caller(a), {
        sourceEnvironmentId: a.environmentId,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "1.0.384",
        capabilities: [HANDOFF_V2_CAPABILITY],
        threads: [
          {
            sourceThreadId: t2,
            sourceProjectId: a.projectId,
            sequence: copy!.checkpoint.sequence,
            modelSelection: null,
          },
        ],
      });
      expect(own.results).toEqual([{ sourceThreadId: t2, failures: [] }]);

      const result = yield* a.moves.handOff({
        threadId: t2,
        destinationEnvironmentId: b.environmentId,
      });

      expect(b.launches.map((launch) => launch.threadId)).toEqual([result.threadId]);
      for (const meta of replicated(rig, b)) {
        expect(meta).not.toHaveProperty("set");
        expect(meta).not.toHaveProperty("setPart");
      }
    }),
  );

  it.effect(
    "the latest release as the source: refused in words it reads, and it keeps its thread",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = rig.machines as [RigMachine, RigMachine];
        rig.addThread(a, t2);
        // That release's own bodies, as its sender writes them: no capabilities, no operation id.
        yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t2] });
        const sequence = a.document.threads[t2]!.checkpoint!.sequence;
        const asked = readAsRequest(
          overTheWire(
            encodePreviousPreflightRequest({
              sourceEnvironmentId: a.environmentId,
              protocolVersion: PREVIOUS_PROTOCOL_VERSION,
              appVersion: "1.0.383",
              threads: [
                {
                  sourceThreadId: t2,
                  sourceProjectId: a.projectId,
                  sequence,
                  modelSelection: null,
                },
              ],
            }),
          ),
        );
        const answer = yield* b.receiver.preflight(caller(a), Option.getOrThrow(asked));
        const check = previousReadAnswer(
          200,
          overTheWire(encodeAnswer(answer)),
          readAsPreviousResponse,
        );
        expect(check.kind).toBe("ok");
        const failures = check.kind === "ok" ? (check.value.results[0]?.failures ?? []) : [];
        expect(failures.map((failure) => failure.check)).toContain("version");
        // It sends its takeover all the same; the answer is a definite no it can read.
        const takeover = readAsTakeover(
          overTheWire(
            encodePreviousTakeoverRequest({
              sourceEnvironmentId: a.environmentId,
              sourceThreadId: t2,
              epoch: 2,
              sequence,
              reason: "handoff",
              modelSelection: null,
            }),
          ),
        );
        const refusal = yield* b.receiver
          .takeover(caller(a), Option.getOrThrow(takeover))
          .pipe(Effect.flip);
        const read = previousReadAnswer(
          refusal.status,
          { error: refusal.message, code: refusal.code, check: refusal.check },
          readAsPreviousTakeover,
        );
        expect(read).toMatchObject({ kind: "refused", uncertain: false });
        // Its disposition: the hold is released there, and nothing started here.
        expect(read.kind === "refused" ? previousTakeoverFailure(read) : null).toBe("released");
        expect(b.launches).toHaveLength(0);
        expect(Object.values(b.transfers.document.acceptances)).toHaveLength(0);
        expect(findIncoming(b.document, a.environmentId, t2)?.continuedThreadId).toBeNull();
      }),
  );

  it.effect("with the latest release: nothing of a set moves, and its bodies still decode", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, [
        { name: "a" },
        { name: "b" },
        { name: "old", previous: true },
      ]);
      const [a, b, old] = rig.machines as [RigMachine, RigMachine, RigMachine];
      withSet(rig, t1, { running: true });

      const row = yield* batchOf(a, old, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain("Update SpecWithCode on OLD");
      expect(rig.callsOf("negotiate", old)).toHaveLength(0);
      expect(replicated(rig, old)).toHaveLength(0);
      expect(old.launches).toHaveLength(0);
      // The question this build asks first is one that release can read and answer.
      const probe = encodeProbe({
        sourceEnvironmentId: a.environmentId,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "1.0.384",
        capabilities: [...HANDOFF_CAPABILITIES],
        threads: [],
      });
      expect(rig.callsOf("preflight", old).length).toBeGreaterThan(0);
      expect(Option.isSome(readAsPreviousRequest(overTheWire(probe)))).toBe(true);
      // And that release reads this build's answer, dropping the list it does not know.
      const answer = yield* b.receiver.preflight(caller(a), {
        sourceEnvironmentId: a.environmentId,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "1.0.384",
        capabilities: [...HANDOFF_CAPABILITIES],
        threads: [],
      });
      expect(answer.capabilities).toContain(SET_CAPABILITY);
      const read = readAsPreviousResponse(overTheWire(encodeAnswer(answer)));
      expect(Option.isSome(read)).toBe(true);
      expect(Option.getOrThrow(read)).not.toHaveProperty("capabilities");
    }),
  );
});

describe("the members of a set, each measured on its own", () => {
  /** A project folder with its own repository and one nested in it, and a set folder of both. */
  const project = () => {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-set-")),
    );
    temporary.push(base);
    const root = NodePath.join(base, "project");
    const lib = NodePath.join(root, LIB);
    for (const [repository, file] of [
      [root, "app.ts"],
      [lib, "lib.ts"],
    ] as const) {
      NodeFS.mkdirSync(repository, { recursive: true });
      git(repository, "init", "-q", "-b", "main");
      write(repository, file, "export const one = 1;\n");
      git(repository, "add", "-A");
      git(repository, "commit", "-q", "-m", "base");
    }
    NodeFS.appendFileSync(NodePath.join(root, ".git", "info", "exclude"), "packages/\n");
    const folder = NodePath.join(base, "sets", "work");
    NodeFS.mkdirSync(NodePath.dirname(folder), { recursive: true });
    git(root, "worktree", "add", "-q", "-b", "work", folder);
    git(lib, "worktree", "add", "-q", "-b", "work", NodePath.join(folder, LIB));
    const members = [
      { relativePath: "", path: folder },
      { relativePath: LIB, path: NodePath.join(folder, LIB) },
    ];
    return { base, root, lib, folder, members };
  };
  const prepare = async (
    at: ReturnType<typeof project>,
    limits = SET_LIMITS,
  ): Promise<ReadonlyArray<PreparedMember>> => {
    const own = await writeCheckpoint({ cwd: at.folder, threadId: "thread-1" });
    return checkpointSetMembers({
      projectRoot: at.root,
      members: at.members,
      threadId: "thread-1",
      checkpoint: {
        commit: own.commit,
        baseCommit: own.baseCommit,
        branch: own.branch,
        ref: own.ref,
        skipped: [...own.skipped],
        requiredSecretPaths: [...own.requiredSecretPaths],
        sourceRoot: { workspaceRoot: own.root } as never,
      },
      limits,
    });
  };

  it("names each member by its place in the project and checkpoints every one", async () => {
    const at = project();
    write(NodePath.join(at.folder, LIB), "new.ts", "export {};\n");

    const members = await prepare(at);

    expect(members.map((member) => member.repositoryPath)).toEqual(["", LIB]);
    expect(members[1]?.branch).toBe("work");
    expect(git(members[1]!.root, "ls-tree", "-r", "--name-only", members[1]!.commit)).toContain(
      "new.ts",
    );
    // The working tree and the branch of the member are as they were.
    expect(git(members[1]!.root, "rev-parse", "HEAD")).toBe(members[1]!.baseCommit);
  });

  it("stops at the file count of one member, and says which", async () => {
    const at = project();
    const member = NodePath.join(at.folder, LIB);
    for (const name of ["a", "b", "c"]) write(member, `${name}.ts`, "export {};\n");
    git(member, "add", "-A");
    git(member, "commit", "-q", "-m", "three files");
    const limits = { ...SET_LIMITS, maxFiles: 2 };
    const members = await prepare(at, limits);

    // The other member is under the same limit and passes.
    const own = await bundleSetMember(members[0]!, [members[0]!.baseCommit], limits);
    await own?.dispose();
    await expect(bundleSetMember(members[1]!, [], limits)).rejects.toThrow(
      /^packages\/lib: 4 files would travel, over the limit of 2\.$/,
    );
  });

  it("stops at the bundle size of one member, and says which", async () => {
    const at = project();
    const member = NodePath.join(at.folder, LIB);
    write(member, "noise.bin", NodeCrypto.randomBytes(64 * 1024));
    const limits = { ...SET_LIMITS, maxBundleBytes: 16 * 1024 };
    const members = await prepare(at, limits);

    await expect(bundleSetMember(members[1]!, [members[1]!.baseCommit], limits)).rejects.toThrow(
      /^packages\/lib: .*handoff limit/,
    );
    // Measured on what travels: with nothing new to send there is no bundle to measure.
    expect(await bundleSetMember(members[1]!, [members[1]!.commit], limits)).toBeNull();
  });

  it("stops at an oversized file in the first member that the capped list never showed", async () => {
    const at = project();
    // 200 nested repositories sort ahead of the file and fill the list a checkpoint keeps.
    const nested = NodePath.join(at.folder, "a000");
    NodeFS.mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    write(nested, "x.ts", "export {};\n");
    git(nested, "add", "-A");
    git(nested, "commit", "-q", "-m", "nested");
    for (let index = 1; index < 200; index += 1) {
      NodeFS.cpSync(nested, NodePath.join(at.folder, `a${String(index).padStart(3, "0")}`), {
        recursive: true,
      });
    }
    write(at.folder, "zz-video.bin", ELEVEN_MB);
    const own = await writeCheckpoint({ cwd: at.folder, threadId: "thread-1" });
    // What the thread's stored checkpoint holds: the first 200 skips, none of them the file.
    expect(own.skipped).toHaveLength(200);
    expect(own.skipped.some((file) => file.path === "zz-video.bin")).toBe(false);

    await expect(prepare(at)).rejects.toThrow(
      /^The project folder's own repository: zz-video\.bin is 11 MB/,
    );
  });

  it("does not read a broken list of repositories as a thread in one repository", async () => {
    const at = project();
    const manifest = worktreeSetManifestPath(at.folder, NodePath);
    expect(await readSourceSet(at.folder)).toBeNull();
    NodeFS.writeFileSync(manifest, "{ not json");
    await expect(readSourceSet(at.folder)).rejects.toThrow(/could not be read/);
    NodeFS.writeFileSync(
      manifest,
      JSON.stringify({ version: 1, members: [{ repository: at.lib, relativePath: LIB }] }),
    );
    // No member is the folder itself: the thread's checkpoint is written in the first one.
    expect(await checkpointFolder(at.folder)).toBe(NodePath.join(at.folder, LIB));
  });

  describe("built on the other machine", () => {
    /** A second machine's copy of the project, holding the work of both members. */
    const arrived = async () => {
      const at = project();
      write(at.folder, "app.ts", "export const one = 2;\n");
      write(NodePath.join(at.folder, LIB), "draft.ts", "export {};\n");
      const members = await prepare(at);
      const there = NodePath.join(at.base, "there");
      git(at.base, "clone", "-q", at.root, there);
      NodeFS.mkdirSync(NodePath.join(there, "packages"), { recursive: true });
      git(at.base, "clone", "-q", at.lib, NodePath.join(there, LIB));
      for (const member of members) {
        const root = NodePath.join(there, member.repositoryPath);
        git(root, "fetch", "-q", member.root, `${member.ref}:refs/specwithcode/incoming/test`);
      }
      const set: ReplicateSet = {
        offer: "offer-1",
        members: members.map(({ root: _root, ref: _ref, ...member }) => member),
      };
      const folder = NodePath.join(at.base, "arrived", "work-handoff");
      const build = (with_: ReplicateSet = set, owner = "source-1/thread-1/2") =>
        materializeSet({
          projectRoot: there,
          folder,
          owner,
          set: with_,
          sourceLabel: "Source",
          sourceThreadId: "thread-1",
        });
      return { at, there, set, folder, build, members };
    };
    const worktrees = (root: string) => git(root, "worktree", "list", "--porcelain");
    const branches = (root: string) => git(root, "branch", "--format=%(refname:short)").split("\n");

    it("takes down the members before the one that failed, and only what it made", async () => {
      const { there, set, folder, build } = await arrived();
      git(there, "branch", "keep-me");
      const broken: ReplicateSet = {
        members: [set.members[0]!, { ...set.members[1]!, commit: "0".repeat(40) }],
      };

      await expect(build(broken)).rejects.toThrow(/^packages\/lib: /);

      // The project's own member was built first; nothing of it is left.
      expect(NodeFS.existsSync(folder)).toBe(false);
      expect(NodeFS.existsSync(worktreeSetManifestPath(folder, NodePath))).toBe(false);
      expect(worktrees(there)).not.toContain(folder);
      expect(branches(there).toSorted()).toEqual(["keep-me", "main"]);
      expect(branches(NodePath.join(there, LIB))).toEqual(["main"]);

      // The same takeover, asked again with the work there, builds the whole set.
      const built = await build();
      expect(built).toEqual({ worktreePath: folder, branch: "work" });
      expect(read(folder, "app.ts")).toBe("export const one = 2;\n");
      expect(read(NodePath.join(folder, LIB), "draft.ts")).toBe("export {};\n");
      // And a repeat after that changes nothing.
      write(folder, "typed-here.ts", "export {};\n");
      expect(await build()).toEqual(built);
      expect(read(folder, "typed-here.ts")).toBe("export {};\n");
      expect(branches(there).toSorted()).toEqual(["keep-me", "main", "work"]);
    });

    it("builds again over an attempt that was cut before the set was whole", async () => {
      const { there, set, folder, build } = await arrived();
      // What a cut attempt leaves: the first member, and no manifest.
      git(there, "worktree", "add", "-q", "-b", "work", folder, set.members[0]!.baseCommit);
      expect(await startedSetFolder({ projectRoot: there, set, name: "work-handoff" })).toBe(
        folder,
      );

      const built = await build();

      expect(built.worktreePath).toBe(folder);
      expect(read(folder, "app.ts")).toBe("export const one = 2;\n");
      expect(read(NodePath.join(folder, LIB), "draft.ts")).toBe("export {};\n");
      expect(NodeFS.existsSync(worktreeSetManifestPath(folder, NodePath))).toBe(true);
    });

    it("builds a set that has no member at the folder itself, and finds it on a repeat", async () => {
      const { there, set, folder, build } = await arrived();
      const nested: ReplicateSet = { members: [set.members[1]!] };

      const built = await build(nested);

      expect(built).toEqual({ worktreePath: folder, branch: "work" });
      expect(NodeFS.existsSync(NodePath.join(folder, ".git"))).toBe(false);
      expect(read(NodePath.join(folder, LIB), "draft.ts")).toBe("export {};\n");
      expect(
        await startedSetFolder({ projectRoot: there, set: nested, name: "work-handoff" }),
      ).toBe(folder);
      expect(await build(nested)).toEqual(built);
    });

    it("does not launch a set one of whose checkouts is gone since it was built", async () => {
      const { there, folder, build } = await arrived();
      const built = await build();
      // Built whole, and then the nested member's checkout was removed.
      git(NodePath.join(there, LIB), "worktree", "remove", "--force", NodePath.join(folder, LIB));

      await expect(build()).rejects.toThrow(/^packages\/lib: /);
      // The member that is left is not touched.
      expect(read(built.worktreePath, "app.ts")).toBe("export const one = 2;\n");
    });

    it("never removes a checkout it cannot prove this handoff made", async () => {
      const { there, set, folder, build } = await arrived();
      // Someone else's worktree sits where the set would go, with work in it.
      git(there, "worktree", "add", "-q", "-b", "theirs", folder, set.members[0]!.baseCommit);
      write(folder, "theirs.ts", "export const theirs = true;\n");

      await expect(build()).rejects.toThrow(/not this handoff's/);

      expect(read(folder, "theirs.ts")).toBe("export const theirs = true;\n");
      expect(branches(there)).toContain("theirs");
      expect(NodeFS.existsSync(NodePath.join(folder, LIB))).toBe(false);
    });

    it("leaves another handoff's set alone, though the folder has the same name", async () => {
      const { folder, build } = await arrived();
      await build();
      write(folder, "typed-there.ts", "export {};\n");

      await expect(build(undefined, "source-2/thread-1/2")).rejects.toThrow(/another handoff/);

      expect(read(folder, "typed-there.ts")).toBe("export {};\n");
      expect(read(NodePath.join(folder, LIB), "draft.ts")).toBe("export {};\n");
    });

    it("keeps an attempt that was cut when a member in it was edited since", async () => {
      const { folder, build } = await arrived();
      await build();
      // As a cut leaves it: every member built, the set never marked whole.
      NodeFS.rmSync(worktreeSetManifestPath(folder, NodePath));
      write(NodePath.join(folder, LIB), "typed-since.ts", "export {};\n");

      await expect(build()).rejects.toThrow(/^packages\/lib: /);

      expect(read(NodePath.join(folder, LIB), "typed-since.ts")).toBe("export {};\n");
      expect(read(folder, "app.ts")).toBe("export const one = 2;\n");
    });

    it("keeps no copy of the thread while one member's work is missing", async () => {
      const { there, set } = await arrived();
      const first = set.members[0]!;
      const check = (with_: ReplicateSet) =>
        checkArrivedSet({
          projectRoot: there,
          set: with_,
          repositoryPath: first.repositoryPath,
          commit: first.commit,
        });

      await expect(check(set)).resolves.toBeUndefined();
      await expect(
        check({ members: [first, { ...set.members[1]!, commit: "0".repeat(40) }] }),
      ).rejects.toThrow(/^packages\/lib: its work did not arrive here/);
      await expect(
        check({ members: [first, { ...set.members[1]!, repositoryPath: "../elsewhere" }] }),
      ).rejects.toThrow(/outside the project folder/);
      await expect(check({ members: [set.members[1]!, first] })).rejects.toThrow(
        /does not start with the thread's own checkpoint/,
      );
    });
  });
});
