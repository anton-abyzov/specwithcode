/**
 * What Overview says about one machine: whether it can be reached, in words,
 * and what that means for its chats. Kept apart from the row so the words are
 * tested without a page.
 */
import type { EnvironmentConnectionPhase } from "@specweave-studio/client-runtime/connection";

export type MachineTone = "moss" | "amber" | "red";

export interface MachineReach {
  /** "Online", "Catching up", "Connecting", "Can’t reach it · retrying", "Offline", "Can’t connect". */
  readonly state: string;
  readonly tone: MachineTone;
  /** The state as it reads after "m1 is": "offline", "not reachable". */
  readonly word: string;
  /**
   * True when the machine's chats and projects are in the lists. False for a
   * machine that never answered: its counts are unknown, not zero.
   */
  readonly counted: boolean;
}

/**
 * `reported` is whether the machine has sent its chats at least once this
 * session (they stay listed while it reconnects); `stale` whether the page
 * cannot vouch for them right now.
 */
export function machineReach(input: {
  readonly phase: EnvironmentConnectionPhase;
  readonly reported: boolean;
  readonly stale: boolean;
}): MachineReach {
  const { phase, reported } = input;
  switch (phase) {
    case "connected":
      return input.stale
        ? { state: "Catching up", tone: "amber", word: "catching up", counted: reported }
        : { state: "Online", tone: "moss", word: "online", counted: true };
    case "connecting":
      return { state: "Connecting", tone: "amber", word: "connecting", counted: reported };
    case "reconnecting":
      return {
        state: "Can’t reach it · retrying",
        tone: "amber",
        word: "not reachable",
        counted: reported,
      };
    case "error":
    case "unsupported":
      return { state: "Can’t connect", tone: "red", word: "unable to connect", counted: reported };
    case "available":
    case "offline":
    default:
      return { state: "Offline", tone: "amber", word: "offline", counted: reported };
  }
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
