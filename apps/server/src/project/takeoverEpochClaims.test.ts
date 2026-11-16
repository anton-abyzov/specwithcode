import { EnvironmentId, ProjectTakeoverResult } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { FleetConfigReadError } from "../fleet/FleetTargets.ts";
import { RemoteMcpError } from "../fleet/RemoteStudioMcpClient.ts";
import { applyEpochClaim, epochAdmits, type WorkerEpochRecord } from "../fleet/WorkerEpochStore.ts";
import { legacyTrio, removeCheckouts } from "./ProjectLink.testkit.ts";
import {
  classifyTakeoverClaimError,
  makeTakeoverEpochClaims,
  readTakeoverClaim,
  TAKEOVER_CLAIM_BUDGET_MS,
  TAKEOVER_CLAIM_CONCURRENCY,
  TAKEOVER_CLAIM_TIMEOUT_MS,
  type TakeoverEpochClaimDeps,
} from "./takeoverEpochClaims.ts";

afterEach(removeCheckouts);

const encodeTakeoverResult = Schema.encodeSync(ProjectTakeoverResult);
const decodeTakeoverResult = Schema.decodeUnknownSync(ProjectTakeoverResult);
const asEnvironmentId = Schema.decodeUnknownSync(EnvironmentId);
const takeoverId = "44444444-4444-4444-8444-444444444444";
type Call = Parameters<TakeoverEpochClaimDeps["client"]["call"]>[0];
type Answer = (call: Call) => Effect.Effect<unknown, RemoteMcpError>;

/** This machine's list of machines: one line per environment, as the fleet file holds them. */
const fleet = (...environments: ReadonlyArray<string>): TakeoverEpochClaimDeps["targets"] => ({
  load: Effect.succeed({
    version: 1,
    machines: environments.map((environmentId) => ({
      id: `machine-${environmentId}`,
      label: environmentId.toUpperCase(),
      environmentId: environmentId as never,
      url: `https://${environmentId}.example`,
      scopes: [] as never,
    })),
  }),
});

/** A client that records every call and answers per machine. */
const recordingClient = (answers: Record<string, Answer>) => {
  const calls: Array<Call> = [];
  const client: TakeoverEpochClaimDeps["client"] = {
    call: (input) =>
      Effect.suspend(() => {
        calls.push(input);
        const answer = answers[input.machineId];
        return answer === undefined
          ? Effect.fail(new RemoteMcpError({ reason: "unknown_machine" }))
          : answer(input);
      }),
  };
  return { client, calls };
};

/** A worker machine's epoch store, run by the real claim rule under `claimedBy`. */
const workerMachine = (claimedBy: string, held?: WorkerEpochRecord) => {
  const state: { record: WorkerEpochRecord | undefined } = { record: held };
  const answer: Answer = (call) =>
    Effect.sync(() => {
      const claim = call.arguments as { logicalProjectId: string; epoch: number };
      const applied = applyEpochClaim(state.record, { ...claim, by: claimedBy });
      if (applied.next !== undefined) state.record = applied.next;
      return {
        logicalProjectId: claim.logicalProjectId,
        accepted: applied.accepted,
        epoch: applied.epoch,
        origins: [],
      };
    });
  return { state, answer };
};

const unreachable: Answer = () => Effect.fail(new RemoteMcpError({ reason: "unreachable" }));

/** The M1 copy takes over from the M4, which still lists the M3 as a member. */
const takenOverOnM1 = async () => {
  const trio = await legacyTrio();
  const taken = await trio.m1.run((service) =>
    service.takeover({ operationId: takeoverId, projectId: trio.third.projectId }),
  );
  return { trio, taken };
};

describe("takeover epoch claims", () => {
  it.effect("claims a person's takeover epoch on every other member machine, once each", () =>
    Effect.gen(function* () {
      const trio = yield* Effect.promise(legacyTrio);
      const m3 = workerMachine("m1");
      const { client, calls } = recordingClient({
        "machine-m4": unreachable,
        "machine-m3": m3.answer,
      });
      const claims = makeTakeoverEpochClaims({
        client,
        targets: fleet("m4", "m3", "m1"),
        selfEnvironmentId: Effect.succeed("m1"),
      });
      // The M1 copy takes over from the M4 as the RPC handler runs it: the takeover, then its claims.
      const result = yield* Effect.promise(() =>
        trio.m1.run((service) =>
          claims.takeover(
            service.takeover({ operationId: takeoverId, projectId: trio.third.projectId }),
          ),
        ),
      );
      expect(result).toMatchObject({ operationId: takeoverId, notesWritten: 0, replayed: false });
      expect(result.coordinatorBinding).toMatchObject({
        epoch: 1,
        state: "active",
        predecessor: trio.kept,
        takenOverBy: "person",
      });
      expect(result.epochClaims).toEqual([
        {
          machine: "m4",
          label: "M4",
          outcome: "unreachable",
          detail: "The machine is unavailable.",
        },
        { machine: "m3", label: "M3", outcome: "claimed" },
      ]);
      // One call per machine, never to this one, with the existing tool and nothing new in it.
      expect(calls).toEqual([
        {
          machineId: "machine-m4",
          tool: "studio_coordinator_claim_epoch",
          timeoutMs: TAKEOVER_CLAIM_TIMEOUT_MS,
          arguments: { logicalProjectId: trio.logicalProjectId, epoch: 1 },
        },
        {
          machineId: "machine-m3",
          tool: "studio_coordinator_claim_epoch",
          timeoutMs: TAKEOVER_CLAIM_TIMEOUT_MS,
          arguments: { logicalProjectId: trio.logicalProjectId, epoch: 1 },
        },
      ]);

      // On the reached worker machine the replaced coordinator no longer steers: it
      // names its old epoch, or none, and `assertCoordinatorEpoch` answers thread_fenced.
      expect(m3.state.record).toMatchObject({ epoch: 1, claimedBy: "m1" });
      expect(epochAdmits(m3.state.record, 0, "m4")).toBe(false);
      expect(epochAdmits(m3.state.record, undefined, "m4")).toBe(false);
      // Naming the new epoch does not help the old machine either; only the claimant steers at it.
      expect(epochAdmits(m3.state.record, 1, "m4")).toBe(false);
      expect(epochAdmits(m3.state.record, 1, "m1")).toBe(true);
      // The result fits the RPC's schema, so the report reaches the client.
      const wire = encodeTakeoverResult(result);
      expect(wire.epochClaims).toHaveLength(2);
    }),
  );

  it.effect("asks again when the takeover is replayed, and the same claim still stands", () =>
    Effect.gen(function* () {
      const { trio, taken } = yield* Effect.promise(takenOverOnM1);
      const m3 = workerMachine("m1");
      const answers: Record<string, Answer> = {
        "machine-m4": unreachable,
        "machine-m3": m3.answer,
      };
      const { client, calls } = recordingClient(answers);
      const claims = makeTakeoverEpochClaims({
        client,
        targets: fleet("m4", "m3"),
        selfEnvironmentId: Effect.succeed("m1"),
      });
      yield* claims.afterTakeover(taken);
      expect(calls).toHaveLength(2);

      // The old coordinator's machine is back; the person runs the same takeover again.
      const m4 = workerMachine("m1");
      answers["machine-m4"] = m4.answer;
      const replayed = yield* Effect.promise(() =>
        trio.m1.run((service) =>
          service.takeover({ operationId: takeoverId, projectId: trio.third.projectId }),
        ),
      );
      expect(replayed.replayed).toBe(true);
      const again = yield* claims.afterTakeover(replayed);
      expect(again.epochClaims).toEqual([
        { machine: "m4", label: "M4", outcome: "claimed" },
        { machine: "m3", label: "M3", outcome: "claimed" },
      ]);
      expect(calls).toHaveLength(4);
      expect(m4.state.record).toMatchObject({ epoch: 1, claimedBy: "m1" });
    }),
  );

  it.effect(
    "reports a machine that refuses, and one this machine has no link to, without failing",
    () =>
      Effect.gen(function* () {
        const { taken } = yield* Effect.promise(takenOverOnM1);
        // The M3 already follows another coordinator at a newer epoch.
        const m3 = workerMachine("m1", {
          logicalProjectId: taken.logicalProject.id,
          epoch: 5,
          claimedBy: "m9",
          claimedAt: "2026-11-16T00:00:00.000Z",
        });
        const { client, calls } = recordingClient({ "machine-m3": m3.answer });
        const claims = makeTakeoverEpochClaims({
          client,
          // No line for the M4 here.
          targets: fleet("m3"),
          selfEnvironmentId: Effect.succeed("m1"),
        });
        const result = yield* claims.afterTakeover(taken);
        expect(result.coordinatorBinding).toEqual(taken.coordinatorBinding);
        expect(result.epochClaims).toEqual([
          {
            machine: "m4",
            outcome: "unreachable",
            detail: "This machine has no link to that machine.",
          },
          {
            machine: "m3",
            label: "M3",
            outcome: "refused",
            detail: "That machine already follows a coordinator at epoch 5.",
          },
        ]);
        expect(calls.map((call) => call.machineId)).toEqual(["machine-m3"]);
        expect(m3.state.record).toMatchObject({ epoch: 5, claimedBy: "m9" });
      }),
  );

  it.effect("claims nowhere, and says so, when the list of machines cannot be read", () =>
    Effect.gen(function* () {
      const { taken } = yield* Effect.promise(takenOverOnM1);
      const { client, calls } = recordingClient({});
      const claims = makeTakeoverEpochClaims({
        client,
        targets: {
          load: Effect.fail(new FleetConfigReadError({ cause: new Error("unreadable") })),
        },
        selfEnvironmentId: Effect.succeed("m1"),
      });
      const result = yield* claims.afterTakeover(taken);
      expect(result.epochClaims?.map((entry) => [entry.machine, entry.outcome])).toEqual([
        ["m4", "unreachable"],
        ["m3", "unreachable"],
      ]);
      expect(result.epochClaims?.[0]?.detail).toBe(
        "This machine could not read its list of machines.",
      );
      expect(calls).toEqual([]);
    }),
  );

  it.effect("never fails the takeover when a claim call dies", () =>
    Effect.gen(function* () {
      const { taken } = yield* Effect.promise(takenOverOnM1);
      const { client } = recordingClient({
        "machine-m4": () => Effect.die(new Error("boom")),
        "machine-m3": () =>
          Effect.fail(
            new RemoteMcpError({
              reason: "tool_failure",
              remoteCode: "outside_grant_scope",
              remoteMessage: "Only another machine's coordinator claims a project here.",
            }),
          ),
      });
      const claims = makeTakeoverEpochClaims({
        client,
        targets: fleet("m4", "m3"),
        selfEnvironmentId: Effect.succeed("m1"),
      });
      const result = yield* claims.afterTakeover(taken);
      expect(result.operationId).toBe(takeoverId);
      expect(result.epochClaims).toEqual([
        { machine: "m4", label: "M4", outcome: "unreachable", detail: "The call failed." },
        {
          machine: "m3",
          label: "M3",
          outcome: "refused",
          detail: "Only another machine's coordinator claims a project here.",
        },
      ]);
    }),
  );

  it.effect("claims nowhere when the takeover itself is refused", () =>
    Effect.gen(function* () {
      const trio = yield* Effect.promise(legacyTrio);
      const { client, calls } = recordingClient({ "machine-m3": workerMachine("m4").answer });
      const claims = makeTakeoverEpochClaims({
        client,
        targets: fleet("m3", "m1"),
        selfEnvironmentId: Effect.succeed("m4"),
      });
      // The M4 coordinates already, so it has nothing to take over.
      const error = yield* Effect.promise(() =>
        trio.m4.fails(
          trio.m4.run((service) =>
            claims.takeover(
              service.takeover({ operationId: takeoverId, projectId: trio.kept.projectId }),
            ),
          ),
        ),
      );
      expect(error.code).toBe("not_member");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("answers within one budget however many machines stay silent", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const silent = Array.from(
        { length: TAKEOVER_CLAIM_CONCURRENCY + 2 },
        (_, index) => `w${index}`,
      );
      const claims = makeTakeoverEpochClaims({
        client: {
          call: (input) =>
            Effect.suspend(() => {
              calls.push(input.machineId);
              return Effect.never;
            }),
        },
        targets: fleet(...silent),
        selfEnvironmentId: Effect.succeed("m1"),
      });
      const fiber = yield* claims
        .claim({
          logicalProjectId: "logical:one",
          epoch: 4,
          members: silent.map((id) => ({ environmentId: asEnvironmentId(id) })),
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(TAKEOVER_CLAIM_BUDGET_MS));
      const result = yield* Fiber.join(fiber);
      expect(result.map((entry) => entry.outcome)).toEqual(silent.map(() => "unreachable"));
      // The machines past the first round are reported without a call that could outlast the budget.
      expect(result.map((entry) => entry.detail)).toEqual([
        ...Array.from(
          { length: TAKEOVER_CLAIM_CONCURRENCY },
          () => "The machine did not answer in time.",
        ),
        "The machine was not asked in time.",
        "The machine was not asked in time.",
      ]);
      expect(calls).toHaveLength(TAKEOVER_CLAIM_CONCURRENCY);
    }),
  );

  it.effect("gives up on a machine that never answers, after one attempt", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const claims = makeTakeoverEpochClaims({
        client: {
          call: (input) =>
            Effect.suspend(() => {
              calls.push(input.machineId);
              return input.machineId === "machine-m3"
                ? Effect.succeed({ accepted: true, epoch: 4 })
                : Effect.never;
            }),
        },
        targets: fleet("m4", "m3"),
        selfEnvironmentId: Effect.succeed("m1"),
      });
      const fiber = yield* claims
        .claim({
          logicalProjectId: "logical:one",
          epoch: 4,
          // Two copies on one machine are one claim; this machine is never asked.
          members: [
            { environmentId: asEnvironmentId("m4") },
            { environmentId: asEnvironmentId("m4") },
            { environmentId: asEnvironmentId("m3") },
            { environmentId: asEnvironmentId("m1") },
          ],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(TAKEOVER_CLAIM_BUDGET_MS));
      const result = yield* Fiber.join(fiber);
      expect(result).toEqual([
        {
          machine: "m4",
          label: "M4",
          outcome: "unreachable",
          detail: "The machine did not answer in time.",
        },
        { machine: "m3", label: "M3", outcome: "claimed" },
      ]);
      // Later time brings no second attempt.
      yield* TestClock.adjust(Duration.minutes(30));
      expect(calls).toEqual(["machine-m4", "machine-m3"]);
    }),
  );

  it.effect("reads a copy alone, an answer and each refusal for what they are", () =>
    Effect.gen(function* () {
      const { client, calls } = recordingClient({});
      const claims = makeTakeoverEpochClaims({
        client,
        targets: fleet("m1"),
        selfEnvironmentId: Effect.succeed("m1"),
      });
      const alone = yield* claims.claim({
        logicalProjectId: "logical:one",
        epoch: 2,
        members: [{ environmentId: asEnvironmentId("m1") }],
      });
      expect(alone).toEqual([]);
      expect(calls).toEqual([]);

      expect(readTakeoverClaim({ accepted: true, epoch: 2 }, 2)).toEqual({ outcome: "claimed" });
      expect(readTakeoverClaim({ accepted: false }, 2).outcome).toBe("refused");
      expect(readTakeoverClaim("nonsense", 2).outcome).toBe("unreachable");
      const outcomeOf = (reason: RemoteMcpError["reason"]) =>
        classifyTakeoverClaimError(new RemoteMcpError({ reason })).outcome;
      expect(
        (["unreachable", "invalid_response", "unknown_machine"] as const).map(outcomeOf),
      ).toEqual(["unreachable", "unreachable", "unreachable"]);
      expect(
        (
          ["not_authorized", "identity_mismatch", "unsupported", "refused", "tool_failure"] as const
        ).map(outcomeOf),
      ).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    }),
  );

  it("still decodes a takeover answer from a server that sends no claims", () => {
    const decoded = decodeTakeoverResult({
      operationId: takeoverId,
      logicalProject: {
        id: "logical:one",
        title: "EasyChamp",
        coordinatorId: "coordinator:logical:one",
        members: [],
      },
      coordinatorBinding: { epoch: 1, state: "active" },
      notesWritten: 0,
      replicaFrom: null,
      replayed: false,
    });
    expect(decoded.epochClaims).toBeUndefined();
  });
});
