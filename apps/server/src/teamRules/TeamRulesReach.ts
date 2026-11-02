import { TEAM_RULES_FINGERPRINT_HEADER, type TeamRulesRefusal } from "@specweave-studio/contracts";
import {
  teamRulesMachineRefusal,
  teamRulesMachines,
  teamRulesReachOff,
  teamRulesReachRefusal,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";

const PHONE_DEVICE_TYPES: ReadonlySet<string> = new Set(["mobile", "tablet"]);
const PHONE_LINK_SUBJECT = "phone-link:";
const CONNECT_SUBJECT = "cloud-connect";
/** The sessions a machine itself holds on another, rather than a person's client. */
const MACHINE_SUBJECTS: ReadonlySet<string> = new Set(["fleet-invitation", "mcp-client"]);

export interface RuledSession {
  readonly subject: string;
  readonly deviceType?: string | undefined;
  readonly coordinator: boolean;
  /** The machine on the other end, when known, so a refusal can name it. */
  readonly label?: string | undefined;
}

/** A phone by its client's own word, or by the phone link that made it. */
export const isPhoneSession = (session: Pick<RuledSession, "subject" | "deviceType">) =>
  session.subject.startsWith(PHONE_LINK_SUBJECT) ||
  (session.deviceType !== undefined && PHONE_DEVICE_TYPES.has(session.deviceType));

/** A session SpecWithCode Connect renews. A hold must not cut it off (see D-02). */
export const isConnectSubject = (subject: string | undefined) => subject === CONNECT_SUBJECT;

/** Whether any reach rule could ever end this session, so only those sockets need to watch. */
export const sessionFollowsReachRules = (session: RuledSession) =>
  session.coordinator || session.subject === CONNECT_SUBJECT || isPhoneSession(session);

/**
 * Refuses a session the machine's reach rules turn off. Nothing is revoked, so
 * removing the rule brings it back, and a phone keeps its other machines: a revoked
 * phone link would carry to every machine that phone is linked to.
 *
 * A hold refuses nothing here: what is already connected stays, to repair the file.
 */
export function teamRulesSessionRefusal(
  state: TeamRulesState,
  session: RuledSession,
  /** The rules the caller named on this request; absent from older machines. */
  fingerprint?: string | undefined,
): TeamRulesRefusal | null {
  const refused = teamRulesOpenSessionRefusal(state, session);
  if (refused !== null || !session.coordinator) return refused;
  // A person's client opened through a coordinator names no rules; its machine was checked.
  if (teamRulesMachines(state) === "same-rules" && MACHINE_SUBJECTS.has(session.subject)) {
    return teamRulesMachineRefusal(state, { label: session.label, fingerprint });
  }
  return null;
}

/**
 * The same answer for a session already open. A socket or a long wait names no rules after
 * it starts, so `same-rules` is left to each request; asking here would end every one.
 */
export function teamRulesOpenSessionRefusal(
  state: TeamRulesState,
  session: RuledSession,
): TeamRulesRefusal | null {
  if (state.status !== "active") return null;
  if (teamRulesReachOff(state, "phones") && isPhoneSession(session)) {
    return teamRulesReachRefusal(state, "phones");
  }
  if (teamRulesReachOff(state, "connect") && session.subject === CONNECT_SUBJECT) {
    return teamRulesReachRefusal(state, "connect");
  }
  if (session.coordinator && teamRulesMachines(state) === "none") {
    return teamRulesMachineRefusal(state, { fingerprint: undefined });
  }
  return null;
}

/** The rules a calling machine named. */
export const callerFingerprint = (headers: Readonly<Record<string, string | undefined>>) =>
  headers[TEAM_RULES_FINGERPRINT_HEADER];
