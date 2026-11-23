/**
 * The two direction lines on a machine card, each one sentence naming both machines,
 * with at most one action: "m4 can start work on linux-mini · All projects · until Nov 20 · Stop"
 * and "linux-mini can start work on m4 · Full access · Change…". A stopped or ended
 * direction says what happened and offers the one action that undoes it. A direction this
 * app cannot set up says on which machine it is allowed instead of showing a button.
 * Each function takes the screen's `tx` last; without one it says it in English.
 */
import { englishPhrase, type TranslatePhrase } from "../../i18n";
import { accessLabel } from "../../studio/fleetWorkers";
import type { MachineWorkerGrant, MachineWorkHere } from "./machinesSettings.logic";
import {
  workGrantAllowsNoProject,
  workGrantNeedsRejoin,
  workGrantProjectsSummary,
} from "./machineWorkGrants.logic";

/**
 * stop: Stop now. allow: Allow… with the time limits. allow-setup: Allow… for a machine
 * that was never allowed, through its setup. set-up / change: open Connection details,
 * where this machine's access to that one is set.
 */
export type DirectionAction = "stop" | "allow" | "allow-setup" | "set-up" | "change";

export interface DirectionLine {
  readonly allowed: boolean;
  /** "m4 can start work on linux-mini", "linux-mini can't start work on m4". */
  readonly sentence: string;
  /** Short facts after the sentence: "All projects", "until Nov 20", "Not set up". */
  readonly facts: readonly string[];
  /** What happened, when it stopped or ended: "Time limit ended Nov 20." */
  readonly note: string | null;
  readonly action: DirectionAction | null;
}

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** That machine's agents starting work here, from this machine's own grant to it. */
export function incomingLine(
  input: {
    readonly there: string;
    /** This machine's name: every line names both machines. */
    readonly here: string;
    readonly workHere: MachineWorkHere | null;
    /** This machine takes a time limit on Allow (`snapshot.durations`). */
    readonly durations: boolean;
    /** This app can set the direction up from here when it has no grant yet. */
    readonly canSetUp: boolean;
  },
  tx: TranslatePhrase = englishPhrase,
): DirectionLine {
  const { there, here, workHere } = input;
  const cannot = tx("{from} can't start work on {to}", { from: there, to: here });
  if (!workHere)
    return {
      allowed: false,
      sentence: cannot,
      facts: [tx("Not set up")],
      note: null,
      action: input.canSetUp ? "allow-setup" : null,
    };
  const grant = workHere.grant;
  if (grant.status === "active") {
    const snapshot = {
      projects: workHere.projects,
      projectsUnreadable: workHere.projectsUnreadable,
    };
    const projects = workGrantAllowsNoProject(grant, snapshot)
      ? tx("No projects allowed")
      : grant.projects.kind === "linked"
        ? tx("Linked projects")
        : workGrantProjectsSummary(grant, workHere.projects, workHere.projectsUnreadable, tx);
    const lasts = grant.endsAt
      ? tx("until {date}", { date: dateOf(grant.endsAt) })
      : input.durations
        ? tx("until you stop it")
        : grant.renews !== true && grant.expiresAt
          ? tx("until {date}", { date: dateOf(grant.expiresAt) })
          : null;
    return {
      allowed: true,
      sentence: tx("{from} can start work on {to}", { from: there, to: here }),
      facts: lasts ? [projects, lasts] : [projects],
      note: null,
      action: "stop",
    };
  }
  const running =
    grant.interruptAt && grant.runningThreads > 0
      ? grant.runningThreads === 1
        ? tx("1 running thread stops at {time}.", { time: timeOf(grant.interruptAt) })
        : tx("{count} running threads stop at {time}.", {
            count: String(grant.runningThreads),
            time: timeOf(grant.interruptAt),
          })
      : null;
  const what =
    grant.status === "expired"
      ? grant.expiresAt
        ? tx("Its access ran out {date}.", { date: dateOf(grant.expiresAt) })
        : tx("Its access ran out.")
      : grant.ended === true && grant.endsAt
        ? tx("Time limit ended {date}.", { date: dateOf(grant.endsAt) })
        : grant.revokedAt
          ? tx("Stopped {date}.", { date: dateOf(grant.revokedAt) })
          : tx("Stopped.");
  const needsRejoin = workGrantNeedsRejoin(grant);
  const noteBase = running ? `${what} ${running}` : what;
  const note =
    needsRejoin && !input.canSetUp
      ? `${noteBase} ${tx("Allow it again under Let another of your machines run work here.")}`
      : noteBase;
  return {
    allowed: false,
    sentence: cannot,
    facts: [],
    note,
    action: needsRejoin ? (input.canSetUp ? "allow-setup" : null) : "allow",
  };
}

/** This machine's agents starting work there, from that machine's grant to this one. */
export function outgoingLine(
  input: {
    readonly there: string;
    /** This machine's name: every line names both machines. */
    readonly here: string;
    readonly workers: MachineWorkerGrant | null;
    /**
     * Connection details hold a step this app can take from here. Without one, only
     * that machine can allow it (its Allow… on this machine's card), and the line says so.
     */
    readonly canSetUp: boolean;
  },
  tx: TranslatePhrase = englishPhrase,
): DirectionLine {
  const { there, here, workers } = input;
  const cannot = tx("{from} can't start work on {to}", { from: here, to: there });
  if (!workers)
    return input.canSetUp
      ? {
          allowed: false,
          sentence: cannot,
          facts: [tx("Not set up")],
          note: null,
          action: "set-up",
        }
      : {
          allowed: false,
          sentence: cannot,
          facts: [tx("Allow it on {there} in Settings > Machines", { there })],
          note: null,
          action: null,
        };
  const grant = workers.workers;
  if (workers.status === "not-allowed")
    return {
      allowed: false,
      sentence: cannot,
      facts: [],
      note:
        grant.status === "revoked"
          ? tx("{there} stopped it.", { there })
          : grant.status === "expired"
            ? tx("Its access ran out.")
            : tx("{there} has not allowed it yet.", { there }),
      action: input.canSetUp ? "set-up" : null,
    };
  const access = grant.access === null ? tx("Allowed") : tx(accessLabel(grant.access));
  const until =
    !grant.renewable && grant.expiresAt
      ? tx("until {date}", { date: dateOf(grant.expiresAt) })
      : null;
  return {
    allowed: true,
    sentence: tx("{from} can start work on {to}", { from: here, to: there }),
    facts: until ? [access, until] : [access],
    note: null,
    action: "change",
  };
}

/** The button's words for each action. */
export const DIRECTION_ACTION_LABELS: Readonly<Record<DirectionAction, string>> = {
  stop: "Stop",
  allow: "Allow…",
  "allow-setup": "Allow…",
  "set-up": "Set up…",
  change: "Change…",
};
