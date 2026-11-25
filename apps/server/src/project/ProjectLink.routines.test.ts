/**
 * A project link moves the joining copy's routines to the kept machine (1472
 * AC-02 to AC-05). Two machines, each with its own database and scheduler,
 * over a network the test can cut; the move is the runner move itself.
 */
import { afterEach, assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Project,
  ProjectId,
  type ScheduledTask,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  adaptToKept,
  linkLeftOffNote,
  linkMovedNote,
  linkPausedNote,
  makeLinkMove,
  rewriteFolder,
  setupNotes,
} from "../scheduledTasks/ScheduledTaskLinkMove.ts";
import { makeLinkPauseMarker } from "../scheduledTasks/ScheduledTaskTransfer.ts";
import { COORDINATES, fleet, type Machine } from "../scheduledTasks/ScheduledTaskRunner.testkit.ts";
import { legacyPair, link, removeCheckouts } from "./ProjectLink.testkit.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const KEPT_ROOT = "/fixture/kept-root";
const JOINING_ROOT = "/fixture/joining-root";

const linked = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOON));
  const net = yield* fleet(["kept", "joining"]);
  const [kept, joining] = net.machines as [Machine, Machine];
  // After the link every copy runs its own coordinator.
  kept.state.role = COORDINATES;
  joining.state.role = COORDINATES;
  return { ...net, kept, joining };
});

/** The joining copy as its machine lists it once the kept copy committed the link. */
const joiningProject = (
  joining: Machine,
  kept: Machine,
  keptRoot: string | undefined = KEPT_ROOT,
) =>
  ({
    id: joining.projectId,
    deletedAt: null,
    workspaceRoot: JOINING_ROOT,
    workspaceSettings: {
      logicalProject: {
        id: "logical-a",
        title: "Synthetic shared project",
        coordinatorId: "coordinator",
        members: [
          {
            environmentId: kept.environmentId,
            projectId: kept.projectId,
            coordinatorThreadId: ThreadId.make(`project-coordinator:${kept.projectId}`),
            ...(keptRoot === undefined ? {} : { workspaceRoot: keptRoot }),
          },
          {
            environmentId: joining.environmentId,
            projectId: joining.projectId,
            coordinatorThreadId: ThreadId.make(`project-coordinator:${joining.projectId}`),
            workspaceRoot: JOINING_ROOT,
            linkId: "link-fixture",
          },
        ],
      },
    },
  }) as unknown as Project;

/** The link's routine step on `joining`, over its real scheduler, runner and move. */
const moverOn = (joining: Machine, kept: Machine, keptRoot?: string) =>
  makeLinkMove({
    projects: Effect.sync(() => [joiningProject(joining, kept, keptRoot)]),
    selfEnvironmentId: Effect.succeed(joining.environmentId),
    label: (id) => Effect.succeed(id.replace(/^env-/, "")),
    routines: joining.service.list().pipe(Effect.map((listed) => listed.tasks)),
    record: (taskId) => joining.runner.records.read(taskId),
    settle: joining.runner.reconcile({ force: true }),
    moveOut: joining.transfer!.moveOut,
    pauseHere: joining.transfer!.pauseHere,
    linkPause: makeLinkPauseMarker(joining.sql),
  });

const listed = (machine: Machine) =>
  machine.service.list().pipe(
    Effect.map((result) => result.tasks.find((task) => task.id === "routine")),
    Effect.orDie,
  );

const seedOnJoining = (joining: Machine) =>
  joining.seed({
    prompt: `Summarise ${JOINING_ROOT}/reports and post the digest.`,
    brief: {
      inputs: [
        { label: "Dashboard", location: "https://dashboard.example.test/weekly" },
        { label: "Reports", location: `${JOINING_ROOT}/reports` },
        { label: "Shared drive", location: "/fixture/elsewhere/drive" },
      ],
      output: `${JOINING_ROOT}/digests/{period}.md`,
      prepareOnly: false,
    },
  });

const move = (joining: Machine, kept: Machine) => ({
  projectId: joining.projectId,
  target: kept.environmentId,
  routineId: "routine",
  choice: "move" as const,
});

const enabledOn = (machine: Machine) =>
  machine.row.pipe(Effect.map((row) => row !== undefined && row.enabled === 1));

describe("project link routine moves", () => {
  it.effect("AC-02: a moved routine is staged, paused here, then turned on there once", () =>
    Effect.gen(function* () {
      const { kept, joining, network, everyoneLooks, fires } = yield* linked;
      const task: ScheduledTask = yield* seedOnJoining(joining);
      // Both copies are read at every step of the move: never on together.
      const bothOn: Array<string> = [];
      const check = (_from: string, _to: string, op: string) =>
        Effect.gen(function* () {
          if ((yield* enabledOn(kept)) && (yield* enabledOn(joining))) bothOn.push(op);
        });
      network.before = check;
      network.during = check;

      const result = yield* moverOn(joining, kept)(move(joining, kept));
      network.before = undefined;
      network.during = undefined;

      assert.equal(result.outcome, "moved");
      assert.deepEqual(bothOn, []);
      assert.equal(network.log.filter((entry) => entry.endsWith(":runner-enable")).length, 1);
      assert.deepEqual(
        network.log.filter((entry) => /runner-(stage|enable)/.test(entry)),
        ["joining>kept:runner-stage", "joining>kept:runner-enable"],
      );
      assert.isTrue(yield* enabledOn(kept));
      assert.isFalse(yield* enabledOn(joining));
      assert.equal((yield* joining.row)?.last_run_error, linkMovedNote("kept"));
      const here = yield* joining.record;
      assert.equal(here?.state, "disarmed");
      assert.equal(here?.runnerEnvironmentId, kept.environmentId);
      // The owner's link approval is recorded on the move.
      assert.equal(
        (here?.operation as { readonly consent?: string } | null)?.consent,
        "project-link:link-fixture",
      );
      assert.equal((yield* kept.record)?.state, "settled");
      assert.equal((yield* kept.record)?.operationId, here?.operationId);

      // AC-04: the joining copy's folder is the kept copy's folder there.
      const there = yield* listed(kept);
      assert.equal(there?.prompt, `Summarise ${KEPT_ROOT}/reports and post the digest.`);
      assert.equal(there?.brief?.inputs[1]?.location, `${KEPT_ROOT}/reports`);
      assert.equal(there?.brief?.output, `${KEPT_ROOT}/digests/{period}.md`);
      assert.equal((yield* listed(joining))?.prompt, task.prompt);

      // AC-05: what to set up on the kept machine, from the routine's brief.
      assert.equal(result.setup.length, 2);
      assert.match(result.setup[0]!, /Dashboard .*on kept, signed in/);
      assert.match(result.setup[1]!, /Shared drive .*must be on kept/);

      // One run of the next due slot, on the kept machine.
      yield* kept.makeDue(DUE);
      yield* joining.makeDue(DUE);
      yield* everyoneLooks;
      assert.equal(fires(), 1);
      assert.equal(kept.fires(), 1);

      // Asked again (the dialog reopened): nothing more is sent.
      const sent = network.log.length;
      assert.equal((yield* moverOn(joining, kept)(move(joining, kept))).outcome, "moved");
      assert.equal(network.log.length, sent);
    }),
  );

  it.effect("AC-03: a refused move leaves the routine paused here, and Try again moves it", () =>
    Effect.gen(function* () {
      const { kept, joining, network } = yield* linked;
      yield* seedOnJoining(joining);
      // The kept machine does not list the joining copy yet: it refuses the stage.
      kept.state.unlinked.add(joining.environmentId);
      const refused = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(refused.outcome, "failed");
      assert.match(refused.detail, /paused here until it moves/);
      assert.isFalse(yield* enabledOn(joining));
      assert.equal((yield* joining.row)?.last_run_error, linkPausedNote("kept"));
      assert.isUndefined(yield* listed(kept));

      kept.state.unlinked.clear();
      const again = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(again.outcome, "moved");
      assert.isTrue(yield* enabledOn(kept));
      assert.isFalse(yield* enabledOn(joining));
      assert.equal(network.log.filter((entry) => entry.endsWith(":runner-enable")).length, 1);
    }),
  );

  it.effect("AC-03: Try again moves a paused routine from off, never turning it on here", () =>
    Effect.gen(function* () {
      const { kept, joining, network, everyoneLooks, fires } = yield* linked;
      yield* seedOnJoining(joining);
      kept.state.unlinked.add(joining.environmentId);
      assert.equal((yield* moverOn(joining, kept)(move(joining, kept))).outcome, "failed");
      kept.state.unlinked.clear();

      const onHere: Array<string> = [];
      const check = (_from: string, _to: string, op: string) =>
        Effect.gen(function* () {
          if (yield* enabledOn(joining)) onHere.push(op);
        });
      network.before = check;
      network.during = check;
      const again = yield* moverOn(joining, kept)(move(joining, kept));
      network.before = undefined;
      network.during = undefined;
      assert.equal(again.outcome, "moved");
      assert.deepEqual(onHere, []);
      assert.isFalse(yield* enabledOn(joining));
      // It arrives with a next run, as if turned on now, and runs once, there.
      assert.isTrue(yield* enabledOn(kept));
      assert.isNotNull((yield* kept.row)?.next_run_at);
      yield* kept.makeDue(DUE);
      yield* everyoneLooks;
      assert.equal(fires(), 1);
      assert.equal(kept.fires(), 1);
    }),
  );

  it.effect("a routine its owner turned on and off again after the link paused it stays off", () =>
    Effect.gen(function* () {
      const { kept, joining, network } = yield* linked;
      const task = yield* seedOnJoining(joining);
      kept.state.unlinked.add(joining.environmentId);
      assert.equal((yield* moverOn(joining, kept)(move(joining, kept))).outcome, "failed");
      kept.state.unlinked.clear();
      // The note still reads as the link's, but the owner chose off.
      yield* joining.service.setEnabled({ id: task.id, enabled: true }).pipe(Effect.orDie);
      yield* joining.service.setEnabled({ id: task.id, enabled: false }).pipe(Effect.orDie);
      assert.equal((yield* joining.row)?.last_run_error, linkPausedNote("kept"));

      const again = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(again.outcome, "failed");
      assert.match(again.detail, /off on this machine/);
      assert.isFalse(yield* enabledOn(joining));
      assert.isUndefined(yield* listed(kept));
      assert.isFalse(network.log.some((entry) => /runner-(stage|enable)/.test(entry)));
    }),
  );

  it.effect("two moves of one routine at once: one moves it, the other waits its turn", () =>
    Effect.gen(function* () {
      const { kept, joining, network } = yield* linked;
      yield* seedOnJoining(joining);
      const mover = moverOn(joining, kept);
      const [first, second] = yield* Effect.all(
        [mover(move(joining, kept)), mover(move(joining, kept))],
        { concurrency: "unbounded" },
      );
      assert.deepEqual([first.outcome, second.outcome].sort(), ["failed", "moved"]);
      assert.match((first.outcome === "failed" ? first : second).detail, /being moved right now/);
      assert.equal(network.log.filter((entry) => entry.endsWith(":runner-enable")).length, 1);
      assert.isTrue(yield* enabledOn(kept));
      assert.isFalse(yield* enabledOn(joining));
      assert.equal((yield* joining.record)?.state, "disarmed");
    }),
  );

  it.effect("Leave off on a routine another machine already runs says so and changes nothing", () =>
    Effect.gen(function* () {
      const { kept, joining } = yield* linked;
      yield* seedOnJoining(joining);
      assert.equal((yield* moverOn(joining, kept)(move(joining, kept))).outcome, "moved");
      const result = yield* moverOn(joining, kept)({ ...move(joining, kept), choice: "leave-off" });
      assert.equal(result.outcome, "stays");
      assert.match(result.detail, /Not changed: kept runs it/);
      assert.isTrue(yield* enabledOn(kept));
    }),
  );

  it.effect("AC-03: an enable that was not answered is finished under the same operation id", () =>
    Effect.gen(function* () {
      const { kept, joining, network, everyoneLooks, fires } = yield* linked;
      yield* seedOnJoining(joining);
      // The kept machine turns it on; its answer is lost.
      network.dropAnswer = (_from, _to, op) => op === "runner-enable";
      const unanswered = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(unanswered.outcome, "failed");
      assert.isFalse(yield* enabledOn(joining));
      const first = yield* joining.record;
      assert.equal(first?.state, "moving");

      network.dropAnswer = () => false;
      const again = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(again.outcome, "moved");
      assert.equal((yield* joining.record)?.operationId, first?.operationId);
      // The try again asked where the move stood; it never sent a second enable.
      assert.equal(network.log.filter((entry) => entry.endsWith(":runner-enable")).length, 1);
      yield* kept.makeDue(DUE);
      yield* everyoneLooks;
      assert.equal(fires(), 1);
    }),
  );

  it.effect("AC-03: a kept machine that is offline at the enable gets the same enable later", () =>
    Effect.gen(function* () {
      const { kept, joining, network } = yield* linked;
      yield* seedOnJoining(joining);
      network.before = (_from, _to, op) =>
        Effect.sync(() => {
          if (op === "runner-enable") network.offline.add("kept");
        });
      const cut = yield* moverOn(joining, kept)(move(joining, kept));
      network.before = undefined;
      assert.equal(cut.outcome, "failed");
      assert.isFalse(yield* enabledOn(joining));
      assert.isFalse(yield* enabledOn(kept));
      const first = yield* joining.record;

      network.offline.clear();
      const again = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(again.outcome, "moved");
      assert.equal((yield* kept.record)?.operationId, first?.operationId);
      assert.isTrue(yield* enabledOn(kept));
      assert.isFalse(yield* enabledOn(joining));
    }),
  );

  it.effect("Leave off turns it off here and sends nothing", () =>
    Effect.gen(function* () {
      const { kept, joining, network } = yield* linked;
      yield* seedOnJoining(joining);
      const result = yield* moverOn(joining, kept)({ ...move(joining, kept), choice: "leave-off" });
      assert.equal(result.outcome, "left-off");
      assert.isFalse(yield* enabledOn(joining));
      assert.equal((yield* joining.row)?.last_run_error, linkLeftOffNote("kept"));
      assert.isFalse(network.log.some((entry) => /runner-(stage|enable)/.test(entry)));
      // Leave off is not a paused move: Move does not turn it back on.
      const moved = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(moved.outcome, "failed");
      assert.isFalse(yield* enabledOn(joining));
      assert.isUndefined(yield* listed(kept));
    }),
  );

  it.effect("the service's own link step moves a routine", () =>
    Effect.gen(function* () {
      const { kept, joining } = yield* linked;
      yield* joining.seed();
      // The testkit's machines record no folders: nothing to rewrite, and a note says so.
      const result = yield* joining.transfer!.moveForLink(move(joining, kept));
      assert.equal(result.outcome, "moved");
      assert.isTrue(yield* enabledOn(kept));
      assert.isFalse(yield* enabledOn(joining));
    }),
  );

  it.effect("a machine that is not a member of the link is refused", () =>
    Effect.gen(function* () {
      const { kept, joining } = yield* linked;
      yield* joining.seed();
      const refused = yield* moverOn(
        joining,
        kept,
      )({ ...move(joining, kept), target: EnvironmentId.make("env-elsewhere") }).pipe(Effect.flip);
      assert.equal(refused.code, "not_linked");
      const missing = yield* moverOn(
        joining,
        kept,
      )({ ...move(joining, kept), projectId: ProjectId.make("project-elsewhere") }).pipe(
        Effect.flip,
      );
      assert.equal(missing.code, "not_found");
      assert.isTrue(yield* enabledOn(joining));
    }),
  );
});

describe("AC-04 webhook routines and folders", () => {
  it.effect("a webhook routine is never moved", () =>
    Effect.gen(function* () {
      const posts: Array<string> = [];
      const webhook = {
        id: "hook",
        projectId: "project-joining",
        enabled: true,
        ownThread: true,
        schedule: { type: "webhook" },
      } as unknown as ScheduledTask;
      const mover = makeLinkMove({
        projects: Effect.succeed([
          {
            id: "project-joining",
            deletedAt: null,
            workspaceRoot: JOINING_ROOT,
            workspaceSettings: {
              logicalProject: {
                members: [
                  { environmentId: "env-kept", projectId: "project-kept" },
                  { environmentId: "env-joining", projectId: "project-joining" },
                ],
              },
            },
          } as unknown as Project,
        ]),
        selfEnvironmentId: Effect.succeed("env-joining"),
        label: () => Effect.succeed("kept"),
        routines: Effect.succeed([webhook]),
        record: () => Effect.succeed(null),
        settle: Effect.void,
        moveOut: () =>
          Effect.sync(() => posts.push("move")).pipe(
            Effect.as({ kind: "failed", detail: "", offHere: false } as const),
          ),
        pauseHere: (id) => Effect.sync(() => posts.push(`pause:${id}`)).pipe(Effect.as(true)),
        linkPause: { read: () => Effect.succeed(null), mark: () => Effect.succeed(true) },
      });
      const result = yield* mover({
        projectId: ProjectId.make("project-joining"),
        target: EnvironmentId.make("env-kept"),
        routineId: "hook",
        choice: "move",
      });
      assert.equal(result.outcome, "stays");
      assert.match(result.detail, /webhook/);
      assert.deepEqual(posts, []);
    }),
  );

  it("rewrites the folder and paths inside it, never a longer folder name", () => {
    assert.equal(
      rewriteFolder(
        `cd ${JOINING_ROOT} && cat ${JOINING_ROOT}/a.md ${JOINING_ROOT}-old/b`,
        JOINING_ROOT,
        `${KEPT_ROOT}/`,
      ),
      `cd ${KEPT_ROOT} && cat ${KEPT_ROOT}/a.md ${JOINING_ROOT}-old/b`,
    );
    assert.equal(rewriteFolder("nothing here", JOINING_ROOT, KEPT_ROOT), "nothing here");
    assert.equal(rewriteFolder("/ stays", "/", KEPT_ROOT), "/ stays");
    // A path that only ends in the folder, under another root or in a URL, is not it.
    assert.equal(
      rewriteFolder(
        `compare /backup${JOINING_ROOT}/a.md and https://x.test${JOINING_ROOT}/help, "${JOINING_ROOT}/c"`,
        JOINING_ROOT,
        KEPT_ROOT,
      ),
      `compare /backup${JOINING_ROOT}/a.md and https://x.test${JOINING_ROOT}/help, "${KEPT_ROOT}/c"`,
    );
  });

  it("names what to set up when the kept folder is unknown", () => {
    const copy = { prompt: "Open Chrome and read the report.", brief: null };
    const notes = setupNotes(
      adaptToKept(JOINING_ROOT, undefined)(copy as never),
      "kept",
      undefined,
    );
    assert.equal(notes.length, 2);
    assert.match(notes[0]!, /browser/);
    assert.match(notes[1]!, /did not record its project folder/);
  });
});

describe("a kept machine whose work grant leaves routines out", () => {
  const noRoutines = (joining: Machine) => ({
    coordinatorEnvironmentId: joining.environmentId,
    projects: { kind: "all" as const },
    accounts: { kind: "all" as const },
    owner: "self" as const,
    hopLimit: 2,
    revoked: false,
    routines: false,
    kind: "own" as const,
  });

  it.effect.each([
    ["no grant", () => null],
    ["Routines off", noRoutines],
  ] as const)("%s: the routine is paused here and the row names the setting", ([, grant]) =>
    Effect.gen(function* () {
      const { kept, joining, network } = yield* linked;
      yield* seedOnJoining(joining);
      network.grant = () => grant(joining) as never;
      const refused = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(refused.outcome, "failed");
      assert.match(
        refused.detail,
        /on kept: Settings > Machines > Who can run work here > Routines/,
      );
      assert.match(refused.detail, /paused here until it moves/);
      assert.isFalse(yield* enabledOn(joining));
      assert.isUndefined(yield* listed(kept));
      assert.isFalse(network.log.some((entry) => /runner-(stage|enable)/.test(entry)));

      // The owner turns Routines on for this machine there: Try again moves it.
      network.grant = undefined;
      const again = yield* moverOn(joining, kept)(move(joining, kept));
      assert.equal(again.outcome, "moved");
      assert.isTrue(yield* enabledOn(kept));
      assert.isFalse(yield* enabledOn(joining));
    }),
  );

  it.effect("Leave off works while the runner is still being settled", () =>
    Effect.gen(function* () {
      const { kept, joining, network } = yield* linked;
      yield* seedOnJoining(joining);
      network.dropAnswer = (_from, _to, op) => op === "runner-disarm";
      yield* joining.runner.reconcile({ force: true });
      network.dropAnswer = () => false;
      assert.notEqual((yield* joining.record)?.state, "settled");
      const result = yield* moverOn(joining, kept)({ ...move(joining, kept), choice: "leave-off" });
      assert.equal(result.outcome, "left-off");
      assert.isFalse(yield* enabledOn(joining));
    }),
  );
});

describe("the joining copy after a real prepare, accept and commit", () => {
  afterEach(removeCheckouts);

  it("lists both members with their folders, so the move finds its target and rewrites the folder", async () => {
    const pair = legacyPair();
    await link(pair);
    const joined = pair.m3.projects.get(pair.joining.projectId)!;
    const members = joined.workspaceSettings!.logicalProject!.members;
    expect(members.map((member) => [member.environmentId, member.workspaceRoot])).toEqual([
      [pair.kept.environmentId, pair.kept.workspaceRoot],
      [pair.joining.environmentId, joined.workspaceRoot],
    ]);
    const sent: Array<string> = [];
    const mover = makeLinkMove({
      projects: Effect.succeed([joined]),
      selfEnvironmentId: Effect.succeed(pair.joining.environmentId),
      label: () => Effect.succeed("M4"),
      routines: Effect.succeed([
        {
          id: "routine",
          projectId: joined.id,
          title: "Nightly",
          prompt: `Read ${joined.workspaceRoot}/notes.md`,
          enabled: true,
          ownThread: true,
          schedule: { type: "interval", everyMs: 60_000 },
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "fixture" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: null,
          creationSource: "server",
          lastRunError: null,
          nextRunAt: null,
        } as unknown as ScheduledTask,
      ]),
      record: () => Effect.succeed({ state: "settled" } as never),
      settle: Effect.void,
      moveOut: (input) =>
        Effect.sync(() => {
          sent.push(input.target, (input.adapt ?? ((copy) => copy))(input.copy).prompt);
          return { kind: "moved", targetProjectId: pair.kept.projectId, detail: "" } as const;
        }),
      pauseHere: () => Effect.succeed(true),
      linkPause: { read: () => Effect.succeed(null), mark: () => Effect.succeed(true) },
    });
    const result = await Effect.runPromise(
      mover({
        projectId: joined.id,
        target: pair.kept.environmentId,
        routineId: "routine",
        choice: "move",
      }),
    );
    expect(result.outcome).toBe("moved");
    expect(sent).toEqual([pair.kept.environmentId, `Read ${pair.kept.workspaceRoot}/notes.md`]);
  });
});
