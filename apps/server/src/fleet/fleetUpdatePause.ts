/**
 * The `pauseWorkForUpdates` rule on the fleet update path (increment 1304).
 *
 * A machine's own setting decides whether an update its primary asks for may
 * stop running work there. Off (the default): a forced request is refused
 * before anything is stopped, and a Linux boot service that stays busy is left
 * on its version. On: the Linux boot service stops its work after its quiet
 * wait, the way Update now does, and the interrupted turns continue after the
 * restart. A person's own Update now never comes through here, so it is never
 * gated.
 */
import type {
  ServerPrepareServiceUpdateError,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
} from "@specweave-studio/contracts";
import type { StudioFleetUpdateRefusal } from "@specweave-studio/contracts/studioFleet";
import {
  UPDATE_PAUSE_SETTING_NAME,
  updatePauseOffReason,
  updatesMayPauseWork,
} from "@specweave-studio/shared/updatePause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSettings from "../serverSettings.ts";
import { folderCopiesText } from "./folderTransfer/folderWork.ts";

/** The effective rule from this machine's settings, read on each call; unreadable settings read as off. */
export const pausesWorkFrom = (
  settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">,
): Effect.Effect<boolean> =>
  settings.getSettings.pipe(
    Effect.map(updatesMayPauseWork),
    Effect.orElseSucceed(() => false),
  );

/**
 * Why a forced request was refused. It goes out as `busy`, a reason every
 * primary decodes, and says what a normal request would do instead.
 */
export const forceRefusedMessage = (installed: string, version: string): string =>
  `A forced update was not made: "${UPDATE_PAUSE_SETTING_NAME}" is off on this machine, so it is left on ${installed} until it is quiet. That is its owner's setting, not a failure. A normal request (without force) installs ${version} once it is quiet.`;

/** What a normal install that stayed busy ends with when the setting is off. */
export const leftForLaterMessage = (version: string, minutes: number, waiting: string): string =>
  `${version} was not installed after ${minutes} minutes (${waiting}). ${updatePauseOffReason("This machine")}`;

/**
 * What a normal install that stayed busy ends with when the setting is on but
 * nothing here is work a pause could stop: another update's hold, or a look
 * that failed.
 */
export const nothingToPauseMessage = (version: string, minutes: number, waiting: string): string =>
  `${version} was not installed after ${minutes} minutes (${waiting}). No running work here is what kept it waiting, so nothing was paused. Ask again once that has ended.`;

/** The give-up of a quiet wait, as its last look saw the machine. */
export interface QuietGiveUp {
  readonly minutes: number;
  /** What it waited for, in words. */
  readonly waiting: string;
  readonly copies: number;
  /** Turns, queued messages, questions, terminals or copies: work a pause is about. */
  readonly work: boolean;
}

/**
 * A hold this path took for the switch-over: the drain's own hold (granted
 * only where an update agent offers the release), or the conditional if-idle
 * lease. Each is released its own way when no switch-over follows.
 */
export type HeldForInstall =
  | { readonly kind: "drain" }
  | { readonly kind: "lease"; readonly token: string };

type Prepare = (
  input: ServerPrepareServiceUpdateInput,
) => Effect.Effect<ServerPrepareServiceUpdateResult, ServerPrepareServiceUpdateError>;

export const releaseHeld = (prepare: Prepare, held: HeldForInstall | undefined) =>
  held === undefined
    ? Effect.void
    : prepare(
        held.kind === "lease"
          ? { stopWork: false, releaseHold: true, holdToken: held.token }
          : { stopWork: false, releaseHold: true },
      ).pipe(Effect.ignore);

/** Why the pause did not end ready to switch over; `refusal` is how the phase reports it. */
export interface PauseFailure {
  readonly reason: string;
  readonly refusal: StudioFleetUpdateRefusal;
}

/**
 * Stops the work the way Update now does (turns interrupted for the update,
 * open questions recorded, terminals closed), then closes admission for the
 * switch-over where it can. Each hold is handed to `keep` in the same
 * uninterruptible step it is granted in, so the caller always knows what to
 * release.
 *
 * A Linux boot service has no update agent, so its drain stops the work but
 * is not held (`updatePending` is false there) and admission stays open. The
 * if-idle lease closes it when nothing started again. When something did, in
 * the seconds since the drain, the switch-over still goes ahead: the restart
 * cancels that turn and it continues after the restart, as with Update now on
 * this machine. Turning back instead would leave the turns just interrupted
 * waiting for a restart that never comes.
 *
 * `spareCopies`: a folder copy is never cut off by an automatic pause. A copy
 * seen before the drain stops nothing; one that starts during it ends the
 * pause as busy, the holds released, and the stopped turns continue. A forced
 * request does not spare copies, and switches over even when the drain fails:
 * it is the way out when a turn will not stop, as before it drained at all.
 */
export const pauseWorkForInstall = (input: {
  readonly prepare: Prepare;
  readonly spareCopies: boolean;
  /** Folder copies the last look counted; a copy is never stopped for an automatic pause. */
  readonly copiesBefore: number;
  readonly keep: (held: HeldForInstall) => Effect.Effect<void>;
}): Effect.Effect<void, PauseFailure> =>
  Effect.gen(function* () {
    const copyRuns = (copies: number, stopped: boolean) =>
      Effect.fail<PauseFailure>({
        reason: `${stopped ? "The update stopped the turns here, but" : "The update did not stop the work here:"} ${folderCopiesText(copies)} ${copies === 1 ? "is" : "are"} in progress, and an automatic update never cuts one off. It installs once the copy ends${stopped ? ", and the stopped turns continue after that restart" : ""}.`,
        refusal: "busy",
      });
    if (input.spareCopies && input.copiesBefore > 0)
      return yield* copyRuns(input.copiesBefore, false);
    const drained = yield* Effect.uninterruptibleMask((restore) =>
      restore(input.prepare({ stopWork: true, hold: true, reason: "install" })).pipe(
        Effect.option,
        Effect.tap((answer) =>
          Option.isSome(answer) && answer.value.held === true
            ? input.keep({ kind: "drain" })
            : Effect.void,
        ),
      ),
    );
    if (Option.isNone(drained)) {
      if (!input.spareCopies) return;
      return yield* Effect.fail<PauseFailure>({
        reason: "The service could not stop its work for the update; nothing was installed.",
        refusal: "failed",
      });
    }
    let copies = drained.value.folderCopies ?? 0;
    if (drained.value.held !== true) {
      const lease = yield* Effect.uninterruptible(
        input.prepare({ stopWork: false, hold: true, ifIdle: true, reason: "install" }).pipe(
          Effect.option,
          Effect.tap((answer) =>
            Option.isSome(answer) &&
            answer.value.held === true &&
            answer.value.holdToken !== undefined
              ? input.keep({ kind: "lease", token: answer.value.holdToken })
              : Effect.void,
          ),
        ),
      );
      if (Option.isSome(lease)) copies = lease.value.folderCopies ?? copies;
    }
    if (input.spareCopies && copies > 0) return yield* copyRuns(copies, true);
  });
