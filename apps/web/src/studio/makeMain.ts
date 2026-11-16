/**
 * "Make {machine} main": the one switch that moves a linked project's main to another
 * copy. `makeMainPath` picks how, `makeMain` runs it:
 *
 * - The old main is connected: the existing coordinator move (its conversation and Git
 *   state move, the old main becomes a copy), behind that move's own confirm.
 * - The old main has been unreachable for `TAKEOVER_UNREACHABLE_MS` or more: this copy
 *   takes over (`projectLink.takeover`), naming the old main so it gives way when it is
 *   back. Never `startCoordinator`, which names no predecessor and leaves two mains.
 * - Otherwise nothing runs, and the reason says when it unlocks.
 *
 * Kept free of UI imports so pages, dialogs and tests share one decision.
 *
 * @module makeMain
 */
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectAcceptStandbyInput,
  ProjectTakeoverInput,
  ProjectTakeoverResult,
} from "@specweave-studio/contracts";
import { copyRoles } from "./projectDomain";
import { highestEpoch, linkMemberOf, takeoverAvailability } from "./projectLink";

/**
 * Why the switch is off for now. waiting: the old main has not been unreachable long
 * enough. main-read-only: the online move needs write access on the old main, which this
 * window does not hold. copy-offline: the copy's own machine is not connected.
 * copy-not-ready: its machine cannot take over (an older app, or no permission there).
 */
/** Words for the switch: an English phrase and its `{slot}` values, translated where shown. */
export interface MainText {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

export type MakeMainBlock = "waiting" | "main-read-only" | "copy-offline" | "copy-not-ready";

export type MakeMainPath<P> =
  /** No switch for this copy: it is main, not linked, mid-move, or its main is not in sight. */
  | { readonly kind: "none" }
  | { readonly kind: "move"; readonly main: P }
  | { readonly kind: "takeover"; readonly main: P }
  | {
      readonly kind: "blocked";
      readonly main: P;
      readonly reason: MakeMainBlock;
      /** How long until an offline switch unlocks; 0 for every other reason. */
      readonly waitMs: number;
    };

export interface MakeMainMachines {
  readonly connected: (environmentId: EnvironmentId) => boolean;
  /** Since when this device has not reached the machine; null while it is connected. */
  readonly unreachableSince: (environmentId: EnvironmentId) => number | null;
  readonly now: number;
  /** This window may move a coordinator off that machine (run work, write files and Git). */
  readonly canMoveFrom: (environmentId: EnvironmentId) => boolean;
  /** That machine is connected, permitted and new enough to take over. */
  readonly takeoverReady: (environmentId: EnvironmentId) => boolean;
  /** Old records of machines that joined again, which never lead. */
  readonly retired?: { has(environmentId: string): boolean };
}

const keyOf = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

/** The copies of `copy`'s own project among `members`; a row may also hold unlinked ones. */
export function linkedWith<P extends EnvironmentProject>(copy: P, members: readonly P[]): P[] {
  const identity = copy.workspaceSettings?.logicalProject?.id;
  return identity === undefined
    ? []
    : members.filter((member) => member.workspaceSettings?.logicalProject?.id === identity);
}

/**
 * How `copy` would become its project's main right now. Only a copy that handed main on
 * (or joined as a copy) has a switch: main itself, an unlinked checkout, a copy mid-move
 * and one that runs a coordinator of its own beside main get none.
 */
export function makeMainPath<P extends EnvironmentProject>(
  copy: P,
  members: readonly P[],
  machines: MakeMainMachines,
): MakeMainPath<P> {
  const linked = linkedWith(copy, members);
  const role = copyRoles(linked, machines.retired).get(keyOf(copy));
  // Both ways in need a copy that gave its coordinator up: a takeover refuses any other,
  // and a move refuses a destination that still coordinates.
  if (role?.role !== "copy" || copy.workspaceSettings?.coordinatorBinding?.state !== "transferred")
    return { kind: "none" };
  const main = role.main;
  // Main on this same machine (another folder) is not a switch between machines.
  if (!main || main.environmentId === copy.environmentId) return { kind: "none" };
  const blocked = (reason: MakeMainBlock, waitMs = 0): MakeMainPath<P> => ({
    kind: "blocked",
    main,
    reason,
    waitMs,
  });
  // Either way ends on the copy's machine, so it has to be there.
  if (!machines.connected(copy.environmentId)) return blocked("copy-offline");
  if (machines.connected(main.environmentId))
    return machines.canMoveFrom(main.environmentId)
      ? { kind: "move", main }
      : blocked("main-read-only");
  const availability = takeoverAvailability({
    coordinatorConnected: false,
    unreachableSince: machines.unreachableSince(main.environmentId),
    now: machines.now,
  });
  if (!availability.available) return blocked("waiting", availability.waitMs);
  return machines.takeoverReady(copy.environmentId)
    ? { kind: "takeover", main }
    : blocked("copy-not-ready");
}

/** Whole minutes left of a wait, never 0 while it still waits. */
export const waitMinutes = (waitMs: number) => Math.max(1, Math.ceil(waitMs / 60_000));

/**
 * Why the switch is off, in a sentence and in the few words a menu row has room for.
 * `machine` is the copy's machine, `main` the old main's. English with `{slots}`; translated
 * where shown.
 */
export function makeMainBlockText(
  path: { readonly reason: MakeMainBlock; readonly waitMs: number },
  names: { readonly machine: string; readonly main: string },
): { readonly reason: MainText; readonly note: MainText } {
  switch (path.reason) {
    case "waiting": {
      const values = { ...names, minutes: String(waitMinutes(path.waitMs)) };
      return {
        reason: {
          text: "{main} must be unreachable for 10 minutes before {machine} can become main. That unlocks in {minutes} min.",
          values,
        },
        note: { text: "in {minutes} min", values },
      };
    }
    case "main-read-only":
      return {
        reason: {
          text: "This window can only read {main}, so it cannot move main from there. Open SpecWithCode on {main}, or connect to it with full access, to make {machine} main.",
          values: names,
        },
        note: { text: "read-only on {main}", values: names },
      };
    case "copy-offline":
      return {
        reason: { text: "Connect {machine} first to make it main.", values: names },
        note: { text: "{machine} offline", values: names },
      };
    case "copy-not-ready":
      return {
        reason: {
          text: "{machine} cannot take over yet. Update SpecWithCode there, or connect to it with permission to change settings and run work.",
          values: names,
        },
        note: { text: "not ready", values: names },
      };
  }
}

/** One "Make {machine} main" as a menu row or a button shows it. */
export interface MainOffer {
  /** The copy that would become main, `environmentId:projectId`. */
  readonly key: string;
  readonly machine: string;
  /** The machine main is on now. */
  readonly main: string;
  /** What a click does: the confirmed move, the confirmed takeover, or nothing yet. */
  readonly kind: "move" | "takeover" | "blocked";
  /** Why it is off, in a sentence; null while it can be pressed. */
  readonly reason: MainText | null;
  /** The same in a few words, beside the row. */
  readonly note: MainText | null;
}

/** The offer for `path`, or null where the copy has no switch. */
export function mainOffer<P>(
  key: string,
  path: MakeMainPath<P>,
  names: { readonly machine: string; readonly main: string },
): MainOffer | null {
  if (path.kind === "none") return null;
  if (path.kind !== "blocked") return { key, ...names, kind: path.kind, reason: null, note: null };
  return { key, ...names, kind: "blocked", ...makeMainBlockText(path, names) };
}

type Call<I, A> = (args: {
  readonly environmentId: EnvironmentId;
  readonly input: I;
}) => Promise<AtomCommandResult<A, unknown>>;

export interface MakeMainRun<P> extends MakeMainMachines {
  /** Every copy in sight; the copy's own project is picked out of it. */
  readonly members: readonly P[];
  /**
   * Opens the existing, confirmed coordinator move from `main` to `copy`. The move has its
   * own review and consent, so nothing has moved when this returns.
   */
  readonly move: (main: P, copy: P) => void;
  readonly takeover: Call<ProjectTakeoverInput, ProjectTakeoverResult>;
  /** Tells a standby armed for an older main to stand down; optional where there is none. */
  readonly acceptStandby?: Call<ProjectAcceptStandbyInput, unknown>;
  /** That machine re-arms standbys by epoch (`capabilities.coordinatorRearm`). */
  readonly rearms?: (environmentId: EnvironmentId) => boolean;
  readonly newOperationId: () => string;
}

export type MakeMainOutcome<P> =
  | { readonly status: "none" }
  | {
      readonly status: "blocked";
      readonly main: P;
      readonly reason: MakeMainBlock;
      readonly waitMs: number;
    }
  /** The confirmed move is open; main changes only when the person finishes it. */
  | { readonly status: "moving"; readonly main: P }
  /** The copy took over and is main now. `replicaFrom`: when its notes were last copied. */
  | { readonly status: "main"; readonly previous: P; readonly replicaFrom: string | null };

/**
 * Makes `copy` its project's main by the path `makeMainPath` picks. A failed takeover
 * throws its cause; a blocked switch runs nothing and says why.
 */
export async function makeMain<P extends EnvironmentProject>(
  copy: P,
  run: MakeMainRun<P>,
): Promise<MakeMainOutcome<P>> {
  const path = makeMainPath(copy, run.members, run);
  if (path.kind === "none") return { status: "none" };
  if (path.kind === "blocked")
    return { status: "blocked", main: path.main, reason: path.reason, waitMs: path.waitMs };
  if (path.kind === "move") {
    run.move(path.main, copy);
    return { status: "moving", main: path.main };
  }
  const linked = linkedWith(copy, run.members);
  const result = await run.takeover({
    environmentId: copy.environmentId,
    input: {
      operationId: run.newOperationId() as ProjectTakeoverInput["operationId"],
      projectId: copy.id,
      knownEpoch: highestEpoch(linked),
      // The main in sight now, not the one this copy recorded when it joined: main may have
      // moved since, and the copy named here is the one that gives way.
      predecessor: linkMemberOf(path.main),
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  // A standby registered for an older main must never fire for one that gave way. The
  // server claims the new epoch on reachable machines itself; this only disarms standbys.
  const epoch = result.value.coordinatorBinding.epoch;
  const logicalProjectId = result.value.logicalProject.id;
  for (const other of linked) {
    if (other.environmentId === copy.environmentId) continue;
    if (!run.acceptStandby || !run.connected(other.environmentId)) continue;
    if (run.rearms?.(other.environmentId) !== true) continue;
    void run
      .acceptStandby({
        environmentId: other.environmentId,
        input: { projectId: other.id, logicalProjectId, standby: null, belowEpoch: epoch },
      })
      .catch(() => undefined);
  }
  return { status: "main", previous: path.main, replicaFrom: result.value.replicaFrom };
}

/**
 * A move asked for on one copy's page that has to run on main's page, where the move dialog
 * has the conversation to move. The asking page stores it and shows main's page; that page
 * takes it once and opens its dialog. `returnTo` is the page to show again afterwards.
 */
export interface PendingMainMove {
  /** Main's checkout, `environmentId:projectId`: the page that runs the move. */
  readonly from: string;
  /** The copy that becomes main. */
  readonly to: string;
  readonly returnTo: string | null;
}

/** A request main's page never took (it did not open) is dropped after this long. */
const PENDING_MOVE_MS = 60_000;
let pendingMove: (PendingMainMove & { readonly at: number }) | null = null;
const listeners = new Set<() => void>();

export function requestMainMove(move: PendingMainMove, now = Date.now()): void {
  pendingMove = { ...move, at: now };
  for (const listener of listeners) listener();
}

/** The move waiting for the page of checkout `from`, without taking it. */
export function pendingMainMove(from: string, now = Date.now()): PendingMainMove | null {
  if (pendingMove && now - pendingMove.at > PENDING_MOVE_MS) pendingMove = null;
  return pendingMove?.from === from ? pendingMove : null;
}

/** Takes the move waiting for `from`, so it opens once. */
export function takeMainMove(from: string, now = Date.now()): PendingMainMove | null {
  const held = pendingMainMove(from, now);
  const move = held ? { from: held.from, to: held.to, returnTo: held.returnTo } : null;
  if (move) {
    pendingMove = null;
    for (const listener of listeners) listener();
  }
  return move;
}

export function subscribeMainMove(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
