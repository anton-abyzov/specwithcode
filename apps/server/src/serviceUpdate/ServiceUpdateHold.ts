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
 * agent's retry window (FORCE_WINDOW, 15 min) plus one install (APPLY_TIMEOUT,
 * 25 min) and slack. An agent that dies while it reports `installing` ends here.
 */
export const HOLD_MAX_MS = 45 * 60_000;
/** How often a held service reads the update agent's state. */
export const AGENT_POLL_MS = 5_000;
/** `update_agent.py` SNAPSHOT_TIMEOUT: a snapshot begun just before its deadline runs this long. */
export const AGENT_SNAPSHOT_TIMEOUT_MS = 600_000;
/** `update_agent.py` RETRY_SECONDS: a forced pass gives up once its next retry would pass the deadline. */
export const AGENT_RETRY_MS = 10_000;
/** What a forced pass writes when it snapshots again after a refused apply, at any time. */
export const AGENT_APPLY_RETRY_MESSAGE = "New work started before the restart; trying again";
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
});

export interface ServiceUpdateHoldState {
  readonly holdId: string;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  /** Who asked for the hold (`acquire`'s reason): "install" or "app-restart". */
  readonly reason?: string;
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
  /** Ends the hold; false when none was held. */
  readonly release: (reason: string) => Effect.Effect<boolean>;
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
  // the service on until the time limit would only block its users.
  if (
    (status === "error" || status === "manual-required") &&
    updatedAtMs !== null &&
    updatedAtMs >= requestedAtMs
  )
    return { type: "settled", status };
  // Freshness is measured from the hold, not the latest request: a window that
  // asks again while a long snapshot runs must not end the extension.
  if (!busy || updatedAtMs === null || updatedAtMs < startedAtMs) return { type: "none" };
  const ceiling = startedAtMs + (input.maxMs ?? HOLD_MAX_MS);
  // The agent marks the request handled just before it installs it.
  if (status === "installing")
    return handled ? { type: "busy", untilMs: ceiling } : { type: "none" };
  if (handled) return { type: "none" };
  const deadline = reading.installHoldUntilMs ?? startedAtMs + HOLD_TTL_MS;
  // Written once no retry fits before the deadline: the pass gave up. Only TTL ends the hold.
  if (
    status === "waiting-for-quiet" &&
    updatedAtMs >= deadline - AGENT_RETRY_MS &&
    reading.message !== AGENT_APPLY_RETRY_MESSAGE
  )
    return { type: "none" };
  return { type: "busy", untilMs: Math.min(ceiling, deadline + AGENT_SNAPSHOT_TIMEOUT_MS) };
}

const decodeAgentState = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.optional(Schema.Unknown),
      message: Schema.optional(Schema.Unknown),
      updatedAt: Schema.optional(Schema.Unknown),
      handledInstallRequestAt: Schema.optional(Schema.Unknown),
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
  readonly pollMs?: number;
  /** Overrides `HOLD_MAX_MS`, for tests. */
  readonly maxMs?: number;
  /** Overrides `NO_REQUEST_RELEASE_MS`, for tests. */
  readonly noRequestMs?: number;
  /** The helper's install gate; `install-gate.json` beside the state by default. */
  readonly installGatePath?: string;
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
    const state = yield* Ref.make<
      Option.Option<
        ServiceUpdateHoldState & {
          readonly released: Deferred.Deferred<void>;
          readonly reason: string;
          /** With no install request by then (and an idle agent) the hold ends. */
          readonly requestDueAtMs: number;
        }
      >
    >(Option.none());
    let holds = 0;
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
      fileSystem
        .remove(holdMarkerPath, { force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("service-update.hold.marker-remove-failed", { cause }),
          ),
        ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(state), (held) => (Option.isSome(held) ? removeMarker : Effect.void)),
    );

    const release = (reason: string) =>
      Effect.gen(function* () {
        const previous = yield* Ref.getAndSet(state, Option.none());
        if (Option.isNone(previous)) return false;
        yield* removeMarker;
        yield* Deferred.succeed(previous.value.released, undefined);
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

    const current = Effect.gen(function* () {
      const held = yield* Ref.get(state);
      if (Option.isNone(held)) return Option.none<ServiceUpdateHoldState>();
      const { holdId, startedAtMs, expiresAtMs, reason } = held.value;
      if ((yield* Clock.currentTimeMillis) < expiresAtMs) {
        return Option.some({ holdId, startedAtMs, expiresAtMs, reason });
      }
      yield* release("expired");
      return Option.none<ServiceUpdateHoldState>();
    });

    const acquire: ServiceUpdateHoldShape["acquire"] = (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const ttlMs = input?.ttlMs ?? HOLD_TTL_MS;
        const expiresAtMs = now + ttlMs;
        const reason = input?.reason ?? "install";
        const requestDueAtMs = input?.draining === true ? expiresAtMs : now + noRequestMs;
        const existing = yield* current;
        const released = yield* Deferred.make<void>();
        const next = yield* Ref.modify(state, (held) => {
          // An app restart's drain must not cut short, or orphan the request
          // of, an install hold already under way: that hold stays as it is.
          if (Option.isSome(held) && held.value.reason === "install" && reason === "app-restart")
            return [held.value, held] as const;
          // A repeated "Update now" asks the agent again: older requests no longer count.
          const value = Option.isSome(held)
            ? { ...held.value, startedAtMs: now, expiresAtMs, reason, requestDueAtMs }
            : {
                holdId: `service-update-hold:${now}:${(holds += 1)}`,
                startedAtMs: now,
                expiresAtMs,
                released,
                reason,
                requestDueAtMs,
              };
          return [value, Option.some(value)] as const;
        });
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
      // A hold nobody asked the agent to install for (an app restart that did
      // not take the service down, a closed window) would refuse work until its
      // time runs out. Once the request had time to arrive, end it.
      if (
        !hasRequestSince(reading.value, held.value.startedAtMs) &&
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
        startedAtMs: held.value.startedAtMs,
        ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
      });
      if (verdict.type === "settled") {
        yield* release(`agent-${verdict.status}`);
        return;
      }
      if (verdict.type !== "busy") return;
      // The agent does not rewrite its state during a long snapshot or install,
      // so the hold stays a few polls ahead while it is on this request.
      const now = yield* Clock.currentTimeMillis;
      const extended = Math.min(verdict.untilMs, now + 4 * pollMs);
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
      release,
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
    };
  }
  const { isHeld, awaitReleased, current, installGated, recordRefusal } = hold.value;
  return {
    isHeld,
    awaitReleased,
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
