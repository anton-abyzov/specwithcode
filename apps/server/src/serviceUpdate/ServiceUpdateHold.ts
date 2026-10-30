/**
 * Keeps a drained service quiet while its update helper snapshots and installs.
 *
 * "Update now" stops every running task, then asks the update agent to install.
 * The helper (`scripts/studio-fleet/update.py`) refuses while any run, request,
 * effect or working session is left, and its apply step refuses again when a
 * guarded row changed after the snapshot. Without a hold, a coordinator wake, a
 * schedule or a message sent meanwhile would start new work and the install
 * would wait or fail. While held, commands that start work are refused with a
 * message the person sees, and background sources skip their ticks.
 *
 * The hold lives in memory: the restart that installs the update ends it. It
 * also ends when its time runs out, when it is released, and when the update
 * agent records that it handled this hold's request (`updates/state.json`
 * handledInstallRequestAt equals `updates/config.json` installRequestedAt), and
 * when no request arrives soon after the drain while the agent is idle (an app
 * restart that drained a service it did not take down).
 * While the agent is still snapshotting or installing that request the time
 * limit moves with it, up to `HOLD_MAX_MS`.
 *
 * Across the restart the install gate takes over (`UpdateInstallGate`): while
 * the helper's gate file is live, `isHeld` is true in the new process too, so
 * nothing starts before the helper has verified (or rolled back) the release.
 * While held, the service also keeps `updates/hold.json` (its pid, when the
 * hold began and when it ends) for the update helper: `update.py --reap` stops
 * leftover processes only beneath the process this file names, and only for a
 * request made during this hold. The file is removed when the hold ends.
 *
 * One hold outlives its process: when the helper restarts a service held for a
 * forced request because it lost its database locks or runs on a deleted
 * database log (`database_restart.py`), it records that request, its run,
 * where the hold ended (`until`) and how far it could have moved (`ceiling`:
 * `HOLD_MAX_MS` from its start, or from the request for a hold that was
 * itself carried, never past the `ceiling` that
 * hold names nor the end of one that names none, and never short of `until`)
 * in `updates/database-restart.json`. The restarted service holds
 * itself again for that request at startup (`carriedHoldFor`) while the
 * request is still open and `ceiling` is ahead: from where the old hold ended,
 * moving with the agent as the old one moved, never past `ceiling`. Its
 * `hold.json` then names the request and `ceiling`, and
 * `update_service.assert_held` accepts it for that request only. Services from
 * 1.0.108 that predate `ceiling` read only `until` and hold to it.
 *
 * @module ServiceUpdateHold
 */
import {
  SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
  SERVICE_UPDATE_VERIFYING_MESSAGE,
  type OrchestrationV2ServerCommand,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as NodeCrypto from "../nodeCrypto.ts";
import * as UpdateInstallGate from "./UpdateInstallGate.ts";

export { SERVICE_UPDATE_IN_PROGRESS_MESSAGE, SERVICE_UPDATE_VERIFYING_MESSAGE };

/** Refused because the service is held for an update; the message is shown as is. */
export class ServiceUpdateInProgressError extends Schema.TaggedError<ServiceUpdateInProgressError>()(
  "ServiceUpdateInProgressError",
  { action: Schema.String, verifying: Schema.optional(Schema.Boolean) },
) {
  override get message(): string {
    return this.verifying === true
      ? SERVICE_UPDATE_VERIFYING_MESSAGE
      : SERVICE_UPDATE_IN_PROGRESS_MESSAGE;
  }
}

/** Backstop: a hold whose request the agent never takes up ends after this long. */
export const HOLD_TTL_MS = 15 * 60_000;
/**
 * A hold taken before an app restart. The restart that takes a bundled service
 * down ends it at once; a service that outlives the app must not stay held for
 * long when no install follows.
 */
export const APP_RESTART_HOLD_TTL_MS = 90_000;
/**
 * A hold the update agent has no install request for after this long ends with
 * reason `no-request`, unless the agent is busy: the desktop writes the request
 * within seconds of the drain, so a hold without one has nothing to wait for.
 */
export const NO_REQUEST_RELEASE_MS = 60_000;
/**
 * The longest a hold lasts while the agent stays busy on its request: the
 * agent's retry window (FORCE_WINDOW, 15 min), a snapshot begun at its end
 * (SNAPSHOT_TIMEOUT, 10 min), an install refused right before its restart
 * (APPLY_TIMEOUT less the helper's 12-minute restart reserve, 28 min), the
 * retry's own window and snapshot (APPLY_RETRY_WINDOW, 2 min, and 10 min), one
 * more whole install (40 min) and slack. An agent that dies while it reports
 * `installing` ends its hold `AGENT_APPLY_TIMEOUT_MS` after that write instead.
 */
export const HOLD_MAX_MS = 110 * 60_000;
/** How often a held service reads the update agent's state. */
export const AGENT_POLL_MS = 5_000;
/** How often a held service looks for an install gate to acknowledge (`UpdateInstallGate` INSTALL_GATE_ACK_FILE). */
export const GATE_ACK_POLL_MS = 100;
/** `update_agent.py` SNAPSHOT_TIMEOUT: a snapshot begun just before its deadline runs this long. */
export const AGENT_SNAPSHOT_TIMEOUT_MS = 600_000;
/** `update_agent.py` RETRY_SECONDS: a forced pass gives up once its next retry would pass the deadline. */
export const AGENT_RETRY_MS = 10_000;
/**
 * What a forced pass's statuses begin with while it snapshots again after a
 * refused apply, at any time: agents up to 1.0.112 write exactly this once.
 */
export const AGENT_APPLY_RETRY_MESSAGE = "New work started before the restart; trying again";
/**
 * `update_agent.py` APPLY_RETRY_WINDOW: after a refused apply the agent snapshots
 * again at least this long from its last status, even past installHoldUntil.
 */
export const AGENT_APPLY_RETRY_WINDOW_MS = 2 * 60_000;
/** `update_agent.py` APPLY_TIMEOUT: how long the agent waits for one install. */
export const AGENT_APPLY_TIMEOUT_MS = 2_400_000;
/**
 * Agent statuses (`update_agent.py` STATUSES) written while a pass still works
 * on a request. Every other status the agent writes once it handled the request
 * (`handledInstallRequestAt`) means it finished or gave up. A `downloaded` it
 * writes mid-pass, before it snapshots, is not handled and does not count.
 */
export const AGENT_BUSY_STATUSES = ["downloading", "waiting-for-quiet", "installing"] as const;

/**
 * Commands that start or resume work: a new run, a queued run, a provider
 * session, an effect, or a thread that a run would follow. Everything the drain
 * itself sends (interrupt, cancel, settle, stop, dismiss) is not listed.
 */
export const HELD_COMMAND_TYPES: ReadonlySet<OrchestrationV2ServerCommand["type"]> = new Set<
  OrchestrationV2ServerCommand["type"]
>([
  "message.dispatch",
  "prepared-run.release",
  "prepared-run.retry",
  "queue.resume",
  "queued-message.promote-to-steer",
  "delegated_task.request",
  "thread.create",
  "thread.fork",
  "thread.merge_back",
  "provider.switch",
  "checkpoint.rollback",
  "runtime-request.respond",
]);

/** `updates/hold.json`, read by `update.py --reap` (scripts/studio-fleet). */
export const HOLD_MARKER_FILE = "hold.json";

const encodeHoldMarker = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** What the hold records for the update helper: which process is held, and for how long. */
export const holdMarkerContent = (hold: ServiceUpdateHoldState, pid: number) => ({
  schemaVersion: 1,
  pid,
  holdId: hold.holdId,
  startedAt: DateTime.formatIso(DateTime.makeUnsafe(hold.startedAtMs)),
  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(hold.expiresAtMs)),
  ...(hold.request === undefined ? {} : { request: hold.request }),
  ...(hold.carriedCeilingMs === undefined
    ? {}
    : { ceiling: DateTime.formatIso(DateTime.makeUnsafe(hold.carriedCeilingMs)) }),
});

/**
 * `updates/database-restart.json`, written by the update helper before it
 * restarts the service (`database_restart.py` restart_marker): the restarted
 * pid and when, and for a held service the forced request (`request:`), its
 * `installRunId:`, where the old hold ended (`until:`) and how far it could
 * have moved (`ceiling:`; helpers before this release name none).
 */
export const DATABASE_RESTART_MARKER_FILE = "database-restart.json";

const decodeRestartMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      servicePid: Schema.optional(Schema.Unknown),
      restartedAt: Schema.optional(Schema.Unknown),
      request: Schema.optional(Schema.Unknown),
      installRunId: Schema.optional(Schema.Unknown),
      until: Schema.optional(Schema.Unknown),
      ceiling: Schema.optional(Schema.Unknown),
    }),
  ),
);

/** What startup reads to decide on a carried hold, each file as decoded JSON. */
export interface CarriedHoldInput {
  readonly marker: {
    readonly servicePid?: unknown;
    readonly restartedAt?: unknown;
    readonly request?: unknown;
    readonly installRunId?: unknown;
    readonly until?: unknown;
    readonly ceiling?: unknown;
  };
  readonly config: {
    readonly installMode?: unknown;
    readonly installRequestedAt?: unknown;
    readonly installCancelledAt?: unknown;
    readonly installHoldUntil?: unknown;
    readonly installRunId?: unknown;
  };
  /** `state.json` handledInstallRequestAt. */
  readonly handledInstallRequestAt: unknown;
  readonly pid: number;
  readonly nowMs: number;
}

/**
 * The hold a restarted service takes at startup for the forced request the
 * helper restarted it under, or null. Only when the marker names another pid,
 * a restart at or before now, a request that `config.json` still asks to
 * force-install with the same run and has not cancelled, that the agent has
 * not finished with, and a `ceiling` still ahead. A helper naming a ceiling
 * carries an extended hold even after the original `installHoldUntil` passed.
 * `until` is where the old hold ended, and `ceiling` as far as it
 * could have moved (`database_restart.restart_marker`; a carried hold counts
 * from the request, as `carriedFromMs` does): the carried hold's end starts at
 * `until`, or four agent polls after startup when that is later (`until`
 * passed during the restart, or comes sooner), and moves with the agent as the
 * old one did, never past `ceiling`. A marker from
 * a helper before this release names no `ceiling`: the hold then ends at
 * `until`, within the original request window, as it did there.
 */
export function carriedHoldFor(input: CarriedHoldInput): {
  readonly request: string;
  readonly requestedAtMs: number;
  readonly endMs: number;
  readonly ceilingMs: number;
} | null {
  const { marker, config, nowMs } = input;
  const request = marker.request;
  if (typeof request !== "string" || request !== config.installRequestedAt) return null;
  if (config.installMode !== "force" || input.handledInstallRequestAt === request) return null;
  if (typeof marker.servicePid !== "number" || marker.servicePid === input.pid) return null;
  if ((marker.installRunId ?? null) !== (config.installRunId ?? null)) return null;
  const requestedAtMs = epochMillis(request);
  const restartedAtMs = epochMillis(marker.restartedAt);
  const endMs = epochMillis(marker.until);
  const ceilingMs = marker.ceiling === undefined ? endMs : epochMillis(marker.ceiling);
  if (requestedAtMs === null || restartedAtMs === null || endMs === null || ceilingMs === null)
    return null;
  if (requestedAtMs > restartedAtMs || restartedAtMs > nowMs || nowMs >= ceilingMs) return null;
  if (config.installCancelledAt !== undefined && config.installCancelledAt !== null) {
    const cancelledAtMs = epochMillis(config.installCancelledAt);
    if (cancelledAtMs === null || cancelledAtMs > requestedAtMs) return null;
  }
  const holdUntilMs = epochMillis(config.installHoldUntil);
  // The initial request window does not bound an active apply retry. The helper
  // carried its live hold's ceiling; older helpers still use the original gate.
  if (marker.ceiling === undefined && holdUntilMs !== null && holdUntilMs <= nowMs) return null;
  return { request, requestedAtMs, endMs, ceilingMs };
}

export interface ServiceUpdateHoldState {
  readonly holdId: string;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  /** Who asked for the hold (`acquire`'s reason): "install" or "app-restart". */
  readonly reason?: string;
  /** Present only for a conditional restart owned by one caller. */
  readonly leaseToken?: string | undefined;
  /** A hold carried across a database restart: the forced request it holds for. */
  readonly request?: string;
  /** A carried hold: as far as the old hold could have moved; it never moves past this. */
  readonly carriedCeilingMs?: number;
}

export interface ServiceUpdateHoldShape {
  /**
   * Holds the service, or extends the current hold; only requests made after
   * this count. `reason` names the caller in the logs.
   */
  readonly acquire: (input?: {
    readonly ttlMs?: number;
    readonly reason?: string;
    /**
     * Held for a drain still under way: no install request can come before it
     * ends, so a missing one does not end the hold. The drain acquires again
     * without it when it is done.
     */
    readonly draining?: boolean;
  }) => Effect.Effect<ServiceUpdateHoldState>;
  /** Atomically closes admission only when no other hold or install gate exists. */
  readonly acquireIfUnheld: (ttlMs: number) => Effect.Effect<Option.Option<ServiceUpdateHoldState>>;
  /** Extends only this caller's still-live conditional lease. */
  readonly confirmLease: (
    token: string,
    ttlMs: number,
  ) => Effect.Effect<Option.Option<ServiceUpdateHoldState>>;
  readonly releaseLease: (token: string, reason: string) => Effect.Effect<boolean>;
  /** Registers admitted work through its commit; unrelated threads can still run concurrently. */
  readonly withAdmission: <A, E, R>(
    action: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ServiceUpdateInProgressError, R>;
  readonly awaitAdmissions: Effect.Effect<void>;
  /** Ends the hold; false when none was held. */
  readonly release: (reason: string) => Effect.Effect<boolean>;
  /**
   * How many holds ended in this process. A restart that installs the update
   * ends the process instead, so this only counts holds released, expired or
   * given up while the service kept running.
   */
  readonly releaseCount: Effect.Effect<number>;
  /**
   * Counts a command refused while held. The first refusal of each hold is
   * logged; the release logs how many followed.
   */
  readonly recordRefusal: (action: string) => Effect.Effect<void>;
  /** The hold "Update now" set in this process, if any. */
  readonly current: Effect.Effect<Option.Option<ServiceUpdateHoldState>>;
  /** True while the update helper's install gate is live (see `UpdateInstallGate`). */
  readonly installGated: Effect.Effect<boolean>;
  /** Held, or gated: nothing may start work. */
  readonly isHeld: Effect.Effect<boolean>;
  /** Waits until the service is neither held nor gated. Returns at once when it is not. */
  readonly awaitReleased: Effect.Effect<void>;
  /**
   * Whether the update agent reports a release on its way or ready to install.
   * The service is only held for one: a hold for nothing would just block work.
   */
  readonly updatePending: Effect.Effect<boolean>;
  /**
   * Whether an install request the agent has not finished with is still live
   * (`installRequestOpen`): the update it asks for is not over yet, even while
   * nothing holds the service between two drains for it.
   */
  readonly installRequestOpen: Effect.Effect<boolean>;
  /**
   * Whether an automatic install still waits for a quiet moment or is
   * installing (`automaticInstallUnderway`): what its stale-wait sweep closed
   * is asked again only once it is not.
   */
  readonly automaticInstallUnderway: Effect.Effect<boolean>;
}

/** Agent statuses with a release found, downloading, ready or installing. */
export const UPDATE_PENDING_STATUSES = [
  "available",
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installing",
] as const;

/** `update_agent.py` SEMVER: the only versions the agent writes. */
const AGENT_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

const agentVersionParts = (value: unknown): ReadonlyArray<number> | null => {
  const match = typeof value === "string" ? AGENT_VERSION.exec(value) : null;
  return match === null ? null : match.slice(1).map(Number);
};

/**
 * Whether the agent offers a release to install. Besides a pending status, a
 * failed or manual pass (`error`, `manual-required`) still names the release
 * it was on; "Try again" must hold the service for that one too.
 */
export function updatePendingFor(reading: AgentStateReading): boolean {
  if ((UPDATE_PENDING_STATUSES as ReadonlyArray<unknown>).includes(reading.status)) return true;
  const installed = agentVersionParts(reading.installedVersion);
  const offered = agentVersionParts(reading.downloadedVersion ?? reading.availableVersion);
  if (installed === null || offered === null) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (offered[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Whether the desktop's install request is still under way: written, not yet
 * handled by the agent (it marks one handled when an attempt completes or
 * fails for good), and within its time (a forced request's `installHoldUntil`,
 * otherwise `HOLD_TTL_MS` from the request). A cancel clears the request.
 */
export function installRequestOpen(reading: AgentStateReading, nowMs: number): boolean {
  const requestedAtMs = epochMillis(reading.installRequestedAt);
  if (requestedAtMs === null) return false;
  if (reading.handledInstallRequestAt === reading.installRequestedAt) return false;
  return (reading.installHoldUntilMs ?? requestedAtMs + HOLD_TTL_MS) > nowMs;
}

/** Agent statuses of an install that still waits for quiet or is installing. */
const AUTOMATIC_INSTALL_STATUSES: ReadonlyArray<unknown> = ["waiting-for-quiet", "installing"];

/**
 * Whether the update agent still waits for a quiet moment to install, or is
 * installing. Installed, failed, cancelled or never started: it is not.
 */
export function automaticInstallUnderway(reading: Pick<AgentStateReading, "status">): boolean {
  return AUTOMATIC_INSTALL_STATUSES.includes(reading.status);
}

export class ServiceUpdateHold extends Context.Service<ServiceUpdateHold, ServiceUpdateHoldShape>()(
  "specweave-studio/serviceUpdate/ServiceUpdateHold",
) {}

/** What the agent last wrote and was asked, reduced to what the hold needs. */
export interface AgentStateReading {
  readonly status: unknown;
  readonly message: unknown;
  /** `updatedAt` from `state.json`, or its modification time; null when neither is known. */
  readonly updatedAtMs: number | null;
  /** `state.json` handledInstallRequestAt: the last request the agent finished with. */
  readonly handledInstallRequestAt: unknown;
  /**
   * `state.json` answeredInstallRequestAt: the install request the pass that wrote the status served, "" when
   * it served none (an automatic pass). Null when the pass named none: it failed before naming one (reading
   * its settings or its installation, say), or reported an install an earlier pass left interrupted while a
   * request was pending. Older agents leave it out.
   */
  readonly answeredInstallRequestAt?: unknown;
  /** `config.json` installRequestedAt: the request the desktop wrote last. */
  readonly installRequestedAt: unknown;
  /** `config.json` installHoldUntil of a forced request: when the agent stops retrying. */
  readonly installHoldUntilMs: number | null;
  /** `state.json` versions: running, offered, and offered with its download verified. */
  readonly installedVersion?: unknown;
  readonly availableVersion?: unknown;
  readonly downloadedVersion?: unknown;
}

export type AgentVerdict =
  /** Nothing to act on: no request for this hold yet, or the agent is not on it. */
  | { readonly type: "none" }
  /** The agent handled this hold's request and finished with `status`. */
  | { readonly type: "settled"; readonly status: string }
  /** The agent is still on this hold's request; keep the hold up to `untilMs`. */
  | { readonly type: "busy"; readonly untilMs: number };

const epochMillis = (value: unknown): number | null =>
  typeof value === "string"
    ? Option.getOrNull(Option.map(DateTime.make(value), DateTime.toEpochMillis))
    : null;

/**
 * Whether the agent's files hold an install request made since `startedAtMs`,
 * or the agent's record of one it handled.
 */
export function hasRequestSince(reading: AgentStateReading, startedAtMs: number): boolean {
  const requestedAtMs =
    epochMillis(reading.installRequestedAt) ?? epochMillis(reading.handledInstallRequestAt);
  return requestedAtMs !== null && requestedAtMs >= startedAtMs;
}

/**
 * What the agent's files say about the request made for a hold that began at
 * `startedAtMs`. Only a request written after the hold began counts, and only
 * the agent's own record that it handled that request settles it: a status
 * left by a pass that began before the request, or written mid-pass, does not.
 */
export function agentVerdictForHold(input: {
  readonly reading: AgentStateReading;
  readonly startedAtMs: number;
  readonly maxMs?: number;
}): AgentVerdict {
  const { reading, startedAtMs } = input;
  // A cancel clears the request; an install the cancel came too late for is
  // still followed through the request the agent recorded as handled.
  const requestKey =
    epochMillis(reading.installRequestedAt) !== null
      ? reading.installRequestedAt
      : reading.handledInstallRequestAt;
  const requestedAtMs = epochMillis(requestKey);
  if (requestedAtMs === null || requestedAtMs < startedAtMs) return { type: "none" };
  if (typeof reading.status !== "string") return { type: "none" };
  const status = reading.status;
  const busy = (AGENT_BUSY_STATUSES as ReadonlyArray<string>).includes(status);
  const handled = reading.handledInstallRequestAt === requestKey;
  if (handled && !busy) return { type: "settled", status };
  const updatedAtMs = reading.updatedAtMs;
  // Some failures end the pass without marking the request handled; holding
  // the service on until the time limit would only block its users. One
  // written in the request's own millisecond is not about it: the agent had
  // not read it yet. Nor is one from a pass that served another request, or
  // none (""): the pass that serves this request answers it.
  const answered = reading.answeredInstallRequestAt ?? null;
  if (
    (status === "error" || status === "manual-required") &&
    (answered === null || answered === requestKey) &&
    updatedAtMs !== null &&
    updatedAtMs > requestedAtMs
  )
    return { type: "settled", status };
  // Freshness is measured from the hold, not the latest request: a window that
  // asks again while a long snapshot runs must not end the extension.
  if (!busy || updatedAtMs === null || updatedAtMs < startedAtMs) return { type: "none" };
  const ceiling = startedAtMs + (input.maxMs ?? HOLD_MAX_MS);
  // The agent marks the request handled just before it installs it.
  // It writes nothing while the helper runs, which ends within APPLY_TIMEOUT.
  if (status === "installing")
    return handled
      ? {
          type: "busy",
          untilMs: Math.min(ceiling, updatedAtMs + AGENT_APPLY_TIMEOUT_MS + AGENT_RETRY_MS),
        }
      : { type: "none" };
  if (handled) return { type: "none" };
  const deadline = reading.installHoldUntilMs ?? startedAtMs + HOLD_TTL_MS;
  // A refused apply's retry may come long after the deadline (a 40-minute
  // install); it snapshots again within a window of its own, from each status.
  const applyRetry =
    typeof reading.message === "string" && reading.message.startsWith(AGENT_APPLY_RETRY_MESSAGE);
  // Written once no retry fits before the deadline: the pass gave up. Only TTL ends the hold.
  if (status === "waiting-for-quiet" && updatedAtMs >= deadline - AGENT_RETRY_MS && !applyRetry)
    return { type: "none" };
  const lastSnapshotAtMs = applyRetry
    ? Math.max(deadline, updatedAtMs + AGENT_APPLY_RETRY_WINDOW_MS)
    : deadline;
  return { type: "busy", untilMs: Math.min(ceiling, lastSnapshotAtMs + AGENT_SNAPSHOT_TIMEOUT_MS) };
}

const decodeAgentState = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.optional(Schema.Unknown),
      message: Schema.optional(Schema.Unknown),
      updatedAt: Schema.optional(Schema.Unknown),
      handledInstallRequestAt: Schema.optional(Schema.Unknown),
      answeredInstallRequestAt: Schema.optional(Schema.Unknown),
      installedVersion: Schema.optional(Schema.Unknown),
      availableVersion: Schema.optional(Schema.Unknown),
      downloadedVersion: Schema.optional(Schema.Unknown),
    }),
  ),
);

const decodeAgentConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      installRequestedAt: Schema.optional(Schema.Unknown),
      installMode: Schema.optional(Schema.Unknown),
      installHoldUntil: Schema.optional(Schema.Unknown),
      installCancelledAt: Schema.optional(Schema.Unknown),
      installRunId: Schema.optional(Schema.Unknown),
    }),
  ),
);

export interface ServiceUpdateHoldOptions {
  /** The update agent's `updates/state.json`. */
  readonly agentStatePath: string;
  /** Where the desktop writes install requests; `config.json` beside the state by default. */
  readonly agentConfigPath?: string;
  /** Where the hold is recorded for the update helper; `hold.json` beside the state by default. */
  readonly holdMarkerPath?: string;
  /** The helper's restart marker; `database-restart.json` beside the state by default. */
  readonly restartMarkerPath?: string;
  readonly pollMs?: number;
  /** Overrides `HOLD_MAX_MS`, for tests. */
  readonly maxMs?: number;
  /** Overrides `NO_REQUEST_RELEASE_MS`, for tests. */
  readonly noRequestMs?: number;
  /** The helper's install gate; `install-gate.json` beside the state by default. */
  readonly installGatePath?: string;
  /** How often a held service looks for a gate to acknowledge; `GATE_ACK_POLL_MS` by default. */
  readonly gateAckPollMs?: number;
  /** Whether the helper named by the gate still runs; for tests. */
  readonly isAlive?: (pid: number) => boolean;
  /** When the machine started (epoch ms), null when unknown; read from the OS by default. */
  readonly bootMs?: number | null;
}

export const makeWithOptions = (options: ServiceUpdateHoldOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agentConfigPath =
      options.agentConfigPath ?? path.join(path.dirname(options.agentStatePath), "config.json");
    const holdMarkerPath =
      options.holdMarkerPath ?? path.join(path.dirname(options.agentStatePath), HOLD_MARKER_FILE);
    const pollMs = options.pollMs ?? AGENT_POLL_MS;
    const noRequestMs = options.noRequestMs ?? NO_REQUEST_RELEASE_MS;
    const installGatePath =
      options.installGatePath ??
      path.join(path.dirname(options.agentStatePath), UpdateInstallGate.INSTALL_GATE_FILE);
    const { read: readGateUntil } = yield* UpdateInstallGate.makeInstallGateReader({
      gatePath: installGatePath,
      bootMs: options.bootMs === undefined ? UpdateInstallGate.machineBootMs() : options.bootMs,
      isAlive: options.isAlive ?? UpdateInstallGate.isHelperRunning,
    });
    // Read before anything can start: a process started by the install begins gated.
    const gateUntil = yield* Ref.make(yield* readGateUntil);
    if ((yield* Ref.get(gateUntil)) !== null) {
      yield* Effect.logInfo("service-update.gate.closed", { at: "startup" });
    }
    const refreshGate = Effect.gen(function* () {
      const next = yield* readGateUntil;
      const previous = yield* Ref.getAndSet(gateUntil, next);
      if ((previous === null) !== (next === null)) {
        yield* Effect.logInfo(
          next === null ? "service-update.gate.opened" : "service-update.gate.closed",
        );
      }
    });
    // A gate written while the service runs counts from the next check, not the next poll: the
    // helper writes it before its last row checks, and a scheduler tick, a webhook or a "run
    // now" let through meanwhile would change those rows. While the cached reading says open,
    // a gate file that is present is read on the spot; an absent one costs one stat. The poll
    // still notices the gate opening, so a live gate is not re-read here.
    const gateFilePresent = fileSystem
      .exists(installGatePath)
      .pipe(Effect.orElseSucceed(() => false));
    const installGated = Effect.gen(function* () {
      let until = yield* Ref.get(gateUntil);
      if (until === null && (yield* gateFilePresent)) {
        yield* refreshGate;
        until = yield* Ref.get(gateUntil);
      }
      return until !== null && (yield* Clock.currentTimeMillis) < until;
    });
    type HeldState = ServiceUpdateHoldState & {
      readonly released: Deferred.Deferred<void>;
      readonly reason: string;
      /** With no install request by then (and an idle agent) the hold ends. */
      readonly requestDueAtMs: number;
      /** A carried hold: when its request was made. */
      readonly carriedFromMs?: number;
    };
    const state = yield* Ref.make<Option.Option<HeldState>>(Option.none());
    const admissionLock = yield* Semaphore.make(1);
    let admissions = 0;
    let admissionsDone = yield* Deferred.make<void>();
    yield* Deferred.succeed(admissionsDone, undefined);
    let holds = 0;
    const releases = yield* Ref.make(0);
    // Commands refused under the current hold: the first is logged, the rest counted.
    let refusals = { holdId: "", count: 0 };

    // Best effort: without the file the helper refuses to reap, which is the safe outcome.
    // One writer at a time, and a write only while the hold it describes is current, so a
    // release can never be followed by a stale file.
    const markerLock = yield* Semaphore.make(1);
    const writeMarker = (hold: ServiceUpdateHoldState) =>
      markerLock.withPermits(1)(
        Effect.gen(function* () {
          const held = yield* Ref.get(state);
          if (
            Option.isNone(held) ||
            held.value.holdId !== hold.holdId ||
            held.value.startedAtMs !== hold.startedAtMs ||
            held.value.expiresAtMs !== hold.expiresAtMs
          )
            return;
          const temporary = `${holdMarkerPath}.${process.pid}.tmp`;
          const content = yield* encodeHoldMarker(holdMarkerContent(hold, process.pid));
          yield* fileSystem.writeFileString(temporary, `${content}\n`, { mode: 0o600 });
          yield* fileSystem.rename(temporary, holdMarkerPath);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("service-update.hold.marker-write-failed", { cause }),
          ),
        ),
      );
    const removeMarker = markerLock.withPermits(1)(
      Effect.gen(function* () {
        if (Option.isSome(yield* Ref.get(state))) return;
        yield* fileSystem.remove(holdMarkerPath, { force: true });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("service-update.hold.marker-remove-failed", { cause }),
        ),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Ref.set(state, Option.none());
        yield* removeMarker;
      }),
    );

    // Read before anything can start: a service the helper restarted while it was held for a
    // forced request holds itself again for that request, as long as the old hold could have.
    const readDecoded = <A>(file: string, decode: (input: string) => Option.Option<A>) =>
      fileSystem.readFileString(file).pipe(
        Effect.map(decode),
        Effect.orElseSucceed(() => Option.none<A>()),
      );
    const restartMarker = yield* readDecoded(
      options.restartMarkerPath ??
        path.join(path.dirname(options.agentStatePath), DATABASE_RESTART_MARKER_FILE),
      decodeRestartMarker,
    );
    if (Option.isSome(restartMarker) && restartMarker.value.request !== undefined) {
      const config = yield* readDecoded(agentConfigPath, decodeAgentConfig);
      const agent = yield* readDecoded(options.agentStatePath, decodeAgentState);
      const now = yield* Clock.currentTimeMillis;
      const carried = Option.isSome(config)
        ? carriedHoldFor({
            marker: restartMarker.value,
            config: config.value,
            handledInstallRequestAt: Option.getOrUndefined(agent)?.handledInstallRequestAt,
            pid: process.pid,
            nowMs: now,
          })
        : null;
      if (carried === null) {
        yield* Effect.logInfo("service-update.hold.not-carried", {
          request: String(restartMarker.value.request),
        });
      } else {
        const value = {
          holdId: `service-update-hold:${now}:${(holds += 1)}`,
          startedAtMs: now,
          // Where the old hold ended, or four polls on when it ends sooner (a restart that outlasted
          // it): check moves it on while the agent works on the request, as it moved the old one.
          expiresAtMs: Math.min(carried.ceilingMs, Math.max(carried.endMs, now + 4 * pollMs)),
          released: yield* Deferred.make<void>(),
          reason: "install",
          // A cancel clears the request: the hold then ends like any without one.
          requestDueAtMs: Math.min(carried.ceilingMs, now + noRequestMs),
          request: carried.request,
          carriedFromMs: carried.requestedAtMs,
          carriedCeilingMs: carried.ceilingMs,
        };
        yield* Ref.set(state, Option.some(value));
        yield* writeMarker(value);
        yield* Effect.logWarning("service-update.hold.carried", {
          holdId: value.holdId,
          request: carried.request,
          endMs: carried.endMs,
          ceilingMs: carried.ceilingMs,
        });
      }
    }

    const releaseMatching = (reason: string, matches: (hold: ServiceUpdateHoldState) => boolean) =>
      Effect.gen(function* () {
        const previous = yield* Ref.modify(
          state,
          (held): readonly [Option.Option<HeldState>, Option.Option<HeldState>] =>
            Option.isSome(held) && matches(held.value)
              ? ([held, Option.none()] as const)
              : ([Option.none(), held] as const),
        );
        if (Option.isNone(previous)) return false;
        yield* removeMarker;
        yield* Deferred.succeed(previous.value.released, undefined);
        yield* Ref.update(releases, (count) => count + 1);
        const now = yield* Clock.currentTimeMillis;
        // At Warn: the fleet logs nothing quieter, and a hold refuses everyone's work.
        yield* Effect.logWarning(
          reason === "expired" ? "service-update.hold.expired" : "service-update.hold.released",
          {
            holdId: previous.value.holdId,
            reason,
            acquiredFor: previous.value.reason,
            heldMs: now - previous.value.startedAtMs,
            refusals: refusals.holdId === previous.value.holdId ? refusals.count : 0,
          },
        );
        return true;
      });

    const release = (reason: string) => releaseMatching(reason, () => true);
    const releaseLease = (token: string, reason: string) =>
      releaseMatching(reason, (held) => held.leaseToken === token);

    const current: Effect.Effect<Option.Option<ServiceUpdateHoldState>> = Effect.gen(function* () {
      const held = yield* Ref.get(state);
      if (Option.isNone(held)) return Option.none<ServiceUpdateHoldState>();
      const { holdId, startedAtMs, expiresAtMs, reason, leaseToken, request } = held.value;
      if ((yield* Clock.currentTimeMillis) < expiresAtMs) {
        return Option.some({
          holdId,
          startedAtMs,
          expiresAtMs,
          reason,
          leaseToken,
          ...(request === undefined ? {} : { request }),
        });
      }
      yield* releaseMatching(
        "expired",
        (latest) => latest.holdId === holdId && latest.expiresAtMs === expiresAtMs,
      );
      return Option.none<ServiceUpdateHoldState>();
    });

    const acquireUnfenced: ServiceUpdateHoldShape["acquire"] = (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const ttlMs = input?.ttlMs ?? HOLD_TTL_MS;
        const expiresAtMs = now + ttlMs;
        const reason = input?.reason ?? "install";
        const requestDueAtMs = input?.draining === true ? expiresAtMs : now + noRequestMs;
        const existing = yield* current;
        const released = yield* Deferred.make<void>();
        const next = yield* Ref.modify(
          state,
          (held): readonly [HeldState, Option.Option<HeldState>] => {
            // An app restart's drain must not cut short, or orphan the request
            // of, an install hold already under way: that hold stays as it is.
            if (
              Option.isSome(held) &&
              held.value.reason === "install" &&
              held.value.leaseToken === undefined &&
              reason === "app-restart"
            )
              return [held.value, held] as const;
            // A repeated "Update now" asks the agent again: older requests no longer count.
            // A carried hold taken again is an ordinary one: it no longer names the old request,
            // and no caller's lease owns it any more.
            const value: HeldState = Option.isSome(held)
              ? {
                  holdId: held.value.holdId,
                  released: held.value.released,
                  startedAtMs: now,
                  expiresAtMs,
                  reason,
                  requestDueAtMs,
                }
              : {
                  holdId: `service-update-hold:${now}:${(holds += 1)}`,
                  startedAtMs: now,
                  expiresAtMs,
                  released,
                  reason,
                  requestDueAtMs,
                };
            return [value, Option.some(value)] as const;
          },
        );
        yield* writeMarker({
          holdId: next.holdId,
          startedAtMs: next.startedAtMs,
          expiresAtMs: next.expiresAtMs,
        });
        if (Option.isNone(existing)) {
          yield* Effect.logWarning("service-update.hold.acquired", {
            holdId: next.holdId,
            reason,
            ttlMs,
          });
        }
        return {
          holdId: next.holdId,
          startedAtMs: next.startedAtMs,
          expiresAtMs: next.expiresAtMs,
          reason: next.reason,
        };
      });

    const acquire: ServiceUpdateHoldShape["acquire"] = (input) =>
      admissionLock.withPermits(1)(acquireUnfenced(input));
    const acquireIfUnheld: ServiceUpdateHoldShape["acquireIfUnheld"] = (ttlMs) =>
      admissionLock.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isSome(yield* current) || (yield* installGated)) return Option.none();
          const leaseToken = NodeCrypto.randomBytes(32).toString("hex");
          const next = yield* acquireUnfenced({ ttlMs, reason: "install", draining: true });
          yield* Ref.update(state, (held) =>
            Option.map(held, (value) => ({ ...value, leaseToken })),
          );
          return Option.some({ ...next, leaseToken });
        }),
      );
    const confirmLease: ServiceUpdateHoldShape["confirmLease"] = (token, ttlMs) =>
      admissionLock.withPermits(1)(
        Effect.gen(function* () {
          const held = yield* current;
          if (Option.isNone(held) || held.value.leaseToken !== token || (yield* installGated))
            return Option.none();
          const now = yield* Clock.currentTimeMillis;
          const expiresAtMs = now + ttlMs;
          const next = yield* Ref.modify(
            state,
            (value): readonly [Option.Option<ServiceUpdateHoldState>, Option.Option<HeldState>] => {
              if (
                Option.isNone(value) ||
                value.value.leaseToken !== token ||
                value.value.expiresAtMs <= now
              )
                return [Option.none<ServiceUpdateHoldState>(), value] as const;
              const extended = { ...value.value, expiresAtMs, requestDueAtMs: expiresAtMs };
              return [Option.some(extended), Option.some(extended)] as const;
            },
          );
          if (Option.isSome(next)) yield* writeMarker(next.value);
          return next;
        }),
      );
    const withAdmission: ServiceUpdateHoldShape["withAdmission"] = (action, effect) =>
      Effect.acquireUseRelease(
        admissionLock.withPermits(1)(
          Effect.gen(function* () {
            const held = Option.isSome(yield* current);
            const gated = !held && (yield* installGated);
            if (held || gated) {
              yield* recordRefusal(action);
              return yield* new ServiceUpdateInProgressError({ action, verifying: gated });
            }
            if (admissions === 0) admissionsDone = yield* Deferred.make<void>();
            admissions += 1;
          }),
        ),
        () => effect,
        () =>
          Effect.gen(function* () {
            admissions -= 1;
            if (admissions === 0) yield* Deferred.succeed(admissionsDone, undefined);
          }),
      );
    const awaitAdmissions = Effect.suspend(() => Deferred.await(admissionsDone));

    const awaitReleased: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        if (Option.isNone(yield* current)) {
          if (!(yield* installGated)) return;
          // The gate opens when the poll sees its file gone, or at its time limit.
          yield* Effect.sleep(Duration.millis(pollMs));
          continue;
        }
        const held = yield* Ref.get(state);
        if (Option.isNone(held)) continue;
        const remaining = Math.max(0, held.value.expiresAtMs - (yield* Clock.currentTimeMillis));
        // Wakes on release, or at expiry so `current` can end the hold.
        yield* Deferred.await(held.value.released).pipe(
          Effect.timeoutOption(Duration.millis(remaining)),
        );
      }
    });

    const readAgentState = Effect.gen(function* () {
      const parsed = decodeAgentState(yield* fileSystem.readFileString(options.agentStatePath));
      if (Option.isNone(parsed)) return Option.none<AgentStateReading>();
      const raw = parsed.value;
      const updatedAtMs =
        epochMillis(raw.updatedAt) ??
        (yield* fileSystem
          .stat(options.agentStatePath)
          .pipe(
            Effect.map((info) =>
              Option.match(info.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
            ),
          ));
      // No settings file yet means no request: only the time limit applies.
      const config = yield* fileSystem.readFileString(agentConfigPath).pipe(
        Effect.map(decodeAgentConfig),
        Effect.orElseSucceed(() => Option.none()),
      );
      const request = Option.getOrUndefined(config);
      return Option.some<AgentStateReading>({
        status: raw.status,
        message: raw.message,
        updatedAtMs,
        handledInstallRequestAt: raw.handledInstallRequestAt,
        answeredInstallRequestAt: raw.answeredInstallRequestAt,
        installRequestedAt: request?.installRequestedAt,
        installHoldUntilMs:
          request?.installMode === "force" ? epochMillis(request.installHoldUntil) : null,
        installedVersion: raw.installedVersion,
        availableVersion: raw.availableVersion,
        downloadedVersion: raw.downloadedVersion,
      });
    }).pipe(
      // A missing or unreadable state file leaves only the time limit.
      Effect.orElseSucceed(() => Option.none<AgentStateReading>()),
    );

    const recordRefusal = (action: string) =>
      Effect.gen(function* () {
        const held = yield* Ref.get(state);
        if (Option.isNone(held)) return;
        if (refusals.holdId !== held.value.holdId)
          refusals = { holdId: held.value.holdId, count: 0 };
        refusals.count += 1;
        if (refusals.count === 1) {
          yield* Effect.logWarning("service-update.hold.refused-work", {
            holdId: held.value.holdId,
            acquiredFor: held.value.reason,
            action,
          });
        }
      });

    const check = Effect.gen(function* () {
      const held = yield* current;
      if (Option.isNone(held)) return;
      const reading = yield* readAgentState;
      if (Option.isNone(reading)) return;
      // A carried hold's request came before it began: it counts from the request.
      const carried = Option.match(yield* Ref.get(state), {
        onNone: () => undefined,
        onSome: (value) => (value.holdId === held.value.holdId ? value : undefined),
      });
      const sinceMs = carried?.carriedFromMs ?? held.value.startedAtMs;
      // A hold nobody asked the agent to install for (an app restart that did
      // not take the service down, a closed window) would refuse work until its
      // time runs out. Once the request had time to arrive, end it.
      if (
        !hasRequestSince(reading.value, sinceMs) &&
        !(AGENT_BUSY_STATUSES as ReadonlyArray<unknown>).includes(reading.value.status)
      ) {
        const now = yield* Clock.currentTimeMillis;
        const latest = yield* Ref.get(state);
        if (
          Option.isSome(latest) &&
          latest.value.startedAtMs === held.value.startedAtMs &&
          now >= latest.value.requestDueAtMs
        ) {
          yield* Effect.logWarning("service-update.hold.no-request", {
            holdId: latest.value.holdId,
            acquiredFor: latest.value.reason,
            heldMs: now - latest.value.startedAtMs,
            agentStatus: String(reading.value.status),
          });
          yield* release("no-request");
        }
        return;
      }
      const verdict = agentVerdictForHold({
        reading: reading.value,
        startedAtMs: sinceMs,
        ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
      });
      if (verdict.type === "settled") {
        yield* release(`agent-${verdict.status}`);
        return;
      }
      if (verdict.type !== "busy") return;
      // The agent does not rewrite its state during a long snapshot or install,
      // so the hold stays a few polls ahead while it is on this request. A
      // carried hold never moves past where the old hold could have.
      const now = yield* Clock.currentTimeMillis;
      const extended = Math.min(
        verdict.untilMs,
        now + 4 * pollMs,
        carried?.carriedCeilingMs ?? Number.POSITIVE_INFINITY,
      );
      const moved = yield* Ref.modify(state, (value) => {
        if (
          Option.isNone(value) ||
          value.value.holdId !== held.value.holdId ||
          value.value.startedAtMs !== held.value.startedAtMs ||
          extended <= value.value.expiresAtMs
        )
          return [Option.none<ServiceUpdateHoldState>(), value] as const;
        const next = { ...value.value, expiresAtMs: extended };
        return [Option.some(next), Option.some(next)] as const;
      });
      if (Option.isSome(moved)) yield* writeMarker(moved.value);
    });

    // While held, a gate the helper writes is acknowledged within gateAckPollMs, once every
    // command admitted before it has ended (update_service.await_gate_ack): the helper's checks
    // then start at once instead of after a fixed settle. Each gate is acknowledged once.
    const gateAckPath = path.join(
      path.dirname(installGatePath),
      UpdateInstallGate.INSTALL_GATE_ACK_FILE,
    );
    let acknowledged: string | null = null;
    const acknowledgeGate = Effect.gen(function* () {
      if (Option.isNone(yield* Ref.get(state))) return;
      const text = yield* fileSystem.readFileString(installGatePath).pipe(Effect.option);
      if (Option.isNone(text) || text.value === acknowledged) return;
      yield* awaitAdmissions;
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const content = UpdateInstallGate.installGateAck(text.value, process.pid, at);
      acknowledged = text.value;
      if (content === null) return;
      const temporary = `${gateAckPath}.${process.pid}.tmp`;
      yield* fileSystem.writeFileString(temporary, `${content}\n`, { mode: 0o600 });
      yield* fileSystem.rename(temporary, gateAckPath);
      yield* Effect.logInfo("service-update.gate.acknowledged");
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("service-update.gate.ack-failed", { cause })),
    );
    yield* Effect.sleep(Duration.millis(options.gateAckPollMs ?? GATE_ACK_POLL_MS)).pipe(
      Effect.andThen(acknowledgeGate),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* Effect.sleep(Duration.millis(pollMs)).pipe(
      Effect.andThen(refreshGate),
      Effect.andThen(check),
      Effect.catchCause((cause) =>
        Effect.logWarning("service-update.hold.check-failed", { cause }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return ServiceUpdateHold.of({
      acquire,
      acquireIfUnheld,
      confirmLease,
      releaseLease,
      withAdmission,
      awaitAdmissions,
      release,
      releaseCount: Ref.get(releases),
      recordRefusal,
      current,
      installGated,
      isHeld: Effect.flatMap(current, (held) =>
        Option.isSome(held) ? Effect.succeed(true) : installGated,
      ),
      awaitReleased,
      updatePending: Effect.map(readAgentState, (reading) =>
        Option.isSome(reading) ? updatePendingFor(reading.value) : false,
      ),
      installRequestOpen: Effect.gen(function* () {
        const reading = yield* readAgentState;
        return (
          Option.isSome(reading) &&
          installRequestOpen(reading.value, yield* Clock.currentTimeMillis)
        );
      }),
      automaticInstallUnderway: Effect.map(readAgentState, (reading) =>
        Option.isSome(reading) ? automaticInstallUnderway(reading.value) : false,
      ),
    });
  });

export const layer = Layer.effect(
  ServiceUpdateHold,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeWithOptions({
      agentStatePath: path.join(config.baseDir, "updates", "state.json"),
    });
  }),
);

/** The hold as seen by a service that may be built without one (tests, tools). */
export interface ServiceUpdateHoldView {
  readonly admit: ServiceUpdateHoldShape["withAdmission"];
  readonly isHeld: Effect.Effect<boolean>;
  readonly awaitReleased: Effect.Effect<void>;
  /** Fails with `ServiceUpdateInProgressError` while held. */
  readonly refuse: (action: string) => Effect.Effect<void, ServiceUpdateInProgressError>;
}

const viewOf = (hold: Option.Option<ServiceUpdateHoldShape>): ServiceUpdateHoldView => {
  if (Option.isNone(hold)) {
    return {
      isHeld: Effect.succeed(false),
      awaitReleased: Effect.void,
      refuse: () => Effect.void,
      admit: (_action, effect) => effect,
    };
  }
  const { isHeld, awaitReleased, current, installGated, recordRefusal } = hold.value;
  return {
    isHeld,
    awaitReleased,
    admit: hold.value.withAdmission,
    refuse: (action) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* current)) {
          yield* recordRefusal(action);
          return yield* new ServiceUpdateInProgressError({ action });
        }
        if (yield* installGated) {
          return yield* new ServiceUpdateInProgressError({ action, verifying: true });
        }
      }),
  };
};

/** Reads the hold when this service graph has one; otherwise nothing is ever held. */
export const optional: Effect.Effect<ServiceUpdateHoldView> = Effect.map(
  Effect.serviceOption(ServiceUpdateHold),
  viewOf,
);

/** Runs `effect` only while the service is not held, for a background tick. */
export const skipWhileHeld =
  (view: ServiceUpdateHoldView) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R> =>
    Effect.flatMap(view.isHeld, (held) => (held ? Effect.succeedNone : Effect.asSome(effect)));

/** Whether `command` starts work the hold refuses. */
export const isHeldCommand = (command: Pick<OrchestrationV2ServerCommand, "type">): boolean =>
  HELD_COMMAND_TYPES.has(command.type);
