import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  type CoordinatorStandbyAfterMinutes,
  EnvironmentId,
  logicalProjectMemberKey,
  type LogicalProjectMember,
  type Project,
  ProjectId,
  type ProjectLinkError,
  type StandbyRearmConsent,
  StandbyRearmReason,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FleetTargets } from "../fleet/FleetTargets.ts";
import { FleetWorkerGrants } from "../fleet/FleetWorkerGrants.ts";
import { fleetMachineFor } from "../fleet/RemoteWorkerAdoption.ts";
import {
  type RemoteMcpError,
  RemoteStudioMcpClient,
  TEAM_RULES_REMOTE_CODE,
} from "../fleet/RemoteStudioMcpClient.ts";
import { type HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  type LinkedDigestResponse,
} from "../handoff/linkedSyncWire.ts";
import { sha256 } from "../nodeCrypto.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import {
  CoordinatorLeaseStore,
  layer as CoordinatorLeaseStoreLayer,
  withPendingRelease,
  withoutPendingRelease,
} from "./CoordinatorLeaseStore.ts";
import {
  CoordinatorRearmStore,
  layer as CoordinatorRearmStoreLayer,
  type RearmEntry,
  type RearmRun,
} from "./CoordinatorRearmStore.ts";
import { STANDBY_TICK_MS } from "./CoordinatorStandbyWatch.ts";
import { COORDINATOR_FENCE_MARGIN_MS } from "./CoordinatorWakeGate.ts";
import { ProjectLink } from "./ProjectLink.ts";
import {
  autoTakeoverOperationId,
  type ProjectLinkStandbyMethods,
  REARM_OWNER_CHOSE,
} from "./ProjectLinkStandby.ts";
import * as ProjectService from "./ProjectService.ts";

/**
 * Re-arming a standby on the coordinator that took over automatically. The
 * owner's app wrote a consent on every machine of its list; once this copy
 * coordinates after an automatic takeover, this loop registers the next
 * machine of that list as its standby and names it in the binding, so the
 * project is again covered when this machine goes quiet.
 *
 * Per candidate: a read-only `linked-digest` probe over the lease's own peer
 * route, then the registration through `studio_coordinator_claim_epoch`
 * (persisted as in flight before it leaves), then the binding under the
 * project lock. A re-arm counts only after a lease came back (`verifying`
 * to `armed`). A standby that took no lease cannot fire, so it is turned off
 * and the next one tried; one that may have taken a lease keeps today's
 * fence. One that answers it does not stand by is replaced.
 *
 * Its own loop and retry map: it never shares state with, or delays, the
 * takeover round in CoordinatorStandbyLoop.
 */

export const REARM_BACKOFF_MIN_MS = 30_000;
export const REARM_BACKOFF_MAX_MS = 10 * 60_000;
export const REARM_STUCK_BACKOFF_MS = 6 * 60 * 60_000;
export const REARM_MONITOR_MS = 2 * 60_000;
export const REARM_CALL_TIMEOUT_MS = 15_000;
export const REARM_MAX_CALLS_PER_ATTEMPT = 3;
export const REARM_MAX_ROTATIONS = 3;
/** Projects that may do work in one round; the others wait for the next tick. Idle ones do not count. */
export const REARM_PROJECTS_PER_ROUND = 2;

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const sameMember = (a: LogicalProjectMember, b: LogicalProjectMember) =>
  a.environmentId === b.environmentId &&
  a.projectId === b.projectId &&
  a.coordinatorThreadId === b.coordinatorThreadId;

/**
 * How long after naming a standby a lease must have come back. Ends before
 * the fence rises (`enabledAt + afterMinutes - margin`), two ticks early, so
 * a rollback lands first. Five minutes: 110 s, with the fence at 170 s.
 */
export function verifyWindowMs(afterMinutes: CoordinatorStandbyAfterMinutes): number {
  return afterMinutes * 60_000 - COORDINATOR_FENCE_MARGIN_MS - 2 * STANDBY_TICK_MS;
}

const memberHash = (candidate: LogicalProjectMember) =>
  sha256([candidate.environmentId, candidate.projectId]).toString("hex").slice(0, 12);
const projectHash = (logicalProjectId: string) =>
  sha256([logicalProjectId]).toString("hex").slice(0, 32);

/** Names this copy's arming of `candidate` at `epoch`, so a retry replays; at most 128 characters. */
export function rearmOperationId(
  logicalProjectId: string,
  epoch: number,
  candidate: LogicalProjectMember,
): string {
  return `rearm:${projectHash(logicalProjectId)}:${epoch}:${memberHash(candidate)}`;
}

/** Names turning `candidate` off again at `epoch`. */
export function rearmOffOperationId(
  logicalProjectId: string,
  epoch: number,
  candidate: LogicalProjectMember,
): string {
  return `rearm-off:${projectHash(logicalProjectId)}:${epoch}:${memberHash(candidate)}`;
}

/**
 * The machines to try, in order: one whose registration was in flight when
 * this process stopped; then the owner's list in order, without this copy,
 * machines no longer listed, the predecessor and machines that failed or did
 * not answer at this epoch; then those that did not answer; then the
 * predecessor, when the owner listed it; then those that failed, last.
 */
export function rearmCandidates(input: {
  readonly members: ReadonlyArray<LogicalProjectMember>;
  readonly listed: ReadonlyArray<LogicalProjectMember>;
  readonly self: LogicalProjectMember;
  readonly predecessor: LogicalProjectMember;
  readonly failed: RearmRun["failed"];
  readonly uncertain: RearmRun["uncertain"];
  readonly inFlight: LogicalProjectMember | null;
}): ReadonlyArray<LogicalProjectMember> {
  const key = logicalProjectMemberKey;
  // The listed entry is the current one; the consent may predate a folder or thread change.
  const listed = new Map(input.listed.map((member) => [key(member), member]));
  const eligible = input.members
    .filter((member) => key(member) !== key(input.self) && listed.has(key(member)))
    .map((member) => listed.get(key(member))!);
  const inList = (members: ReadonlyArray<LogicalProjectMember>) => {
    const keys = new Set(members.map(key));
    return eligible.filter((member) => keys.has(key(member)));
  };
  const failed = inList(input.failed.map((note) => note.member));
  const uncertain = inList(input.uncertain.map((note) => note.member));
  const predecessor = inList([input.predecessor]);
  const later = new Set([...failed, ...uncertain, ...predecessor].map(key));
  const ordered = [
    ...(input.inFlight === null ? [] : inList([input.inFlight])),
    ...eligible.filter((member) => !later.has(key(member))),
    ...uncertain,
    ...predecessor,
    ...failed,
  ];
  const seen = new Set<string>();
  return ordered.filter((member) => {
    const k = key(member);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type ClaimStandbyOutcome =
  | { readonly kind: "armed" }
  | { readonly kind: "refused"; readonly reason: StandbyRearmReason; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isReason = Schema.is(StandbyRearmReason);

/**
 * What a registration through `studio_coordinator_claim_epoch` came to. Only
 * a call that got no answer is uncertain; every other failure is a definite
 * refusal that left no registration there.
 */
export function classifyClaim(answer: Exit.Exit<unknown, RemoteMcpError>): ClaimStandbyOutcome {
  if (Exit.isSuccess(answer)) {
    const standby = isRecord(answer.value) ? answer.value.standby : undefined;
    // An older receiver ignores the request and its claim stands, with no registration.
    if (!isRecord(standby))
      return { kind: "refused", reason: "needs_update", detail: "no standby answer" };
    if (standby.armed === true) return { kind: "armed" };
    return {
      kind: "refused",
      reason: isReason(standby.code) ? standby.code : "refused",
      detail: typeof standby.message === "string" ? standby.message.slice(0, 500) : "",
    };
  }
  const error = Option.getOrUndefined(Cause.findErrorOption(answer.cause));
  if (error === undefined) return { kind: "uncertain", detail: "the call failed" };
  const refused = (reason: StandbyRearmReason): ClaimStandbyOutcome => ({
    kind: "refused",
    reason,
    detail: error.message.slice(0, 500),
  });
  switch (error.reason) {
    case "unsupported":
    case "refused":
      return refused("needs_update");
    case "tool_failure":
      return refused(
        error.remoteCode === TEAM_RULES_REMOTE_CODE
          ? "team_rules"
          : error.remoteCode === "outside_grant_scope"
            ? "needs_grant"
            : "refused",
      );
    case "not_authorized":
    case "unknown_machine":
    case "identity_mismatch":
      return refused("needs_grant");
    case "unreachable":
      // An older receiver rejecting the unknown argument answers invalid params.
      return error.cause instanceof McpError && error.cause.code === ErrorCode.InvalidParams
        ? refused("needs_update")
        : { kind: "uncertain", detail: error.message.slice(0, 500) };
    case "invalid_response":
      return { kind: "uncertain", detail: error.message.slice(0, 500) };
  }
}

export type RearmOutcome =
  | { readonly kind: "idle" }
  /** The round could not read or write what it needed; tried again with backoff. */
  | { readonly kind: "failed" }
  | {
      readonly kind: "run";
      readonly run: RearmRun;
      /** Every machine called waits for the owner (a grant, a consent): retry after hours. */
      readonly stuck?: boolean | undefined;
    };

export interface StandbyRearmDeps {
  readonly rearmStore: CoordinatorRearmStore["Service"];
  readonly leaseStore: Pick<CoordinatorLeaseStore["Service"], "get" | "modify">;
  /** Undefined only when the project is gone; a failed read fails the round, which backs off. */
  readonly loadProject: (id: ProjectId) => Effect.Effect<Project | undefined>;
  readonly rearmStandby: ProjectLinkStandbyMethods["rearmStandby"];
  /** The read-only `linked-digest` peer call, on the lease's own route and grant check. */
  readonly probe: (
    environmentId: string,
    logicalProjectId: string,
    projectId: string,
  ) => Effect.Effect<LinkedDigestResponse, HandoffPeerError>;
  readonly claimStandby: (input: {
    readonly machineId: string;
    readonly logicalProjectId: string;
    readonly epoch: number;
    readonly chainId: string;
  }) => Effect.Effect<ClaimStandbyOutcome>;
  readonly fleetMachineFor: (
    environmentId: string,
  ) => Effect.Effect<{ readonly id: string; readonly label?: string } | undefined>;
  /** This machine's own record of its grant there; no network. */
  readonly grantStatus: (
    machineId: string,
  ) => Effect.Effect<{ readonly status: string; readonly renewable: boolean }>;
  readonly selfEnvironmentId: string;
}

/**
 * Why a run may stop and later go on at the same epoch: the gate it failed
 * (consent, binding) can pass again, for example after a person's handoff
 * rolled back. Only the owner's own choice stops a run for good.
 */
const REOPENS = new Set<StandbyRearmReason | null>(["off", "superseded"]);

/** Codes from `rearmStandby` that mean this copy no longer coordinates at that epoch. */
const SUPERSEDED_CODES = new Set<ProjectLinkError["code"]>([
  "not_coordinator",
  "handoff_in_progress",
  "superseded_conflict",
  "not_linked",
]);

export const makeStandbyRearm = (deps: StandbyRearmDeps) => {
  const { rearmStore, leaseStore } = deps;
  const now = Clock.currentTimeMillis;

  const write = (entry: RearmEntry, run: RearmRun) =>
    Effect.gen(function* () {
      const at = isoAt(yield* now);
      const next: RearmRun = { ...run, updatedAt: at };
      yield* rearmStore.modify(entry.logicalProjectId, (current) =>
        current === undefined || current.projectId !== entry.projectId
          ? undefined
          : { ...current, run: next },
      );
      return next;
    });

  const owe = (entry: RearmEntry, member: LogicalProjectMember, epoch: number) =>
    Effect.gen(function* () {
      const at = isoAt(yield* now);
      yield* leaseStore.modify(entry.projectId, (current) =>
        withPendingRelease(
          current,
          { standby: member, epoch, logicalProjectId: entry.logicalProjectId, since: at },
          entry.projectId,
          at,
        ),
      );
    });

  const purge = (entry: RearmEntry, member: LogicalProjectMember, epoch: number) =>
    leaseStore
      .modify(entry.projectId, (current) => withoutPendingRelease(current, member, epoch))
      .pipe(Effect.asVoid);

  const freshRun = (epoch: number, chainId: string, at: string): RearmRun => ({
    epoch,
    chainId,
    state: "pending",
    reason: null,
    detail: null,
    standby: null,
    enabledAt: null,
    inFlight: null,
    rotatingFrom: null,
    failed: [],
    uncertain: [],
    rotations: 0,
    attempts: 0,
    since: at,
    updatedAt: at,
  });

  const stop = (entry: RearmEntry, run: RearmRun, reason: StandbyRearmReason) =>
    write(entry, { ...run, state: "stopped", reason, detail: null, inFlight: null }).pipe(
      Effect.map((next): RearmOutcome => ({ kind: "run", run: next })),
    );

  interface Context {
    readonly entry: RearmEntry;
    readonly project: Project;
    readonly logicalProjectId: string;
    readonly epoch: number;
    readonly consent: StandbyRearmConsent;
    readonly listed: ReadonlyArray<LogicalProjectMember>;
    readonly self: LogicalProjectMember;
    readonly predecessor: LogicalProjectMember;
  }

  const labelOf = (member: LogicalProjectMember, label: string | undefined) =>
    (label ?? member.environmentId).slice(0, 200);

  /** Tries the candidates in order, at most a few calls, and names the first that registers. */
  const select = (context: Context, from: RearmRun) =>
    Effect.gen(function* () {
      const { entry, epoch, consent, logicalProjectId } = context;
      let run = yield* write(entry, {
        ...from,
        state: "pending",
        standby: null,
        enabledAt: null,
        rotatingFrom: null,
        attempts: from.attempts + 1,
      });
      const candidates = rearmCandidates({
        members: consent.members,
        listed: context.listed,
        self: context.self,
        predecessor: context.predecessor,
        failed: run.failed,
        uncertain: run.uncertain,
        inFlight: run.inFlight?.member ?? null,
      });
      let first: { reason: StandbyRearmReason; detail: string } | null = null;
      let waitsForOwner = candidates.length > 0;
      /** A machine skipped for this machine's own grant record, which can change any time. */
      let skippedLocally = false;
      const note = (reason: StandbyRearmReason, detail: string) => {
        first ??= { reason, detail };
        if (reason !== "needs_grant" && reason !== "no_consent") waitsForOwner = false;
      };
      const pending = (stuck: boolean) =>
        write(entry, {
          ...run,
          state: "pending",
          reason: first?.reason ?? "no_candidates",
          detail: first?.detail ?? null,
        }).pipe(Effect.map((next): RearmOutcome => ({ kind: "run", run: next, stuck })));
      if (candidates.length === 0) return yield* pending(false);
      let calls = 0;
      for (const candidate of candidates) {
        if (calls >= REARM_MAX_CALLS_PER_ATTEMPT) {
          waitsForOwner = false;
          break;
        }
        const machine = yield* deps.fleetMachineFor(candidate.environmentId);
        const label = labelOf(candidate, machine?.label);
        if (machine === undefined) {
          note("needs_grant", label);
          skippedLocally = true;
          continue;
        }
        // An expiring grant still works; one that renews by itself is "allowed".
        const grant = yield* deps.grantStatus(machine.id);
        if (grant.status !== "allowed" && grant.status !== "expiring") {
          note("needs_grant", label);
          skippedLocally = true;
          continue;
        }
        calls += 1;
        const probed = yield* deps
          .probe(candidate.environmentId, logicalProjectId, candidate.projectId)
          .pipe(Effect.result);
        if (probed._tag === "Failure") {
          note(probed.failure.code === "needs_grant" ? "needs_grant" : "unreachable", label);
          continue;
        }
        const binding = probed.success.binding;
        if (binding?.state !== "transferred") {
          note("not_member", label);
          continue;
        }
        if (binding.epoch > epoch) {
          note("superseded_conflict", label);
          continue;
        }
        // A release this copy still owes there must not race the registration it now asks for.
        const owedBefore = run.uncertain.some((kept) => sameMember(kept.member, candidate));
        if (owedBefore) yield* purge(entry, candidate, epoch);
        run = yield* write(entry, {
          ...run,
          inFlight: { member: candidate, since: isoAt(yield* now) },
        });
        const claimed = yield* deps.claimStandby({
          machineId: machine.id,
          logicalProjectId,
          epoch,
          chainId: consent.chainId,
        });
        if (claimed.kind === "refused") {
          run = yield* write(entry, {
            ...run,
            inFlight: null,
            failed: [
              ...run.failed.filter((kept) => !sameMember(kept.member, candidate)),
              { member: candidate, reason: claimed.reason, at: isoAt(yield* now) },
            ],
          });
          // A refusal now says nothing of the registration an earlier, unanswered call may have left.
          if (owedBefore) yield* owe(entry, candidate, epoch);
          note(claimed.reason, label);
          continue;
        }
        if (claimed.kind === "uncertain") {
          run = yield* write(entry, {
            ...run,
            inFlight: null,
            uncertain: [
              ...run.uncertain.filter((kept) => !sameMember(kept.member, candidate)),
              { member: candidate, since: isoAt(yield* now) },
            ],
          });
          yield* owe(entry, candidate, epoch);
          note("unreachable", label);
          continue;
        }
        const named = yield* deps
          .rearmStandby({
            projectId: context.project.id,
            logicalProjectId,
            epoch,
            operationId: rearmOperationId(logicalProjectId, epoch, candidate),
            standby: { member: candidate, afterMinutes: consent.afterMinutes },
          })
          .pipe(Effect.result);
        if (named._tag === "Success") {
          yield* purge(entry, candidate, epoch);
          const next = yield* write(entry, {
            ...run,
            state: "verifying",
            standby: named.success.coordinatorBinding.standby?.member ?? candidate,
            enabledAt: named.success.coordinatorBinding.standby?.enabledAt ?? isoAt(yield* now),
            inFlight: null,
            uncertain: run.uncertain.filter((kept) => !sameMember(kept.member, candidate)),
            reason: null,
            detail: label,
          });
          yield* Effect.logInfo("Coordinator re-armed a standby after taking over", {
            logicalProjectId,
            epoch,
            standby: candidate.environmentId,
          });
          return { kind: "run", run: next } as RearmOutcome;
        }
        // It registered but was never named, so no lease reaches it and it cannot fire; release it.
        const error = named.failure;
        run = yield* write(entry, {
          ...run,
          inFlight: null,
          uncertain: [
            ...run.uncertain.filter((kept) => !sameMember(kept.member, candidate)),
            { member: candidate, since: isoAt(yield* now) },
          ],
        });
        yield* owe(entry, candidate, epoch);
        if (error.code === "superseded_conflict" && error.detail === REARM_OWNER_CHOSE)
          return yield* stop(entry, run, "owner_changed");
        if (SUPERSEDED_CODES.has(error.code)) return yield* stop(entry, run, "superseded");
        first ??= { reason: "refused", detail: label };
        return yield* pending(false);
      }
      // Hours only after the machines themselves said so. A grant missing here is a local read,
      // and one the renewal pass renews or the owner grants again is seen on the usual backoff.
      return yield* pending(waitsForOwner && !skippedLocally);
    });

  /** Turns this run's own standby off, then tries the next machine. */
  const finishRotation = (context: Context, run: RearmRun) =>
    Effect.gen(function* () {
      const from = run.rotatingFrom!;
      const cleared = yield* deps
        .rearmStandby({
          projectId: context.project.id,
          logicalProjectId: context.logicalProjectId,
          epoch: context.epoch,
          operationId: rearmOffOperationId(context.logicalProjectId, context.epoch, from),
          standby: null,
          expect: from,
        })
        .pipe(Effect.result);
      if (cleared._tag === "Failure") {
        const error = cleared.failure;
        if (error.code === "superseded_conflict" && error.detail === REARM_OWNER_CHOSE)
          return yield* stop(context.entry, run, "owner_changed");
        if (SUPERSEDED_CODES.has(error.code)) return yield* stop(context.entry, run, "superseded");
        // Kept as rotating; the next round finishes it.
        return { kind: "run", run } as RearmOutcome;
      }
      // The lease loop now owes the old standby a release (CoordinatorLease.sync).
      return yield* select(context, { ...run, standby: null, enabledAt: null, rotatingFrom: null });
    });

  const rotate = (context: Context, run: RearmRun, reason: StandbyRearmReason) =>
    Effect.gen(function* () {
      const standby = run.standby!;
      if (run.rotations >= REARM_MAX_ROTATIONS) {
        // Rotation only runs for a standby that cannot fire, so turning it off is safe, and a
        // coordinator no longer waits fenced on a standby nobody will replace.
        const cleared = yield* deps
          .rearmStandby({
            projectId: context.project.id,
            logicalProjectId: context.logicalProjectId,
            epoch: context.epoch,
            operationId: rearmOffOperationId(context.logicalProjectId, context.epoch, standby),
            standby: null,
            expect: standby,
          })
          .pipe(Effect.result);
        const next = yield* write(context.entry, {
          ...run,
          state: "pending",
          reason,
          detail: run.detail,
          ...(cleared._tag === "Success" ? { standby: null, enabledAt: null } : {}),
        });
        return { kind: "run", run: next, stuck: true } as RearmOutcome;
      }
      yield* Effect.logWarning("Coordinator re-arm replaces a standby", {
        logicalProjectId: context.logicalProjectId,
        epoch: context.epoch,
        standby: standby.environmentId,
        reason,
      });
      const marked = yield* write(context.entry, {
        ...run,
        rotatingFrom: standby,
        rotations: run.rotations + 1,
        failed: [
          ...run.failed.filter((kept) => !sameMember(kept.member, standby)),
          { member: standby, reason, at: isoAt(yield* now) },
        ],
      });
      return yield* finishRotation(context, marked);
    });

  /** Verifies a standby this run named with a lease round trip, then watches it. */
  const monitor = (context: Context, run: RearmRun) =>
    Effect.gen(function* () {
      const lease = yield* leaseStore.get(context.project.id);
      const target = lease?.target ?? null;
      const idle = { kind: "run", run } as RearmOutcome;
      if (
        lease === undefined ||
        target === null ||
        run.standby === null ||
        !sameMember(target.standby, run.standby) ||
        target.epoch !== context.epoch
      )
        return idle;
      // It answered that it does not stand by for this copy: it cannot fire.
      if (lease.standbyMissingAt !== null) return yield* rotate(context, run, "standby_missing");
      if (lease.lastSuccessfulLeaseAt !== null)
        return run.state === "verifying" || run.reason !== null
          ? ({
              kind: "run",
              run: yield* write(context.entry, {
                ...run,
                state: "armed",
                reason: null,
                // A standby that answered starts a fresh allowance of replacements.
                rotations: 0,
              }),
            } as RearmOutcome)
          : idle;
      if (run.state !== "verifying" || run.enabledAt === null) return idle;
      const enabledMs = Date.parse(run.enabledAt);
      if ((yield* now) < enabledMs + verifyWindowMs(target.afterMinutes)) return idle;
      // No lease can have reached it, so it never started counting: safe to replace.
      if ((lease.maybeDeliveredAt ?? null) === null)
        return yield* rotate(context, run, "lease_failed");
      // It may have taken a lease; it keeps today's fence instead.
      if (run.reason === "lease_failed") return idle;
      return {
        kind: "run",
        run: yield* write(context.entry, {
          ...run,
          reason: "lease_failed",
          detail: "not answering",
        }),
      } as RearmOutcome;
    });

  const rearmOnce = (entry: RearmEntry): Effect.Effect<RearmOutcome> =>
    Effect.gen(function* () {
      const at = isoAt(yield* now);
      const project = yield* deps.loadProject(ProjectId.make(entry.projectId));
      const settings = project?.workspaceSettings;
      const identity = settings?.logicalProject;
      const binding = settings?.coordinatorBinding;
      const consent = entry.consent;
      const live = entry.run !== null && entry.run.state !== "stopped" ? entry.run : null;
      if (
        project === undefined ||
        project.deletedAt !== null ||
        consent === null ||
        identity === undefined ||
        identity.id !== entry.logicalProjectId
      )
        return live === null ? ({ kind: "idle" } as const) : yield* stop(entry, live, "off");
      // A person's handoff in progress may still roll back to this coordinator: wait, keep the run.
      if (binding?.state === "transferring") return { kind: "idle" } as const;
      // Only a copy that took over automatically re-arms (never one a person started).
      if (
        !(
          binding?.state === "active" &&
          binding.takenOverBy === "auto" &&
          binding.predecessor !== undefined &&
          binding.operationId === autoTakeoverOperationId(entry.logicalProjectId, binding.epoch)
        )
      )
        return live === null ? ({ kind: "idle" } as const) : yield* stop(entry, live, "superseded");
      const epoch = binding.epoch;
      const self = identity.members.find(
        (member) =>
          member.environmentId === deps.selfEnvironmentId && member.projectId === project.id,
      );
      if (self === undefined) return { kind: "idle" } as const;
      if (epoch < consent.fromEpoch)
        return live === null ? ({ kind: "idle" } as const) : yield* stop(entry, live, "off");
      const held = entry.run;
      // A new list at the same epoch carries the run on, with its failures forgotten.
      let run: RearmRun =
        held !== null && held.epoch === epoch && held.chainId === consent.chainId
          ? held
          : held !== null && held.epoch === epoch && held.state !== "stopped"
            ? { ...held, chainId: consent.chainId, failed: [] }
            : freshRun(epoch, consent.chainId, at);
      if (run.state === "stopped") {
        if (!REOPENS.has(run.reason)) return { kind: "run", run } as const;
        // Stopped by a state that reverted: this copy coordinates at that epoch again.
        run = yield* write(entry, {
          ...run,
          state: run.standby === null ? "pending" : "verifying",
          reason: null,
          detail: null,
        });
      }
      const context: Context = {
        entry,
        project,
        logicalProjectId: entry.logicalProjectId,
        epoch,
        consent,
        listed: identity.members,
        self,
        predecessor: binding.predecessor,
      };
      const standby = binding.standby;
      // Crash after this run asked to turn its standby off and before it went on.
      if (
        run.rotatingFrom !== null &&
        standby !== undefined &&
        sameMember(standby.member, run.rotatingFrom)
      )
        return yield* finishRotation(context, run);
      // The owner's choice wins.
      if (standby !== undefined) {
        if (run.standby !== null && sameMember(standby.member, run.standby))
          return yield* monitor(context, run);
        // Crash after the binding named it, before this run recorded so.
        if (
          run.inFlight !== null &&
          sameMember(standby.member, run.inFlight.member) &&
          standby.enabledAt >= run.inFlight.since
        ) {
          const inFlight = run.inFlight.member;
          run = yield* write(entry, {
            ...run,
            state: "verifying",
            standby: standby.member,
            enabledAt: standby.enabledAt,
            inFlight: null,
            uncertain: run.uncertain.filter((kept) => !sameMember(kept.member, inFlight)),
            reason: null,
            detail: null,
          });
          return { kind: "run", run } as const;
        }
        return yield* stop(entry, run, "owner_changed");
      }
      // The owner turned the standby this run named off.
      if ((run.state === "verifying" || run.state === "armed") && run.rotatingFrom === null)
        return yield* stop(entry, run, "owner_changed");
      return yield* select(context, run);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Coordinator re-arm round failed", {
          logicalProjectId: entry.logicalProjectId,
          cause,
        }).pipe(Effect.as({ kind: "failed" } as RearmOutcome)),
      ),
    );

  return { rearmOnce } as const;
};

/** When the next attempt for an outcome may run, after `failures` attempts in a row. */
export function nextAttemptMs(
  outcome: RearmOutcome,
  failures: number,
  nowMs: number,
): number | null {
  const backoff =
    nowMs + Math.min(REARM_BACKOFF_MIN_MS * 2 ** (failures - 1), REARM_BACKOFF_MAX_MS);
  if (outcome.kind === "idle") return nowMs + STANDBY_TICK_MS;
  if (outcome.kind === "failed") return backoff;
  switch (outcome.run.state) {
    case "stopped":
      // Looked at again now and then, in case what stopped it reverted (a cheap local read).
      return REOPENS.has(outcome.run.reason) ? nowMs + REARM_MONITOR_MS : null;
    case "verifying":
      return nowMs + STANDBY_TICK_MS;
    case "armed":
      return nowMs + REARM_MONITOR_MS;
    case "pending":
      return outcome.stuck === true ? nowMs + REARM_STUCK_BACKOFF_MS : backoff;
  }
}

export interface StandbyRearmRoundDeps {
  readonly rearmStore: Pick<CoordinatorRearmStore["Service"], "list">;
  readonly rearmOnce: (entry: RearmEntry) => Effect.Effect<RearmOutcome>;
  /** The epoch this machine's copy coordinates at now, to key retries; undefined when none. */
  readonly bindingEpoch: (projectId: string) => Effect.Effect<number | undefined>;
  readonly held: Effect.Effect<boolean>;
}

/**
 * The re-arm round, apart from its schedule: each entry with a consent or a
 * run still going whose retry is due, at most a few per round. A new consent
 * or a new epoch starts its retries over.
 */
export const makeStandbyRearmRound = (deps: StandbyRearmRoundDeps) => {
  const retry = new Map<
    string,
    {
      readonly failures: number;
      readonly atMs: number | null;
      readonly consentUpdatedAt: string | null;
    }
  >();

  const round = Effect.gen(function* () {
    if (yield* deps.held) return 0;
    const nowMs = yield* Clock.currentTimeMillis;
    const entries = yield* deps.rearmStore.list;
    const live = new Set<string>();
    let called = 0;
    for (const entry of entries) {
      if (entry.consent === null && (entry.run === null || entry.run.state === "stopped")) continue;
      const epoch = yield* deps.bindingEpoch(entry.projectId);
      const key = `${entry.logicalProjectId}|${epoch ?? "none"}`;
      live.add(key);
      const waiting = retry.get(key);
      const fresh = waiting !== undefined && waiting.consentUpdatedAt !== entry.consentUpdatedAt;
      if (waiting !== undefined && !fresh && (waiting.atMs === null || nowMs < waiting.atMs))
        continue;
      if (called >= REARM_PROJECTS_PER_ROUND) continue;
      const outcome = yield* deps.rearmOnce(entry);
      // A copy that does not coordinate after a takeover read only local state; it takes no turn.
      if (outcome.kind !== "idle") called += 1;
      const failures =
        outcome.kind === "failed" || (outcome.kind === "run" && outcome.run.state === "pending")
          ? (fresh ? 0 : (waiting?.failures ?? 0)) + 1
          : 0;
      retry.set(key, {
        failures,
        atMs: nextAttemptMs(outcome, Math.max(failures, 1), nowMs),
        consentUpdatedAt: entry.consentUpdatedAt,
      });
    }
    for (const key of retry.keys()) if (!live.has(key)) retry.delete(key);
    return called;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Coordinator re-arm loop failed", { cause }).pipe(Effect.as(0)),
    ),
  );

  return { round } as const;
};

/**
 * Runs the re-arm round every 30 seconds for as long as the server runs,
 * parked until the server is activated so it never delays startup. The
 * stores are the same layer values the lease loop and ProjectLink use, so
 * one lock guards each file.
 */
const layerLoop = Layer.effectDiscard(
  Effect.gen(function* () {
    const rearmStore = yield* CoordinatorRearmStore;
    const leaseStore = yield* CoordinatorLeaseStore;
    const link = yield* ProjectLink;
    const projects = yield* ProjectService.ProjectService;
    const peers = yield* HandoffPeers;
    const client = yield* RemoteStudioMcpClient;
    const targets = yield* FleetTargets;
    const grants = yield* FleetWorkerGrants;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const updateHold = yield* ServiceUpdateHold.optional;
    const loadProject = (projectId: ProjectId) =>
      projects.getById(projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
    // A read that failed is not a project that is gone: the round fails and backs off instead.
    const loadProjectOrFail = (projectId: ProjectId) =>
      projects.getById(projectId).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);
    yield* forkParked(
      Effect.gen(function* () {
        const selfEnvironmentId = yield* environment.getEnvironmentId;
        const rearm = makeStandbyRearm({
          rearmStore,
          leaseStore,
          loadProject: loadProjectOrFail,
          rearmStandby: link.rearmStandby,
          probe: (environmentId, logicalProjectId, projectId) =>
            peers.linkedDigest(EnvironmentId.make(environmentId), {
              protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
              logicalProjectId,
              projectId: ProjectId.make(projectId),
            }),
          claimStandby: (input) =>
            client
              .call({
                machineId: input.machineId,
                tool: "studio_coordinator_claim_epoch",
                timeoutMs: REARM_CALL_TIMEOUT_MS,
                arguments: {
                  logicalProjectId: input.logicalProjectId,
                  epoch: input.epoch,
                  standby: { chainId: input.chainId },
                },
              })
              .pipe(Effect.exit, Effect.map(classifyClaim)),
          fleetMachineFor: (environmentId) => fleetMachineFor(targets, environmentId),
          grantStatus: grants.status,
          selfEnvironmentId,
        });
        const loop = makeStandbyRearmRound({
          rearmStore,
          rearmOnce: rearm.rearmOnce,
          bindingEpoch: (projectId) =>
            Effect.map(loadProject(ProjectId.make(projectId)), (project) => {
              const binding = project?.workspaceSettings?.coordinatorBinding;
              return binding?.state === "active" ? binding.epoch : undefined;
            }),
          held: updateHold.isHeld,
        });
        yield* loop.round.pipe(
          Effect.repeat(Schedule.spaced(Duration.millis(STANDBY_TICK_MS))),
          Effect.asVoid,
        );
      }),
    );
  }),
);

export const layer = layerLoop.pipe(
  Layer.provide(Layer.merge(CoordinatorRearmStoreLayer, CoordinatorLeaseStoreLayer)),
);
