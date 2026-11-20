/**
 * The coordinator hold a lid-close Away leaves on this machine (1267 AC-09).
 *
 * From the moment the sleep intent is recorded until the target says it did
 * not take a project over, or the intent is confirmed cancelled, this copy's
 * coordinator for that project starts no turn (`CoordinatorWakeGate`): the
 * target may have taken over meanwhile, and two coordinators must never run.
 * Resolving gives way for each project the target took over and releases the
 * rest. The lease (`CoordinatorLease`) also reads the recorded target, so a
 * takeover answer from it is accepted like one from the armed standby.
 *
 * Worker threads the intent named are held the same way (`threads`): the
 * target may have continued them, so their queued messages start here only
 * once it says it did not. One it did continue is fenced by handoff mode's
 * own record (`continuedOn`) before it leaves this hold, and keeps its queue.
 *
 * Kept as a file in the state directory, so a restart keeps the hold. It
 * imports nothing from the project layer, so the gate and the lease can read
 * it without a cycle.
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { parseJson, stringifyJson } from "../json.ts";

const FILE_NAME = "away-wake-hold.json";

export const AwayWakeHoldProject = Schema.Struct({
  projectId: Schema.String,
  /** The coordinator thread ids of this copy, as the gate is asked about them. */
  threadIds: Schema.Array(Schema.String),
});
export type AwayWakeHoldProject = typeof AwayWakeHoldProject.Type;

export const AwayWakeHoldRecord = Schema.Struct({
  version: Schema.Literal(1),
  targetEnvironmentId: Schema.String,
  /** When the intent was sent, on this machine's clock. */
  since: Schema.String,
  projects: Schema.Array(AwayWakeHoldProject),
  /** Worker threads the intent named; absent from holds written before it. */
  threads: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AwayWakeHoldRecord = typeof AwayWakeHoldRecord.Type;

export const COORDINATOR_AWAY_HOLD_REFUSAL =
  "This machine handed its work to another machine before it slept, and is checking whether that machine took over this project's coordinator. It runs again once that machine answers. Send again in a minute.";

export interface AwayWakeHoldStore {
  /**
   * The hold, or null without one. A read that fails returns the last hold
   * read, or without one the hold of an unreadable file (`isUnreadableHold`).
   */
  readonly read: Effect.Effect<AwayWakeHoldRecord | null>;
  readonly write: (next: AwayWakeHoldRecord | null) => Effect.Effect<void>;
}

export const memoryWakeHoldStore = (
  initial: AwayWakeHoldRecord | null = null,
): AwayWakeHoldStore & { readonly current: () => AwayWakeHoldRecord | null } => {
  let held = initial;
  return {
    read: Effect.sync(() => held),
    write: (next) => Effect.sync(() => void (held = next)),
    current: () => held,
  };
};

export const AWAY_THREAD_HOLD_REFUSAL =
  "This machine handed this thread to another machine before it slept, and is checking whether that machine continued it. Its queued messages wait here until that machine answers. Send again in a minute.";

/**
 * The hold of a hold file that is there but does not read, or whose presence
 * does not read, with no earlier hold read to keep. Which work it names is unknown,
 * so it keeps every thread from starting a turn until the file reads, or a
 * person runs the work here anyway, which removes the file. Never written,
 * and releasing any of it leaves it as it is.
 */
const UNREADABLE_HOLD: AwayWakeHoldRecord = {
  version: 1,
  targetEnvironmentId: "",
  since: "",
  projects: [],
};

/** Whether `hold` is that of a hold file that does not read: nothing it names is known. */
export const isUnreadableHold = (hold: AwayWakeHoldRecord | null): boolean =>
  hold === UNREADABLE_HOLD;

const AWAY_UNREADABLE_HOLD_REFUSAL =
  "This machine cannot read which work it held when it last slept, so it starts no turn until it can. Send again in a minute.";

/** Whether `threadId` is a coordinator or a worker the hold keeps from starting a turn. */
export function heldThread(hold: AwayWakeHoldRecord | null, threadId: string): boolean {
  return awayHoldRefusal(hold, threadId) !== null;
}

/** Why the hold keeps `threadId` from starting a turn, or null when it does not. */
export function awayHoldRefusal(hold: AwayWakeHoldRecord | null, threadId: string): string | null {
  if (hold === null) return null;
  if (hold === UNREADABLE_HOLD) return AWAY_UNREADABLE_HOLD_REFUSAL;
  if (hold.projects.some((project) => project.threadIds.includes(threadId)))
    return COORDINATOR_AWAY_HOLD_REFUSAL;
  return (hold.threads ?? []).includes(threadId) ? AWAY_THREAD_HOLD_REFUSAL : null;
}

const settledHold = (hold: AwayWakeHoldRecord): AwayWakeHoldRecord | null =>
  hold.projects.length === 0 && (hold.threads ?? []).length === 0 ? null : hold;

/** The hold without `projectIds`; null once nothing is held. */
export function releaseProjects(
  hold: AwayWakeHoldRecord | null,
  projectIds: ReadonlyArray<string>,
): AwayWakeHoldRecord | null {
  if (hold === null || hold === UNREADABLE_HOLD) return hold;
  const released = new Set(projectIds);
  return settledHold({
    ...hold,
    projects: hold.projects.filter((project) => !released.has(project.projectId)),
  });
}

/** The hold without the worker `threadIds`; null once nothing is held. */
export function releaseThreads(
  hold: AwayWakeHoldRecord | null,
  threadIds: ReadonlyArray<string>,
): AwayWakeHoldRecord | null {
  if (hold === null || hold === UNREADABLE_HOLD) return hold;
  const released = new Set(threadIds);
  const threads = (hold.threads ?? []).filter((threadId) => !released.has(threadId));
  const { threads: _threads, ...rest } = hold;
  return settledHold(threads.length === 0 ? rest : { ...rest, threads });
}

/** The coordinator thread ids of a copy. */
export function coordinatorThreadIdsOf(project: {
  readonly id: string;
  readonly workspaceSettings?: { readonly coordinatorThreadId?: string | null } | undefined;
}): ReadonlyArray<string> {
  const own = project.workspaceSettings?.coordinatorThreadId;
  return [
    ...new Set([`project-coordinator:${project.id}`, ...(own == null || own === "" ? [] : [own])]),
  ];
}

const decode = Schema.decodeUnknownOption(AwayWakeHoldRecord);
const encode = Schema.encodeSync(AwayWakeHoldRecord);

/** The live store: a file in the state directory, written atomically. */
export const makeFileWakeHoldStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, FILE_NAME);
  // A file that cannot be read keeps the last hold read, or holds everything without one:
  // failing open could run two coordinators, or a thread on two machines.
  let last: AwayWakeHoldRecord | null = null;
  const unread = () => last ?? UNREADABLE_HOLD;
  const store: AwayWakeHoldStore = {
    read: Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return (last = null);
      const text = yield* fs.readFileString(file);
      let raw: unknown = null;
      try {
        raw = parseJson(text);
      } catch {
        raw = null;
      }
      const decoded = decode(raw);
      if (Option.isNone(decoded)) {
        yield* Effect.logWarning(
          "Away: the wake hold file could not be read; keeping the last one",
        );
        return unread();
      }
      return (last = decoded.value);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away: could not read the wake hold", { cause }).pipe(Effect.map(unread)),
      ),
    ),
    write: (next) =>
      Effect.gen(function* () {
        if (next === UNREADABLE_HOLD) return;
        if (next === null) {
          if (yield* fs.exists(file)) yield* fs.remove(file);
          last = null;
          return;
        }
        yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
        yield* fs.writeFileString(temporary, stringifyJson(encode(next)), { mode: 0o600 });
        yield* fs.rename(temporary, file);
        last = next;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Away: could not save the wake hold", { cause }),
        ),
      ),
  };
  return store;
});
