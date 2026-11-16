import type { ProjectTakeoverEpochClaim, ProjectTakeoverResult } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as FleetTargets from "../fleet/FleetTargets.ts";
import type { RemoteMcpError, RemoteStudioMcpClient } from "../fleet/RemoteStudioMcpClient.ts";

/**
 * After a person's takeover, the new coordinator claims its epoch on the
 * machine of every other member, as an automatic takeover does through
 * `RemoteWorkerAdoption`. A machine that accepts takes steering for the
 * project only from this coordinator from then on, so the one it replaced
 * gets `thread_fenced` there.
 *
 * Each machine is asked once per takeover call. One that cannot be reached is
 * reported, never retried here: calling the takeover again with the same
 * operation id replays it and asks again. The replaced coordinator's own
 * machine is asked too, so a claim stands there if it happens to answer. Only
 * the members this copy lists are asked: one it has not heard of yet is
 * neither claimed nor reported. A claim never fails the takeover, which is
 * already written.
 */

/** How long one machine has to answer its claim. */
export const TAKEOVER_CLAIM_TIMEOUT_MS = 8_000;
/**
 * How long all the claims of one takeover may take together, with connecting.
 * A machine with no answer by then, or not yet asked, counts as unreachable,
 * so the takeover's answer never waits longer whatever the number of members.
 */
export const TAKEOVER_CLAIM_BUDGET_MS = 15_000;
/** Machines asked at the same time. */
export const TAKEOVER_CLAIM_CONCURRENCY = 8;

const DETAIL_MAX = 500;
const LABEL_MAX = 256;

export interface TakeoverEpochClaimDeps {
  readonly client: Pick<RemoteStudioMcpClient["Service"], "call">;
  readonly targets: Pick<FleetTargets.FleetTargets["Service"], "load">;
  readonly selfEnvironmentId: Effect.Effect<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Outcome = Pick<ProjectTakeoverEpochClaim, "outcome" | "detail">;

const outcome = (kind: ProjectTakeoverEpochClaim["outcome"], detail?: string): Outcome =>
  detail === undefined || detail === ""
    ? { outcome: kind }
    : { outcome: kind, detail: detail.slice(0, DETAIL_MAX) };

/** What a machine's answer to the claim means; anything unexpected is no answer. */
export function readTakeoverClaim(value: unknown, epoch: number): Outcome {
  if (!isRecord(value) || typeof value.accepted !== "boolean")
    return outcome("unreachable", "The other machine sent an unreadable answer.");
  if (value.accepted) return outcome("claimed");
  return outcome(
    "refused",
    typeof value.epoch === "number" && value.epoch >= epoch
      ? `That machine already follows a coordinator at epoch ${value.epoch}.`
      : "That machine did not accept the claim.",
  );
}

/**
 * Only a call that got no answer is unreachable. A refusal by that machine, by
 * its grant to this one or by Team rules is definite: no claim stands there.
 */
export function classifyTakeoverClaimError(error: RemoteMcpError): Outcome {
  switch (error.reason) {
    case "unreachable":
    case "invalid_response":
    case "unknown_machine":
      return outcome("unreachable", error.message);
    case "not_authorized":
    case "identity_mismatch":
    case "unsupported":
    case "refused":
    case "tool_failure":
      return outcome("refused", error.message);
  }
}

export const makeTakeoverEpochClaims = (deps: TakeoverEpochClaimDeps) => {
  /** Claims `epoch` on the machine of every listed member but this one. Never fails. */
  const claim = (input: {
    readonly logicalProjectId: string;
    readonly epoch: number;
    readonly members: ReadonlyArray<{ readonly environmentId: string }>;
  }): Effect.Effect<ReadonlyArray<ProjectTakeoverEpochClaim>> =>
    Effect.gen(function* () {
      const self = yield* deps.selfEnvironmentId;
      const environments = [...new Set(input.members.map((member) => member.environmentId))].filter(
        (environmentId) => environmentId !== self,
      );
      if (environments.length === 0) return [];
      // An unreadable list of machines claims nowhere this time, and says so.
      const loaded = yield* deps.targets.load.pipe(
        Effect.map((config) => config?.machines ?? []),
        Effect.option,
        Effect.catchCause(() => Effect.succeed(Option.none())),
      );
      const machines = Option.getOrElse(loaded, () => []);
      const deadline = (yield* Clock.currentTimeMillis) + TAKEOVER_CLAIM_BUDGET_MS;
      const claims = yield* Effect.forEach(
        environments,
        (environmentId) => {
          const machine = machines.find((candidate) => candidate.environmentId === environmentId);
          if (machine === undefined)
            return Effect.succeed({
              machine: environmentId,
              ...outcome(
                "unreachable",
                Option.isNone(loaded)
                  ? "This machine could not read its list of machines."
                  : "This machine has no link to that machine.",
              ),
            });
          const named = (result: Outcome) => ({
            machine: environmentId,
            label: machine.label.slice(0, LABEL_MAX),
            ...result,
          });
          return Effect.gen(function* () {
            const left = deadline - (yield* Clock.currentTimeMillis);
            if (left <= 0) return outcome("unreachable", "The machine was not asked in time.");
            return yield* deps.client
              .call({
                machineId: machine.id,
                tool: "studio_coordinator_claim_epoch",
                timeoutMs: Math.min(TAKEOVER_CLAIM_TIMEOUT_MS, left),
                arguments: { logicalProjectId: input.logicalProjectId, epoch: input.epoch },
              })
              .pipe(
                Effect.map((value) => readTakeoverClaim(value, input.epoch)),
                Effect.catch((error) => Effect.succeed(classifyTakeoverClaimError(error))),
                Effect.timeoutOption(Duration.millis(left)),
                Effect.map(
                  Option.getOrElse(() =>
                    outcome("unreachable", "The machine did not answer in time."),
                  ),
                ),
              );
          }).pipe(
            // The takeover is written; nothing that goes wrong here may undo its answer.
            Effect.catchCause(() => Effect.succeed(outcome("unreachable", "The call failed."))),
            Effect.map(named),
          );
        },
        { concurrency: TAKEOVER_CLAIM_CONCURRENCY },
      );
      // The contract brands the machine id; these are member and fleet ids as stored.
      return claims as ReadonlyArray<ProjectTakeoverEpochClaim>;
    });

  /** The takeover's answer with what each other member machine said to the claim. */
  const afterTakeover = (result: ProjectTakeoverResult): Effect.Effect<ProjectTakeoverResult> =>
    Effect.gen(function* () {
      if (result.coordinatorBinding.state !== "active") return result;
      const epochClaims = yield* claim({
        logicalProjectId: result.logicalProject.id,
        epoch: result.coordinatorBinding.epoch,
        members: result.logicalProject.members,
      });
      const missed = epochClaims.filter((entry) => entry.outcome !== "claimed");
      yield* missed.length === 0
        ? Effect.logInfo("Takeover claimed its epoch on every other member machine.", {
            logicalProjectId: result.logicalProject.id,
            epoch: result.coordinatorBinding.epoch,
            machines: epochClaims.length,
          })
        : Effect.logWarning("Takeover could not claim its epoch on every member machine.", {
            logicalProjectId: result.logicalProject.id,
            epoch: result.coordinatorBinding.epoch,
            missed,
          });
      return { ...result, epochClaims };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Takeover epoch claims failed.", { cause }).pipe(Effect.as(result)),
      ),
    );

  /** A person's takeover, then its claims. A takeover that fails claims nowhere. */
  const takeover = <E, R>(run: Effect.Effect<ProjectTakeoverResult, E, R>) =>
    Effect.flatMap(run, afterTakeover);

  return { claim, afterTakeover, takeover } as const;
};
