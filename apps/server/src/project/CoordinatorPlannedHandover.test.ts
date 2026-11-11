/**
 * Away mode's planned coordinator handover (1267 T-04, AC-05). The M4
 * coordinates EasyChamp and Ministorm holds a linked copy; each has its own
 * ProjectLink over in-memory projects whose writes follow the real ownership
 * rules. The handover call crosses a stub network that encodes and decodes
 * every body as the wire does. After every step the test checks that the
 * two copies are never both active.
 */
import {
  type AwayHandoverResult,
  CoordinatorRoutineCopy,
  EnvironmentId,
  type Project,
  type ProjectId,
  type ProjectLinkError,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { projectStatus } from "../away/AwayIntents.ts";
import { AwayPeerError } from "../away/awayPeerCall.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import {
  claimTargets,
  makeHandoverReceiver,
  makePlannedHandover,
  PlannedHandoverRequest,
  PlannedHandoverResponse,
  type RoutineRunState,
} from "./CoordinatorPlannedHandover.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectLink from "./ProjectLink.ts";
import { checkout, machine, removeCheckouts } from "./ProjectLink.testkit.ts";

afterEach(() => removeCheckouts());

const overWire =
  <T>(encode: (value: T) => unknown, decode: (value: unknown) => T) =>
  (value: T) =>
    decode(JSON.parse(JSON.stringify(encode(value))));
const requestWire = overWire(
  Schema.encodeSync(PlannedHandoverRequest),
  Schema.decodeUnknownSync(PlannedHandoverRequest),
);
const answerWire = overWire(
  Schema.encodeSync(PlannedHandoverResponse),
  Schema.decodeUnknownSync(PlannedHandoverResponse),
);

const decodeRoutine = Schema.decodeUnknownSync(CoordinatorRoutineCopy);

const callerFrom = (environment: string): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make(environment),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make(environment),
    projects: { kind: "linked" },
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

const isActive = (project: Project | undefined) =>
  project !== undefined &&
  (project.workspaceSettings?.coordinatorBinding === undefined ||
    project.workspaceSettings.coordinatorBinding.state === "active");

const pair = Effect.gen(function* () {
  const m4 = machine("m4");
  const ms = machine("ministorm");
  const roots = {
    m4: m4.add("easychamp-m4", checkout("git@github.com:anton/sw-easychamp.git")).workspaceRoot,
    ms: ms.add("easychamp-ms", checkout("https://github.com/anton/sw-easychamp.git")).workspaceRoot,
  };
  const members = {
    m4: { ...m4.member("easychamp-m4"), workspaceRoot: roots.m4 },
    ms: { ...ms.member("easychamp-ms"), workspaceRoot: roots.ms },
  };
  /** One machine's ProjectLink, built as the testkit's `run` builds it, per call. */
  const on =
    (layer: typeof m4.layer) =>
    <A>(use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, ProjectLinkError>) =>
      Effect.flatMap(ProjectLink.ProjectLink, use).pipe(
        Effect.provide(Layer.merge(layer, ProjectAdmission.layer)),
      );
  const link4 = on(m4.layer);
  const linkS = on(ms.layer);

  // Link Ministorm's copy to the M4's, as the app does: prepare, accept, commit.
  const operationId = "11111111-1111-4111-8111-111111111111";
  const prepared = yield* link4((service) =>
    service.prepare({ operationId, projectId: members.m4.projectId, joining: members.ms }),
  );
  const accepted = yield* linkS((service) =>
    service.accept({
      operationId,
      projectId: members.ms.projectId,
      kept: prepared.kept,
      logicalProject: prepared.logicalProject,
      coordinatorBinding: prepared.coordinatorBinding,
      keptFingerprint: prepared.fingerprint,
    }),
  );
  yield* link4((service) =>
    service.commit({
      operationId,
      projectId: members.m4.projectId,
      joining: accepted.member,
      notes: [],
    }),
  );

  const source = () => m4.projects.get(members.m4.projectId);
  const target = () => ms.projects.get(members.ms.projectId);
  /** Every state the two copies were seen in, checked against two active coordinators. */
  const seen: Array<{ step: string; m4: boolean; ms: boolean }> = [];
  const check = (step: string) =>
    Effect.sync(() => {
      const state = { step, m4: isActive(source()), ms: isActive(target()) };
      seen.push(state);
      expect(state.m4 && state.ms, `both copies active at ${step}`).toBe(false);
    });

  const kept: Array<{ step: string; targetActive: boolean; ids: ReadonlyArray<string> }> = [];
  const receiver = makeHandoverReceiver({
    selfEnvironmentId: "ministorm",
    loadProject: (projectId) => Effect.sync(() => ms.projects.get(projectId)),
    takeover: (input) =>
      linkS((service) => service.plannedTakeover(input)).pipe(Effect.tap(() => check("takeover"))),
    keepRoutines: (input) =>
      Effect.sync(
        () =>
          void kept.push({
            step: "routines",
            targetActive: isActive(target()),
            ids: input.routines.map((routine) => routine.id),
          }),
      ),
    applyRunStates: (_projectId, states) =>
      Effect.sync(
        () =>
          void kept.push({
            step: "run-states",
            targetActive: isActive(target()),
            ids: states.map((state) => state.id),
          }),
      ),
    adopt: (input) =>
      Effect.succeed({ unclaimed: input.claimOn?.filter((env) => env === "offline") ?? [] }),
  });

  /** How the network behaves for the next sends. */
  const network = { answers: [] as Array<"deliver" | "refuse" | "lose" | "lose-after">, sent: 0 };
  const send = (
    _environmentId: EnvironmentId,
    request: PlannedHandoverRequest,
  ): Effect.Effect<PlannedHandoverResponse, AwayPeerError> =>
    Effect.gen(function* () {
      network.sent += 1;
      yield* check("send");
      const mode = network.answers.shift() ?? "deliver";
      if (mode === "lose")
        return yield* new AwayPeerError({
          message: "Ministorm did not answer.",
          refused: false,
          uncertain: true,
        });
      if (mode === "refuse")
        return yield* new AwayPeerError({
          message: "Ministorm: This machine did not take over",
          refused: true,
          uncertain: false,
          status: 409,
        });
      const answer = yield* receiver
        .receive(callerFrom("m4"), requestWire(request))
        .pipe(
          Effect.mapError(
            (refusal) =>
              new AwayPeerError({ message: refusal.message, refused: true, uncertain: false }),
          ),
        );
      // Delivered and acted on, but the answer never came back.
      if (mode === "lose-after")
        return yield* new AwayPeerError({
          message: "Ministorm did not answer.",
          refused: false,
          uncertain: true,
        });
      return answerWire(answer);
    });

  const reach = { ministorm: true };
  const statusAsks = { count: 0, answers: true };
  const released: string[] = [];
  const routineRuns: ReadonlyArray<RoutineRunState> = [
    {
      id: "instagram-post",
      nextRunAt: "2026-11-09T18:00:00.000Z",
      lastRunAt: "2026-11-09T12:00:00.000Z",
      runCount: 14,
      onceGeneration: 0,
    },
  ];
  const handover = makePlannedHandover({
    loadProject: (projectId) => Effect.sync(() => m4.projects.get(projectId)),
    giveWay: (input) =>
      link4((service) => service.plannedGiveWay(input)).pipe(Effect.tap(() => check("give-way"))),
    revert: (input) =>
      link4((service) => service.plannedRevert(input)).pipe(Effect.tap(() => check("revert"))),
    reachable: (environmentId) =>
      Effect.succeed(environmentId === "ministorm" ? reach.ministorm : false),
    labelOf: (environmentId) =>
      Effect.succeed(environmentId === "ministorm" ? "Ministorm" : "That machine"),
    gather: () =>
      Effect.succeed({
        shadowWorkers: [],
        routines: [
          decodeRoutine({
            id: "instagram-post",
            title: "Post to Instagram",
            prompt: "Post the next reel.",
            enabled: true,
            schedule: { type: "interval", everyMs: 6 * 3_600_000 },
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "fixture" },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "user",
          }),
        ],
        runStates: routineRuns,
      }).pipe(Effect.tap(() => check("gather"))),
    send,
    releaseWorkers: (_project, reason) => Effect.sync(() => void released.push(reason)),
    // Ministorm's status route, read from its copy's binding.
    status: (_environmentId, projectId) =>
      Effect.sync(() => {
        statusAsks.count += 1;
        if (!statusAsks.answers) return undefined;
        const status = projectStatus([...ms.projects.values()], "ministorm", "m4", projectId);
        return {
          takenOver: status.takenOver,
          ...(status.epoch === undefined ? {} : { epoch: status.epoch }),
        };
      }).pipe(Effect.tap(() => check("status"))),
    statusPause: Effect.void,
  });
  const handOver = (
    input: {
      readonly targetEnvironmentId?: string;
      readonly operationId?: string;
      readonly resumeOnly?: boolean;
    } = {},
  ) =>
    handover
      .handOver({
        projectId: members.m4.projectId as ProjectId,
        targetEnvironmentId: EnvironmentId.make(input.targetEnvironmentId ?? "ministorm"),
        reason: "away",
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        ...(input.resumeOnly === undefined ? {} : { resumeOnly: input.resumeOnly }),
      })
      .pipe(Effect.tap(() => check("result")));
  yield* check("linked");
  return {
    m4,
    ms,
    members,
    source,
    target,
    seen,
    kept,
    network,
    reach,
    released,
    handOver,
    statusAsks,
  };
});

const binding = (project: Project | undefined) => project?.workspaceSettings?.coordinatorBinding;

describe("planned coordinator handover", () => {
  it.effect("hands the coordinator to the target and never leaves both active", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      const before = binding(fleet.source())?.epoch ?? 0;
      const result: AwayHandoverResult = yield* fleet.handOver();
      expect(result.outcome).toBe("handed-over");
      expect(result.epoch).toBe(before + 1);
      expect(binding(fleet.source())).toMatchObject({
        state: "transferred",
        epoch: before + 1,
        successor: { environmentId: "ministorm" },
      });
      expect(binding(fleet.target())).toMatchObject({
        state: "active",
        epoch: before + 1,
        predecessor: { environmentId: "m4" },
        takenOverBy: "person",
      });
      // Give way first: at the moment the target was asked, neither was active.
      expect(fleet.seen.find((state) => state.step === "send")).toMatchObject({
        m4: false,
        ms: false,
      });
      // What travels is gathered after this copy gave way, when it no longer takes changes.
      expect(fleet.seen.map((state) => state.step).slice(1, 3)).toEqual(["give-way", "gather"]);
      expect(fleet.seen.find((state) => state.step === "gather")?.m4).toBe(false);
      expect(fleet.released).toEqual(["Handed to Ministorm for Away."]);
      // Routines and their run state were kept before the target coordinated.
      expect(fleet.kept).toEqual([
        { step: "routines", targetActive: false, ids: ["instagram-post"] },
        { step: "run-states", targetActive: false, ids: ["instagram-post"] },
      ]);
    }),
  );

  it.effect("replays by its operation id, so a retry changes nothing", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      const first = yield* fleet.handOver();
      const second = yield* fleet.handOver();
      expect(second).toEqual({ ...first });
      expect(binding(fleet.target())?.epoch).toBe(first.epoch);
      expect(fleet.kept.filter((entry) => entry.step === "routines")).toHaveLength(1);
    }),
  );

  it.effect("takes the coordinator back here when the target refuses", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      fleet.network.answers.push("refuse");
      const result = yield* fleet.handOver();
      expect(result.outcome).toBe("failed");
      expect(result.detail).toContain("This machine coordinates it again.");
      expect(isActive(fleet.source())).toBe(true);
      expect(isActive(fleet.target())).toBe(false);
      expect(fleet.released).toEqual([]);
    }),
  );

  it.effect("tries once more without an answer, and the target replays", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      fleet.network.answers.push("lose-after");
      const result = yield* fleet.handOver();
      expect(result.outcome).toBe("handed-over");
      expect(fleet.network.sent).toBe(2);
      expect(isActive(fleet.target())).toBe(true);
      expect(isActive(fleet.source())).toBe(false);
    }),
  );

  it.effect("leaves no copy active while in doubt, and finishes on the next call", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      fleet.network.answers.push("lose", "lose");
      const doubt = yield* fleet.handOver();
      expect(doubt.outcome).toBe("in-doubt");
      expect(doubt.detail).toContain("did not confirm");
      expect(doubt.detail).toContain("Leave or Bring back finishes it sooner");
      expect(isActive(fleet.source())).toBe(false);
      expect(isActive(fleet.target())).toBe(false);
      const finished = yield* fleet.handOver();
      expect(finished.outcome).toBe("handed-over");
      expect(isActive(fleet.target())).toBe(true);
    }),
  );

  it.effect("never reverts after an unanswered call, even if the retry is refused (#7)", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      // The first call may have reached Ministorm; the retry is refused.
      fleet.network.answers.push("lose", "refuse");
      const doubt = yield* fleet.handOver();
      expect(doubt.outcome).toBe("in-doubt");
      expect(fleet.statusAsks.count).toBe(1);
      // In doubt: no copy coordinates, never two, and this copy did not take it back.
      expect(isActive(fleet.source())).toBe(false);
      expect(isActive(fleet.target())).toBe(false);
      expect(fleet.seen.some((state) => state.step === "revert")).toBe(false);
      const finished = yield* fleet.handOver();
      expect(finished.outcome).toBe("handed-over");
      expect(isActive(fleet.target())).toBe(true);
      expect(isActive(fleet.source())).toBe(false);
    }),
  );

  it.effect("an unanswered call that took over is confirmed by the target's status (#7)", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      // Delivered and taken over, the answer lost; the retry is refused on the way.
      fleet.network.answers.push("lose-after", "refuse");
      const result = yield* fleet.handOver();
      expect(result.outcome).toBe("handed-over");
      expect(result.epoch).toBe(fleet.target()?.workspaceSettings?.coordinatorBinding?.epoch);
      expect(isActive(fleet.target())).toBe(true);
      expect(isActive(fleet.source())).toBe(false);
      expect(fleet.released).toEqual(["Handed to Ministorm for Away."]);
    }),
  );

  it.effect("asks the target a few times when its status does not answer (#7)", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      fleet.statusAsks.answers = false;
      fleet.network.answers.push("lose", "lose");
      const doubt = yield* fleet.handOver();
      expect(doubt.outcome).toBe("in-doubt");
      expect(fleet.statusAsks.count).toBe(3);
      expect(isActive(fleet.source())).toBe(false);
    }),
  );

  it.effect("an in-doubt handover the target never got reverts here on the next try (N1)", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      fleet.network.answers.push("lose", "lose");
      const doubt = yield* fleet.handOver();
      expect(doubt.outcome).toBe("in-doubt");
      expect(doubt.operationId).toBeDefined();
      expect(doubt.detail).toContain("If Ministorm confirms it never received it");
      // The replay is refused and Ministorm's status says it never took over.
      fleet.network.answers.push("refuse");
      const finished = yield* fleet.handOver({
        operationId: doubt.operationId!,
        resumeOnly: true,
      });
      expect(finished).toMatchObject({ outcome: "failed", reverted: true });
      expect(finished.detail).toBe(
        "Ministorm confirmed it never received the handover, so this machine coordinates this project again.",
      );
      expect(isActive(fleet.source())).toBe(true);
      expect(isActive(fleet.target())).toBe(false);
      // Asked again, it reports the revert and starts nothing.
      const sentBefore = fleet.network.sent;
      const again = yield* fleet.handOver({ operationId: doubt.operationId!, resumeOnly: true });
      expect(again).toMatchObject({ outcome: "failed", reverted: true });
      expect(fleet.network.sent).toBe(sentBefore);
    }),
  );

  it.effect(
    "finishing stays in doubt while the target is silent or a call goes unanswered (N1)",
    () =>
      Effect.gen(function* () {
        const fleet = yield* pair;
        fleet.network.answers.push("lose", "lose");
        const doubt = yield* fleet.handOver();
        fleet.reach.ministorm = false;
        const silent = yield* fleet.handOver({ operationId: doubt.operationId!, resumeOnly: true });
        expect(silent.outcome).toBe("in-doubt");
        expect(isActive(fleet.source())).toBe(false);
        fleet.reach.ministorm = true;
        // This call's first try goes unanswered: never revert, even if the retry is refused.
        fleet.network.answers.push("lose", "refuse");
        const unsure = yield* fleet.handOver({ operationId: doubt.operationId!, resumeOnly: true });
        expect(unsure.outcome).toBe("in-doubt");
        expect(isActive(fleet.source())).toBe(false);
        expect(fleet.seen.some((state) => state.step === "revert")).toBe(false);
      }),
  );

  it.effect("resumeOnly never starts a new handover from an active copy (N1)", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      const result = yield* fleet.handOver({ operationId: "handover:other", resumeOnly: true });
      expect(result.outcome).toBe("failed");
      expect(fleet.network.sent).toBe(0);
      expect(isActive(fleet.source())).toBe(true);
    }),
  );

  it.effect("changes nothing when the target is unreachable or holds no linked copy", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      fleet.reach.ministorm = false;
      const unreachable = yield* fleet.handOver();
      expect(unreachable).toMatchObject({ outcome: "failed" });
      expect(unreachable.detail).toContain("Nothing changed");
      const unlinked = yield* fleet.handOver({ targetEnvironmentId: "m1" });
      expect(unlinked.outcome).toBe("failed");
      expect(unlinked.detail).toContain("no linked copy");
      expect(isActive(fleet.source())).toBe(true);
      expect(fleet.network.sent).toBe(0);
    }),
  );

  it.effect("skips a project this machine no longer coordinates", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      yield* fleet.handOver();
      const again = yield* fleet.handOver({ targetEnvironmentId: "m1" });
      expect(again.outcome).toBe("skipped");
    }),
  );

  it.effect("the target refuses a handover from a machine other than the coordinator", () =>
    Effect.gen(function* () {
      const fleet = yield* pair;
      const project = fleet.target()!;
      const logicalProjectId = project.workspaceSettings!.logicalProject!.id;
      const exit = yield* Effect.exit(
        ProjectLink.ProjectLink.pipe(
          Effect.flatMap((link) =>
            link.plannedTakeover({
              projectId: fleet.members.ms.projectId,
              logicalProjectId,
              callerEnvironmentId: "m3",
              predecessor: fleet.members.m4,
              epoch: 9,
              operationId: "handover:x:9",
            }),
          ),
          Effect.provide(Layer.merge(fleet.ms.layer, ProjectAdmission.layer)),
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(isActive(fleet.target())).toBe(false);
    }),
  );
});

describe("claimTargets", () => {
  it("claims on worker machines and other copies, never itself or the predecessor", () => {
    expect(
      claimTargets(
        [{ environmentId: "m3" }, { environmentId: "m4" }],
        [{ environmentId: "m4" }, { environmentId: "ministorm" }, { environmentId: "m1" }],
        "ministorm",
        "m4",
      ),
    ).toEqual(["m3", "m1"]);
  });
});
