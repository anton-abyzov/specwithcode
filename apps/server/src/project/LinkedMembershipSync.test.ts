/**
 * Unlinking and linking again across three machines, driven by the real member
 * sync between real `ProjectLink` services (1390 AC-35): an unlink ends only
 * the link it was made against, whichever machine links the copy again, and
 * whatever the machines' clocks say.
 */
import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import type { EnvironmentId, LogicalProjectMember } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  type LinkedDigestResponse,
  type LinkedMembersRequest,
} from "../handoff/linkedSyncWire.ts";
import { type LinkedPeerSyncDeps, makeLinkedPeerSync } from "./LinkedPeerSync.ts";
import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";
import { checkout, machine, removeCheckouts } from "./ProjectLink.testkit.ts";

type Machine = ReturnType<typeof machine>;
interface Copy {
  readonly machine: Machine;
  readonly member: LogicalProjectMember;
  /** How far this machine's clock is from the others', in milliseconds. */
  readonly clockOffset: number;
}

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "git@github.com:anton/sw-easychamp.git";
let operations = 0;
const operationId = () => `00000000-0000-4000-8000-${String(++operations).padStart(12, "0")}`;

afterEach(() => {
  vi.useRealTimers();
  removeCheckouts();
});

const fleet = (offsets: { readonly c?: number } = {}) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let elapsed = 0;
  const copyOn = (environment: string, project: string, clockOffset = 0): Copy => {
    const target = machine(environment);
    const workspaceRoot = target.add(project, checkout(ORIGIN)).workspaceRoot;
    return { machine: target, member: { ...target.member(project), workspaceRoot }, clockOffset };
  };
  const a = copyOn("m4", "easychamp-m4");
  const b = copyOn("m3", "easychamp-m3");
  const c = copyOn("m1", "easychamp-m1", offsets.c);
  const copies = [a, b, c];
  const offline = new Set<EnvironmentId>();
  const copyAt = (environmentId: EnvironmentId) =>
    copies.find((copy) => copy.machine.environmentId === environmentId)!;
  /** One call on a machine's own `ProjectLink`, at that machine's clock. */
  const on = <A>(copy: Copy, use: Parameters<Machine["run"]>[0]) => {
    vi.setSystemTime(NOW + copy.clockOffset + ++elapsed * 1000);
    return copy.machine.run(use) as Promise<A>;
  };
  const settings = (copy: Copy) =>
    copy.machine.projects.get(copy.member.projectId)!.workspaceSettings;
  const lists = (copy: Copy) =>
    (settings(copy)?.logicalProject?.members ?? [])
      .map((member) => member.environmentId as string)
      .toSorted();
  const digest = (copy: Copy): LinkedDigestResponse => ({
    protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
    member: copy.member,
    binding: settings(copy)?.coordinatorBinding ?? null,
    coordinatorDigest: "same",
    replica: null,
    memoryDigest: "m".repeat(64),
    planDigest: null,
    members: settings(copy)?.logicalProject?.members ?? [],
  });
  const unreachable = new HandoffPeerError({
    code: "unreachable",
    message: "No answer.",
    uncertain: false,
  });
  /** The member sync as one machine's server runs it, calling the other machines' services. */
  const syncOf = (copy: Copy) =>
    Effect.gen(function* () {
      const unused = () => Effect.die("not part of member sync");
      const deps = {
        selfEnvironmentId: copy.machine.environmentId,
        selfLabel: Effect.succeed("Here"),
        listProjects: Effect.sync(() => [...copy.machine.projects.values()]),
        targets: Effect.sync(() =>
          copies
            .filter((other) => other !== copy)
            .map((other) => ({
              machineId: other.machine.environmentId,
              environmentId: other.machine.environmentId,
              label: "There",
            })),
        ),
        state: yield* LinkedPeerSyncState.make,
        isHeld: Effect.succeed(false),
        describe: () => Effect.sync(() => digest(copy)),
        content: unused,
        replicate: unused,
        giveWay: unused,
        adoptMembers: (request: Parameters<LinkedPeerSyncDeps["adoptMembers"]>[0]) =>
          Effect.promise(() => on(copy, (service) => service.adoptMembers(request))),
        addPredecessorMembers: unused,
        memory: { memoryExport: unused, memoryMerge: unused },
        plans: { exportLinked: unused, mergeLinked: unused },
        peers: {
          linkedDigest: (environmentId: EnvironmentId) =>
            offline.has(environmentId)
              ? Effect.fail(unreachable)
              : Effect.sync(() => digest(copyAt(environmentId))),
          // As the peer's route answers `linked-members`: its own service takes the list.
          linkedMembers: (environmentId: EnvironmentId, request: LinkedMembersRequest) =>
            offline.has(environmentId)
              ? Effect.fail(unreachable)
              : Effect.promise(() =>
                  on(copyAt(environmentId), (service) =>
                    service.adoptMembers({
                      projectId: request.projectId,
                      logicalProjectId: request.logicalProjectId,
                      from: request.from,
                      fromEpoch: request.fromEpoch,
                      members: request.members,
                      ...(request.removed === undefined ? {} : { removed: request.removed }),
                      ...(request.relinked === undefined ? {} : { relinked: request.relinked }),
                    }),
                  ),
                ),
          linkedContent: unused,
          linkedReplica: unused,
          linkedSupersede: unused,
          planExport: unused,
          planMerge: unused,
          memoryExport: unused,
          memoryMerge: unused,
          reachable: (environmentId: EnvironmentId) =>
            Effect.sync(() => !offline.has(environmentId)),
        },
      } as unknown as LinkedPeerSyncDeps;
      return yield* makeLinkedPeerSync(deps);
    });
  /** `joining` joins the project `kept` holds: prepare there, accept here, commit there. */
  const link = async (kept: Copy, joining: Copy) => {
    const id = operationId();
    const prepared = await on<any>(kept, (service) =>
      service.prepare({
        operationId: id,
        projectId: kept.member.projectId,
        joining: joining.member,
      }),
    );
    const accepted = await on<any>(joining, (service) =>
      service.accept({
        operationId: id,
        projectId: joining.member.projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      }),
    );
    const joined = accepted.member as LogicalProjectMember;
    await commit(kept, id, joined);
    return { operationId: id, joined };
  };
  /** The last step of a link, as its window sends it, and sends again on a retry. */
  const commit = (kept: Copy, id: string, joining: LogicalProjectMember) =>
    on(kept, (service) =>
      service.commit({
        operationId: id,
        projectId: kept.member.projectId,
        joining,
        notes: [],
      }),
    );
  /** How `holder` lists the copy on `listed`'s machine, if it does. */
  const entry = (holder: Copy, listed: Copy) =>
    (settings(holder)?.logicalProject?.members ?? []).find(
      (member) => member.environmentId === listed.machine.environmentId,
    );
  /** `kept` is asked to drop a membership, named as the caller saw it listed. */
  const drop = (kept: Copy, membership: LogicalProjectMember) =>
    on(kept, (service) =>
      service.unlink({
        side: "coordinator",
        operationId: operationId(),
        projectId: kept.member.projectId,
        member: membership,
      }),
    );
  /** `leaving` leaves with a project of its own. */
  const leave = (leaving: Copy) =>
    on(leaving, (service) =>
      service.unlink({
        side: "member",
        operationId: operationId(),
        projectId: leaving.member.projectId,
        notes: [],
      }),
    );
  /** Settings unlinks `leaving` on `kept`, and `leaving` leaves with a project of its own. */
  const unlink = async (kept: Copy, leaving: Copy) => {
    await drop(kept, entry(kept, leaving) ?? leaving.member);
    await leave(leaving);
  };
  return { a, b, c, copies, offline, syncOf, link, commit, entry, drop, leave, unlink, lists, on };
};

/** Every machine that is on runs its sync, a few times over, as passes go by. */
const settle = (run: ReturnType<typeof fleet>) =>
  Effect.gen(function* () {
    const syncs = yield* Effect.forEach(run.copies, (copy) =>
      run.syncOf(copy).pipe(Effect.map((sync) => ({ copy, sync }))),
    );
    for (let pass = 0; pass < 4; pass++) {
      for (const { copy, sync } of syncs)
        if (!run.offline.has(copy.machine.environmentId)) yield* sync.tick;
      yield* TestClock.adjust("11 minutes");
    }
  });

const everyone = ["m1", "m3", "m4"];

describe("an unlink ends only the link it was made against", () => {
  const relinkedThroughAnother = (offsets: { readonly c?: number }) =>
    Effect.gen(function* () {
      const run = fleet(offsets);
      const { a, b, c } = run;
      yield* Effect.promise(() => run.link(a, b));
      // 1. A unlinks B.
      yield* Effect.promise(() => run.unlink(a, b));
      // 2. C joins A, and never hears of that unlink.
      yield* Effect.promise(() => run.link(a, c));
      yield* settle(run);
      assert.deepStrictEqual(run.lists(c), ["m1", "m4"]);
      // 3. With A away, B is linked again, through C.
      run.offline.add(a.machine.environmentId);
      yield* Effect.promise(() => run.link(c, b));
      yield* settle(run);
      assert.deepStrictEqual(run.lists(c), everyone);
      // 4. A comes back with its old unlink: B stays on every machine.
      run.offline.delete(a.machine.environmentId);
      yield* settle(run);
      assert.deepStrictEqual(run.lists(c), everyone);
      assert.deepStrictEqual(run.lists(a), everyone);
      assert.deepStrictEqual(run.lists(b), everyone);
    });

  it.effect("a copy linked again through another machine outlives the old unlink", () =>
    relinkedThroughAnother({}),
  );

  it.effect("and does so when that machine's clock is a day behind", () =>
    relinkedThroughAnother({ c: -DAY }),
  );

  it.effect("a copy linked again on the machine that unlinked it stays, too", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b, c } = run;
      yield* Effect.promise(() => run.link(a, b));
      yield* Effect.promise(() => run.link(a, c));
      yield* settle(run);
      assert.deepStrictEqual(run.lists(c), everyone);
      // A unlinks B and C hears of it.
      yield* Effect.promise(() => run.unlink(a, b));
      yield* settle(run);
      assert.deepStrictEqual(run.lists(c), ["m1", "m4"]);
      // With C away, B is linked again on A.
      run.offline.add(c.machine.environmentId);
      yield* Effect.promise(() => run.link(a, b));
      // C comes back remembering the old unlink.
      run.offline.delete(c.machine.environmentId);
      yield* settle(run);
      assert.deepStrictEqual(run.lists(a), everyone);
      assert.deepStrictEqual(run.lists(c), everyone);
      // A later unlink still removes B everywhere.
      yield* Effect.promise(() => run.unlink(a, b));
      yield* settle(run);
      assert.deepStrictEqual(run.lists(a), ["m1", "m4"]);
      assert.deepStrictEqual(run.lists(c), ["m1", "m4"]);
    }),
  );
});

describe("a late call names the link it was made for", () => {
  it.effect("an unlink that arrives after the copy is linked again changes nothing", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b } = run;
      yield* Effect.promise(() => run.link(a, b));
      const first = run.entry(a, b)!;
      yield* Effect.promise(() => run.unlink(a, b));
      const second = yield* Effect.promise(() => run.link(a, b));
      // The same unlink, sent twice: its second copy arrives only now.
      yield* Effect.promise(() => run.drop(a, first));
      assert.deepStrictEqual(run.lists(a), ["m3", "m4"]);
      assert.strictEqual(run.entry(a, b)?.linkId, second.operationId);
    }),
  );

  it.effect("the commit of a link that was since replaced is refused", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b } = run;
      const first = yield* Effect.promise(() => run.link(a, b));
      yield* Effect.promise(() => run.unlink(a, b));
      const second = yield* Effect.promise(() => run.link(a, b));
      const retried = yield* Effect.promise(() =>
        run.commit(a, first.operationId, first.joined).then(
          () => "committed",
          () => "refused",
        ),
      );
      assert.strictEqual(run.entry(a, b)?.linkId, second.operationId);
      assert.strictEqual(retried, "refused");
    }),
  );

  it.effect("the commit of a link that was since unlinked is refused", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b } = run;
      const first = yield* Effect.promise(() => run.link(a, b));
      yield* Effect.promise(() => run.unlink(a, b));
      const retried = yield* Effect.promise(() =>
        run.commit(a, first.operationId, first.joined).then(
          () => "committed",
          () => "refused",
        ),
      );
      assert.deepStrictEqual(run.lists(a), ["m4"]);
      assert.strictEqual(retried, "refused");
    }),
  );

  it.effect("a machine that still lists an earlier link never brings the copy back", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b, c } = run;
      yield* Effect.promise(() => run.link(a, c));
      yield* settle(run);
      // B joins through C while A is away, so A never hears of that link.
      run.offline.add(a.machine.environmentId);
      yield* Effect.promise(() => run.link(c, b));
      // C goes away still listing it. B leaves, joins again through A, and A unlinks it.
      run.offline.add(c.machine.environmentId);
      run.offline.delete(a.machine.environmentId);
      yield* Effect.promise(() => run.leave(b));
      yield* Effect.promise(() => run.link(a, b));
      yield* Effect.promise(() => run.unlink(a, b));
      assert.deepStrictEqual(run.lists(a), ["m1", "m4"]);
      // C comes back with the link A never saw. It is older than the one A unlinked.
      run.offline.delete(c.machine.environmentId);
      yield* settle(run);
      assert.deepStrictEqual(run.lists(a), ["m1", "m4"]);
      assert.deepStrictEqual(run.lists(c), ["m1", "m4"]);
    }),
  );
});

describe("with a machine from before links were named", () => {
  /** A member as such a machine lists and sends it: with no word of which link. */
  const unnamed = (member: LogicalProjectMember): LogicalProjectMember => ({
    environmentId: member.environmentId,
    projectId: member.projectId,
    coordinatorThreadId: member.coordinatorThreadId,
  });
  const logicalId = (run: ReturnType<typeof fleet>) =>
    run.a.machine.projects.get(run.a.member.projectId)!.workspaceSettings!.logicalProject!.id;

  it.effect("its unlink, which names no link, never ends a named one", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b } = run;
      yield* Effect.promise(() => run.link(a, b));
      yield* Effect.promise(() => run.drop(a, unnamed(run.entry(a, b)!)));
      assert.deepStrictEqual(run.lists(a), ["m3", "m4"]);
    }),
  );

  it.effect("its list never brings back a copy this machine unlinked", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b, c } = run;
      yield* Effect.promise(() => run.link(a, b));
      yield* Effect.promise(() => run.link(a, c));
      const listed = run.entry(a, b)!;
      yield* Effect.promise(() => run.unlink(a, b));
      // The list as that machine relays it: the member with its link's name lost.
      yield* Effect.promise(() =>
        run.on(a, (service) =>
          service.adoptMembers({
            projectId: a.member.projectId,
            logicalProjectId: logicalId(run),
            from: run.entry(a, c)!,
            fromEpoch: 0,
            members: [a.member, run.entry(a, c)!, unnamed(listed)],
          }),
        ),
      );
      assert.deepStrictEqual(run.lists(a), ["m1", "m4"]);
    }),
  );

  it.effect("a member it relayed takes its link's name from a machine that knows it", () =>
    Effect.gen(function* () {
      const run = fleet();
      const { a, b, c } = run;
      yield* Effect.promise(() => run.link(a, c));
      yield* settle(run);
      run.offline.add(c.machine.environmentId);
      const first = yield* Effect.promise(() => run.link(a, b));
      yield* Effect.promise(() => run.unlink(a, b));
      const second = yield* Effect.promise(() => run.link(a, b));
      // C hears of B from the older machine first, which lost the name of B's link.
      yield* Effect.promise(() =>
        run.on(c, (service) =>
          service.adoptMembers({
            projectId: c.member.projectId,
            logicalProjectId: logicalId(run),
            from: run.entry(c, a)!,
            fromEpoch: 0,
            members: [run.entry(c, a)!, run.entry(c, c)!, unnamed(second.joined)],
          }),
        ),
      );
      assert.strictEqual(run.entry(c, b)?.linkId, undefined);
      // Then from A, which knows the link: C lists that link, and the old unlink leaves it be.
      run.offline.delete(c.machine.environmentId);
      yield* settle(run);
      assert.strictEqual(run.entry(c, b)?.linkId, second.operationId);
      assert.notStrictEqual(first.operationId, second.operationId);
      assert.deepStrictEqual(run.lists(c), everyone);
      assert.deepStrictEqual(run.lists(a), everyone);
    }),
  );
});
