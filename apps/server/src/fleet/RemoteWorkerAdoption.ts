import type { LogicalProjectMember } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  STANDBY_DELIVERED_RUN_IDS_MAX,
  type CoordinatorStandbyShadowWorker,
} from "../project/CoordinatorStandbyStore.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";

/**
 * After an automatic takeover, the workers the old coordinator thread started
 * on other machines report to this one. The old coordinator's lease listed
 * them (shadow rows); each worker machine confirms the claim first, so it
 * refuses the old coordinator's steering from then on, and says which threads
 * the old coordinator really started there. Only those are taken on, under
 * this machine's own ids, and followed like workers this machine launched.
 */

/** Rows still running or holding an undelivered result; a launch in flight is the old machine's to settle. */
const ADOPTABLE_STATES = new Set(["following", "wake_pending"]);

/** Adopted rows are named after the old coordinator's own row, so a retry finds them. */
export const adoptedRowId = (shadowId: string) => `takeover:${shadowId}`;

export interface AdoptWorkersInput {
  readonly logicalProjectId: string;
  /** The epoch this machine took over at. */
  readonly epoch: number;
  /** This machine's own copy of the project. */
  readonly projectId: string;
  /** This machine's coordinator thread, which adopted workers report to. */
  readonly coordinatorThreadId: string;
  /** The coordinator this machine replaced. */
  readonly predecessor: LogicalProjectMember;
  readonly shadowWorkers: ReadonlyArray<CoordinatorStandbyShadowWorker>;
}

export interface AdoptWorkersResult {
  /** Rows this machine now follows. */
  readonly adopted: ReadonlyArray<string>;
  /** Rows shown but not followed: their machine refused the claim or cannot make one. */
  readonly readOnly: ReadonlyArray<string>;
  /** Launches still in flight on the old coordinator, which it settles when it returns. */
  readonly waitingForPredecessor: number;
}

/** The shadow rows the old coordinator thread started that still have a result to report. */
export function adoptionCandidates(
  shadows: ReadonlyArray<CoordinatorStandbyShadowWorker>,
  predecessor: Pick<LogicalProjectMember, "coordinatorThreadId">,
) {
  const fromCoordinator = shadows.filter(
    (shadow) => shadow.callerThreadId === predecessor.coordinatorThreadId,
  );
  return {
    candidates: fromCoordinator.filter(
      (shadow) => ADOPTABLE_STATES.has(shadow.state) && shadow.remoteThreadId !== null,
    ),
    waitingForPredecessor: fromCoordinator.filter((shadow) => shadow.state === "launching").length,
  };
}

interface ClaimAnswer {
  readonly accepted: boolean;
  readonly origins: ReadonlyMap<string, string | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the worker machine's answer to a claim; anything unexpected counts as refused. */
export function readClaimAnswer(value: unknown): ClaimAnswer {
  const origins = new Map<string, string | null>();
  if (!isRecord(value) || value.accepted !== true || !Array.isArray(value.origins))
    return { accepted: false, origins };
  for (const entry of value.origins)
    if (isRecord(entry) && typeof entry.threadId === "string")
      origins.set(
        entry.threadId,
        typeof entry.coordinatorEnvironmentId === "string" ? entry.coordinatorEnvironmentId : null,
      );
  return { accepted: true, origins };
}

export class RemoteWorkerAdoption extends Context.Service<
  RemoteWorkerAdoption,
  {
    /** Claims the epoch on each worker machine and takes on the confirmed workers. Idempotent. */
    readonly adopt: (input: AdoptWorkersInput) => Effect.Effect<AdoptWorkersResult>;
  }
>()("specweave-studio/fleet/RemoteWorkerAdoption") {}

const make = Effect.gen(function* () {
  const store = yield* RemoteWorkerStore.RemoteWorkerStore;
  const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
  const targets = yield* FleetTargets.FleetTargets;
  const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;

  const write = (
    rowId: string,
    change: (
      current: RemoteWorkerStore.RemoteWorkerRecord | undefined,
    ) => RemoteWorkerStore.RemoteWorkerRecord | undefined,
  ) =>
    store.modify(rowId, change).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not record an adopted remote worker.", { rowId, error }),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const adopt: RemoteWorkerAdoption["Service"]["adopt"] = (input) =>
    Effect.gen(function* () {
      const { candidates, waitingForPredecessor } = adoptionCandidates(
        input.shadowWorkers,
        input.predecessor,
      );
      const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const machines = yield* targets.load.pipe(
        Effect.map((config) => config?.machines ?? []),
        Effect.orElseSucceed(() => []),
      );
      const adopted: Array<string> = [];
      const readOnly: Array<string> = [];

      const rowFor = (
        shadow: CoordinatorStandbyShadowWorker,
        machineId: string,
        confirmed: boolean,
        previous: RemoteWorkerStore.RemoteWorkerRecord | undefined,
        reason: string | null,
      ): RemoteWorkerStore.RemoteWorkerRecord => ({
        id: adoptedRowId(shadow.id),
        callerThreadId: input.coordinatorThreadId,
        projectId: input.projectId,
        machineId,
        environmentId: shadow.environmentId,
        remoteProjectId: shadow.remoteProjectId,
        remoteThreadId: shadow.remoteThreadId,
        title: shadow.title,
        launchStartedAt: previous?.launchStartedAt ?? updatedAt,
        followedRunId: shadow.followedRunId,
        reportBack: true,
        // A result the old coordinator never delivered is followed again and delivered here.
        state: confirmed ? "following" : "stopped",
        lastStatus: previous?.lastStatus ?? null,
        deliveredRunIds: shadow.deliveredRunIds.slice(-STANDBY_DELIVERED_RUN_IDS_MAX),
        lostContactNotified: false,
        lastError: reason,
        updatedAt,
        adoptedFrom: {
          environmentId: input.predecessor.environmentId,
          rowId: shadow.id,
          epoch: input.epoch,
        },
        readOnly: !confirmed,
      });

      const byMachine = new Map<string, Array<CoordinatorStandbyShadowWorker>>();
      for (const shadow of candidates)
        byMachine.set(shadow.environmentId, [
          ...(byMachine.get(shadow.environmentId) ?? []),
          shadow,
        ]);

      for (const [environmentId, shadows] of byMachine) {
        const machine = machines.find((candidate) => candidate.environmentId === environmentId);
        const answer: ClaimAnswer & { readonly reason: string | null } =
          machine === undefined
            ? {
                accepted: false,
                origins: new Map(),
                reason: "This Mac has no link to that machine.",
              }
            : yield* client
                .call({
                  machineId: machine.id,
                  tool: "studio_coordinator_claim_epoch",
                  arguments: {
                    logicalProjectId: input.logicalProjectId,
                    epoch: input.epoch,
                    threadIds: shadows.flatMap((shadow) =>
                      shadow.remoteThreadId === null ? [] : [shadow.remoteThreadId],
                    ),
                  },
                })
                .pipe(
                  Effect.map((value) => {
                    const read = readClaimAnswer(value);
                    return {
                      ...read,
                      reason: read.accepted
                        ? null
                        : `${machine.label} did not let this Mac take over its workers.`,
                    };
                  }),
                  Effect.catch((error) =>
                    Effect.succeed({
                      accepted: false,
                      origins: new Map<string, string | null>(),
                      reason:
                        error.reason === "unsupported" || error.reason === "refused"
                          ? `${machine.label} needs an update before this Mac can take over its workers.`
                          : error.message,
                    }),
                  ),
                );
        for (const shadow of shadows) {
          const rowId = adoptedRowId(shadow.id);
          if (!answer.accepted) {
            const written = yield* write(rowId, (current) =>
              // A worker already taken on stays so; a refusal later never undoes it.
              current !== undefined && current.readOnly !== true
                ? undefined
                : rowFor(shadow, machine?.id ?? shadow.machineId, false, current, answer.reason),
            );
            if (written?.readOnly === true) readOnly.push(rowId);
            else if (written !== undefined) adopted.push(rowId);
            continue;
          }
          // Only a thread the machine says the replaced coordinator started is taken on.
          if (
            shadow.remoteThreadId === null ||
            answer.origins.get(shadow.remoteThreadId) !== input.predecessor.environmentId
          )
            continue;
          const written = yield* write(rowId, (current) =>
            current !== undefined && current.readOnly !== true
              ? undefined
              : rowFor(shadow, machine!.id, true, current, null),
          );
          if (written === undefined) continue;
          adopted.push(rowId);
          if (written.state === "following") yield* follower.follow(rowId);
        }
      }
      return { adopted, readOnly, waitingForPredecessor } satisfies AdoptWorkersResult;
    });

  return RemoteWorkerAdoption.of({ adopt });
});

export const layer = Layer.effect(RemoteWorkerAdoption, make);
