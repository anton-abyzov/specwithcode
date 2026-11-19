/**
 * What Overview says about one machine: whether it can be reached, in words,
 * and what that means for its chats. Kept apart from the row so the words are
 * tested without a page.
 */
import type { MachineReachState } from "@specweave-studio/client-runtime/connection";

import { machineReachWords, type HostDownNote } from "../lib/machineStatus";

export type MachineTone = "moss" | "amber" | "red";

export interface OverviewMachineState {
  /** "Online", "Catching up", "Reconnecting", "Not answering", "Offline", "Connection failed". */
  readonly state: string;
  readonly tone: MachineTone;
  /** The state as it reads after "m1 is": "offline", "not answering". */
  readonly word: string;
  /**
   * True when the machine's chats and projects are in the lists. False for a
   * machine that never answered: its counts are unknown, not zero.
   */
  readonly counted: boolean;
}

/** The state as it reads after "m1 is", for each state a machine can be down or settling in. */
const AFTER_IS: Record<Exclude<MachineReachState, "connected">, string> = {
  "catching-up": "catching up",
  connecting: "connecting",
  reconnecting: "reconnecting",
  "not-answering": "not answering",
  offline: "offline",
  "cant-reach": "not reachable",
  "no-network": "not reachable",
  stopped: "unable to connect",
  "not-connected": "not connected",
};

/**
 * `reach` is what the machine reads as now (`machineReach`), in the same words
 * every other surface uses. `reported` is whether the machine has sent its
 * chats at least once this session (they stay listed while it reconnects);
 * `stale` whether the page cannot vouch for them right now.
 */
export function overviewMachineState(input: {
  readonly reach: MachineReachState;
  readonly reported: boolean;
  readonly stale: boolean;
  /** Why it is down beyond its reach state: signed out of Connect, or only this window cut off. */
  readonly note?: HostDownNote | null;
}): OverviewMachineState {
  const reach = input.reach === "connected" && input.stale ? "catching-up" : input.reach;
  if (reach === "connected")
    return { state: "Online", tone: "moss", word: "online", counted: true };
  return {
    state: machineReachWords(reach, undefined, false, input.note ?? null).short.replace(/…$/, ""),
    tone: reach === "stopped" ? "red" : "amber",
    word: AFTER_IS[reach],
    counted: input.reported,
  };
}

/** The line under a machine's state: what runs there and how many projects it holds. */
export function machineActivity(input: {
  readonly counted: boolean;
  readonly working: number;
  readonly projects: number;
}): { readonly text: string; readonly values?: Record<string, number> }[] {
  if (!input.counted) return [{ text: "Chats and projects not counted" }];
  return [
    input.working === 0
      ? { text: "Nothing running" }
      : { text: "{count} working", values: { count: input.working } },
    {
      text: input.projects === 1 ? "{count} project" : "{count} projects",
      values: { count: input.projects },
    },
  ];
}
