/**
 * What the message box says and offers on a machine without the coordinator. The typed text
 * always stays in the box: nothing is held to be sent later, so every state either sends now
 * or says why it cannot. One rule for the page, the fixtures and tests; no UI imports.
 *
 * @module coordinatorBoxState
 */
import type { MainOffer, MainText } from "./makeMain";
import { sendButtonText } from "./routeToMain";

export type CoordinatorBoxKind =
  /** The coordinator's machine answers and this window may operate it. */
  | "routes"
  /** This window has not opened the project on the coordinator's machine. */
  | "unloaded"
  /** Silent for 10 minutes or more, but the machine shown cannot take the coordinator. */
  | "not-ready"
  /** Silent for 10 minutes or more: this machine can continue the coordinator. */
  | "silent"
  /** Silent for less than that: nothing can be sent or continued yet. */
  | "waiting"
  /** This window can only read the coordinator's machine. */
  | "read-only"
  /** The draft has files, which stay on this machine. */
  | "files"
  /** The coordinator's machine refused the message that was just sent. */
  | "refused"
  /** The coordinator moved to another machine while the message was typed. */
  | "moved"
  /** Nothing can be sent, and no rule above names why. */
  | "unreachable";

export interface CoordinatorBoxInput {
  readonly project: string;
  /** The coordinator's machine by name; null when this window does not know it. */
  readonly machine: string | null;
  /** `canRouteToMain` holds: Send delivers to the coordinator and opens it there. */
  readonly routes: boolean;
  readonly machineConnected: boolean;
  /** This window may run work on the coordinator's machine. */
  readonly mayOperate: boolean;
  readonly hasFiles: boolean;
  /** The machine the coordinator moved to since this draft was started; null when it did not. */
  readonly movedTo: string | null;
  /** Why the coordinator's machine refused the message just sent; null when it did not. */
  readonly refused?: string | null;
  /** "Continue here" for the machine shown (`useMakeMain`); null when it has none. */
  readonly offer: MainOffer | null;
}

export interface CoordinatorBoxState {
  readonly kind: CoordinatorBoxKind;
  /** The line above the box. */
  readonly line: MainText;
  readonly send: {
    /** "Send", or the button that continues the coordinator here. Never a machine name. */
    readonly text: string;
    readonly enabled: boolean;
    /** Pressing it continues the coordinator here first (`kind` is "silent"). */
    readonly continues: boolean;
  };
  /** "Continue here" beside the line; null when the machine shown has no such switch. */
  readonly continueHere: {
    readonly enabled: boolean;
    /** What it does, or why and until when it is off. */
    readonly note: MainText | null;
  } | null;
  readonly placeholder: MainText;
}

const SEND = sendButtonText({ continues: false, hasFiles: false });

/** The first state that matches, in the order of the spec's table (AC-07 to AC-09). */
export function coordinatorBoxState(input: CoordinatorBoxInput): CoordinatorBoxState {
  const { project, machine, offer } = input;
  const named = { project, machine: machine ?? "" };
  const placeholder: MainText = !machine
    ? { text: "The coordinator for {project} is on another machine.", values: { project } }
    : input.machineConnected
      ? { text: "Ask the coordinator for {project} (on {machine}).", values: named }
      : {
          text: "The coordinator for {project} is on {machine}, which is not answering.",
          values: named,
        };
  const pressable = offer !== null && offer.kind !== "blocked";
  // What "Continue here" does when it can be pressed, or why it cannot.
  const continueNote: MainText | null = !offer
    ? null
    : (offer.reason ??
      (offer.kind === "move"
        ? {
            text: "Continue here syncs {machine}, then moves the coordinator conversation here from {main}.",
            values: { machine: offer.machine, main: offer.main },
          }
        : null));
  const state = (
    kind: CoordinatorBoxKind,
    line: MainText,
    send: Partial<CoordinatorBoxState["send"]>,
    continueHere: CoordinatorBoxState["continueHere"] = offer
      ? { enabled: pressable, note: continueNote }
      : null,
  ): CoordinatorBoxState => ({
    kind,
    line,
    send: { text: SEND, enabled: false, continues: false, ...send },
    continueHere,
    placeholder,
  });

  // The rules that keep "Continue here" off come first, as `makeMainPath` orders them.
  // A machine shown that is not connected never gets here: the page keeps its own
  // disconnected line and blocked box, decided before the coordinator line.
  // An offer blocked because the machine shown is offline is refused the same way, so no
  // later caller can reach an enabled Send with it.
  if (offer?.block === "unloaded" || offer?.block === "copy-offline")
    return state("unloaded", offer.reason ?? placeholder, {}, { enabled: false, note: offer.note });
  if (offer?.kind === "takeover")
    return state(
      "silent",
      offer.silentMinutes === undefined
        ? {
            text: "{main} has been offline for 10 minutes or more. Continue here: the coordinator starts on {machine} from the shared goal, memory and plan. Its conversation on {main} stays readable there, and {main} gives way when it is back.",
            values: { machine: offer.machine, main: offer.main },
          }
        : {
            text: "{main} has been offline for {n} minutes. Continue here: the coordinator starts on {machine} from the shared goal, memory and plan. Its conversation on {main} stays readable there, and {main} gives way when it is back.",
            values: { machine: offer.machine, main: offer.main, n: String(offer.silentMinutes) },
          },
      {
        text: sendButtonText({ continues: true, hasFiles: input.hasFiles }),
        enabled: true,
        continues: true,
      },
      // The box's own button is the primary one: no second button beside the line.
      null,
    );
  if (offer?.block === "copy-not-ready")
    return state(
      "not-ready",
      offer.reason ?? placeholder,
      {},
      { enabled: false, note: offer.note },
    );
  if (offer?.block === "waiting") {
    const minutes = offer.note?.values?.minutes ?? "10";
    return state(
      "waiting",
      {
        text: "{machine} is not answering. Continue here unlocks in {m} min.",
        values: { machine: offer.main, m: minutes },
      },
      {},
      { enabled: false, note: offer.note },
    );
  }
  if (machine && input.machineConnected && !input.mayOperate) {
    const line: MainText = {
      text: "This window can only read {machine}, so it cannot send there. Open SpecWithCode on {machine}, or connect to it with full access.",
      values: { machine },
    };
    // Greyed for the same reason, in the offer's own short words.
    return state("read-only", line, {}, offer ? { enabled: false, note: offer.note } : null);
  }
  if (machine && input.machineConnected && input.hasFiles)
    return state(
      "files",
      {
        text: "Files stay on this machine. Remove them to send the text, or open {project} on {machine} to attach them there.",
        values: named,
      },
      {},
    );
  if (input.routes && machine && input.movedTo)
    return state(
      "moved",
      {
        text: "The coordinator moved to {new}. Nothing was sent.",
        values: { new: input.movedTo },
      },
      { enabled: true },
    );
  if (input.routes && machine && input.refused)
    return state(
      "refused",
      {
        text: "{machine} did not take the message: {reason}. Nothing was sent.",
        values: { machine, reason: input.refused.replace(/[.\s]+$/u, "") },
      },
      { enabled: true },
    );
  if (input.routes && machine)
    return state(
      "routes",
      {
        text: "The coordinator for {project} is on {machine}. Send opens it there.",
        values: named,
      },
      { enabled: true },
    );
  return state(
    "unreachable",
    machine && (offer?.reason || !input.machineConnected)
      ? (offer?.reason ?? placeholder)
      : {
          text: "The coordinator for {project} is on another machine that this window cannot reach.",
          values: { project },
        },
    {},
  );
}
