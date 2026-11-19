// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A thread in a worktree set moves whole or stays (1390, T-09), between real
 * machines in one process and on real Git repositories: every member's
 * branch, commits and uncommitted files arrive in a worktree set on the other
 * machine under the thread's transfer record, or nothing of the thread moves
 * and the row says which member stopped it and why.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
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
import { findIncoming } from "./handoffState.ts";
import {
  makeRig,
  modelSelection,
  type Rig,
  type RigMachine,
} from "./handoffTransfer.test.fixture.ts";
import {
  HANDOFF_CAPABILITIES,
  HANDOFF_PROTOCOL_VERSION,
  PeerPreflightRequest,
  type ReplicateMeta,
} from "./handoffWire.ts";
import {
  PreviousPeerPreflightRequest,
  PreviousPeerPreflightResponse,
  overTheWire,
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

  it.effect("with the latest release: nothing of a set moves, and its bodies still decode", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, [
        { name: "a" },
        { name: "b" },
        { name: "old", previous: true },
      ]);
      const [a, , old] = rig.machines as [RigMachine, RigMachine, RigMachine];
      withSet(rig, t1, { running: true });

      const row = yield* batchOf(a, old, t1);

      expect(row.outcome).toBe("stayed");
      expect(row.detail).toContain("Update SpecWithCode on OLD");
      expect(rig.callsOf("negotiate", old)).toHaveLength(0);
      expect(replicated(rig, old)).toHaveLength(0);
      expect(old.launches).toHaveLength(0);
      // The question this build asks first is one that release can read and answer.
      const probe = Schema.encodeSync(PeerPreflightRequest)({
        sourceEnvironmentId: a.environmentId,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "1.0.384",
        capabilities: [...HANDOFF_CAPABILITIES],
        threads: [],
      });
      expect(
        Option.isSome(Schema.decodeUnknownOption(PreviousPeerPreflightRequest)(overTheWire(probe))),
      ).toBe(true);
      // And its answer, which names no capability, reads here as a machine without sets.
      const answer = rig.callsOf("preflight", old).length;
      expect(answer).toBeGreaterThan(0);
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(PreviousPeerPreflightResponse)(
            overTheWire({ machineLabel: "OLD", protocolVersion: 2, results: [] }),
          ),
        ),
      ).toBe(true);
    }),
  );
});
