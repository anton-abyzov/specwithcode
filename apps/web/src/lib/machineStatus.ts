import {
  connectionStatusText,
  connectionStatusTitle,
  isMachineReachDown,
  machineReach,
  type EnvironmentConnectionPresentation,
  type MachineReachState,
} from "@specweave-studio/client-runtime/connection";
import { NETWORK_BLOCKING_HINT } from "@specweave-studio/client-runtime/errors";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";

import { compactAge } from "~/components/sidebar/SidebarProjectTree.logic";
import { englishPhrase, type TranslatePhrase } from "~/i18n";

/**
 * The words for one reach state (`machineReach`), so every surface says the
 * same thing about the same machine. Phrases are English with a `{machine}`
 * slot; a surface fills and translates them with its own `tx`.
 */
export interface MachineReachWords {
  /** Names the machine, for a banner: "Reconnecting to {machine}…". */
  readonly headline: string;
  /** For a row that already names the machine: "Reconnecting…". */
  readonly short: string;
  /** What the app does about it by itself, or null when it does nothing. */
  readonly next: string | null;
  /** Shown only when the relay itself could not be reached. */
  readonly hint: string | null;
  /** What the person must do, when waiting will not fix it. */
  readonly action?: string | null;
}

const RETRIES_BY_ITSELF = "Retrying by itself";
const QUIET = { next: null, hint: null } as const;

const REACH_WORDS: Record<MachineReachState, MachineReachWords> = {
  connected: { headline: "{machine} is connected", short: "Connected", ...QUIET },
  "catching-up": { headline: "Catching up with {machine}…", short: "Catching up…", ...QUIET },
  connecting: { headline: "Connecting to {machine}…", short: "Connecting…", ...QUIET },
  reconnecting: { headline: "Reconnecting to {machine}…", short: "Reconnecting…", ...QUIET },
  "not-answering": {
    headline: "{machine} isn't answering",
    short: "Not answering",
    next: RETRIES_BY_ITSELF,
    hint: null,
  },
  offline: {
    headline: "{machine} is offline",
    short: "Offline",
    next: RETRIES_BY_ITSELF,
    hint: null,
  },
  "cant-reach": {
    headline: "Can't reach {machine}",
    short: "Can't reach",
    next: RETRIES_BY_ITSELF,
    hint: NETWORK_BLOCKING_HINT,
  },
  "no-network": {
    headline: "This device has no network",
    short: "No network",
    next: "Reconnects when the network is back",
    hint: null,
  },
  stopped: { headline: "Connection to {machine} failed", short: "Connection failed", ...QUIET },
  "not-connected": { headline: "{machine} is not connected", short: "Not connected", ...QUIET },
};

const NEEDS_UPDATE: MachineReachWords = {
  headline: "{machine} needs an app update",
  short: "Needs an app update",
  ...QUIET,
};

/**
 * A saved machine whose address now answers as another SpecWithCode (the fleet
 * says `identity-mismatch`). Retrying never fixes it, so it names the step the
 * owner takes instead of "Retrying by itself".
 */
const IDENTITY_MISMATCH: MachineReachWords = {
  headline: "{machine}'s address now answers as a different SpecWithCode",
  short: "Different machine at address",
  next: null,
  hint: null,
  action: "Open Settings > Machines to fix it.",
};

/**
 * Whether a machine reads as answering as a different SpecWithCode: it is down
 * and the fleet marks it `identity-mismatch`. While it is connected or only
 * reconnecting it keeps its own words, and so does a device with no network,
 * whose own cause comes first.
 */
export function identityMismatchShown(
  state: MachineReachState | undefined,
  identityMismatch: boolean | undefined,
): boolean {
  return (
    identityMismatch === true &&
    state !== undefined &&
    state !== "no-network" &&
    isMachineReachDown(state)
  );
}

/**
 * The words for a reach state. A stopped connection this build cannot use asks
 * for an update; a down machine the fleet marks `identity-mismatch` says its
 * address answers as a different SpecWithCode.
 */
export function machineReachWords(
  state: MachineReachState,
  phase?: EnvironmentConnectionPresentation["phase"],
  identityMismatch = false,
  note: HostDownNote | null = null,
): MachineReachWords {
  if (identityMismatchShown(state, identityMismatch)) return IDENTITY_MISMATCH;
  const words =
    state === "stopped" && phase === "unsupported" ? NEEDS_UPDATE : REACH_WORDS[state];
  return hostDownNoteShown(state, note) ? { ...words, ...HOST_DOWN_NOTE_WORDS[note] } : words;
}

/**
 * Why a down machine is out of reach, when the app knows more than the reach
 * state says: this window has no SpecWithCode Connect sign-in and its only way
 * there needs one (`needs-sign-in`), or this machine's server still reaches it
 * though this window cannot (`reachable-from-machine`).
 */
export type HostDownNote = "needs-sign-in" | "reachable-from-machine";

/** The words a note puts in place of the reach state's own; the rest stays. */
const HOST_DOWN_NOTE_WORDS: Record<HostDownNote, Partial<MachineReachWords>> = {
  "needs-sign-in": {
    headline: "Sign in to reach {machine}",
    short: "Needs sign-in",
    next: null,
    hint: null,
    action:
      "This window reaches it through SpecWithCode Connect and is signed out. Sign in to open it here.",
  },
  "reachable-from-machine": {
    headline: "Can't reach {machine} from this window",
    short: "Not reachable from here",
  },
};

/**
 * Whether a note names why a machine is down. Only a machine that is down says
 * it, a device with no network keeps its own words, and a machine nobody asked
 * to connect stays "Not connected" whatever the fleet says.
 */
export function hostDownNoteShown(
  state: MachineReachState | undefined,
  note: HostDownNote | null | undefined,
): note is HostDownNote {
  if (note === null || note === undefined || state === undefined) return false;
  if (state === "no-network" || !isMachineReachDown(state)) return false;
  return note === "needs-sign-in" || state !== "not-connected";
}

/**
 * The note for one saved machine: its connection stopped for want of a
 * Connect sign-in, or the fleet of this machine's server says it answers.
 */
export function hostDownNote(input: {
  readonly connectSignInRequired?: boolean | undefined;
  readonly reachableFromMachine: boolean;
}): HostDownNote | null {
  if (input.connectSignInRequired === true) return "needs-sign-in";
  return input.reachableFromMachine ? "reachable-from-machine" : null;
}

const NONE_REACHABLE: ReadonlySet<string> = new Set();

/**
 * The saved machines this machine's server reached on its last fleet check, by
 * environment id. Empty without a fleet.
 */
export function fleetReachableEnvironmentIds(
  snapshot: Pick<StudioFleetSnapshot, "machines"> | null | undefined,
): ReadonlySet<string> {
  const ids = (snapshot?.machines ?? [])
    .filter((machine) => machine.status === "reachable")
    .map((machine) => machine.environmentId);
  return ids.length === 0 ? NONE_REACHABLE : new Set(ids);
}

const NO_MISMATCH: ReadonlySet<string> = new Set();

/**
 * The saved machines the fleet says now answer as a different SpecWithCode at
 * their address, by the environment id saved for them. Empty without a fleet.
 */
export function identityMismatchedEnvironmentIds(
  snapshot: Pick<StudioFleetSnapshot, "machines"> | null | undefined,
): ReadonlySet<string> {
  const ids = (snapshot?.machines ?? [])
    .filter((machine) => machine.status === "identity-mismatch")
    .map((machine) => machine.environmentId);
  return ids.length === 0 ? NO_MISMATCH : new Set(ids);
}

/**
 * A machine's status line once its connection stopped because this window has
 * no SpecWithCode Connect sign-in. Retrying cannot fix it; signing in does.
 */
export const NEEDS_SIGN_IN_STATUS: MachineStatus = {
  text: "Needs sign-in. Sign in to SpecWithCode Connect to reach it from this window",
  short: "Needs sign-in",
  reason: null,
  retryable: false,
};

/** Whether a connection stopped for want of a SpecWithCode Connect sign-in. */
export function needsConnectSignIn(
  connection: Pick<EnvironmentConnectionPresentation, "phase"> &
    Partial<Pick<EnvironmentConnectionPresentation, "connectSignInRequired">>,
): boolean {
  return connection.phase === "error" && connection.connectSignInRequired === true;
}

/** A machine's status line once its address answers as a different SpecWithCode. */
export const IDENTITY_MISMATCH_STATUS: MachineStatus = {
  text: "Different machine at address. Open Settings > Machines to fix it",
  short: "Different machine at address",
  reason: null,
  retryable: false,
};

/**
 * A machine's reach state judged by its phase alone, for a caller that has no
 * judgement from the app (no provider: tests, embedding). Without a time, a
 * machine that is retrying reads as reconnecting.
 */
export function reachFromPhase(
  phase: EnvironmentConnectionPresentation["phase"] | undefined,
): MachineReachState {
  switch (phase) {
    case "connected":
    case "connecting":
    case "reconnecting":
      return phase;
    case "offline":
      return "no-network";
    case "error":
    case "unsupported":
      return "stopped";
    case "available":
    case undefined:
      return "not-connected";
    default:
      return "offline";
  }
}

/**
 * What a thread's row says in place of its own state while its machine is
 * down. A machine whose address answers as a different SpecWithCode says so,
 * unless this device has no network.
 */
export function hostDownWord(
  state: MachineReachState | undefined,
  identityMismatch = false,
  note: HostDownNote | null = null,
): string {
  if (identityMismatchShown(state, identityMismatch)) return "Different machine at address";
  if (hostDownNoteShown(state, note)) return HOST_DOWN_NOTE_WORDS[note].short!;
  switch (state) {
    case "not-answering":
      return "Not answering";
    case "cant-reach":
      return "Can't reach host";
    case "no-network":
      return "No network";
    case "stopped":
    case "not-connected":
      return "Not connected";
    default:
      return "Host offline";
  }
}

/** "Last answered 2h ago", or null when the app never had an answer from it. */
export function lastAnsweredLabel(
  lastAnsweredAt: number | null,
  now: number,
  tx: TranslatePhrase = englishPhrase,
): string | null {
  if (lastAnsweredAt === null) return null;
  const age = compactAge(lastAnsweredAt, now);
  return age === "now" || age === ""
    ? tx("Last answered just now")
    : tx("Last answered {age} ago", { age });
}

/**
 * The line under a machine that is down: when it last answered, then what the
 * app does about it, or what the person must do when waiting will not help.
 * Null while it is connected or still inside its grace.
 */
export function machineReachDetail(
  words: MachineReachWords,
  lastAnsweredAt: number | null,
  now: number,
  tx: TranslatePhrase = englishPhrase,
): string | null {
  const next = words.next !== null ? tx(words.next) : words.action ? tx(words.action) : null;
  if (next === null) return null;
  return [lastAnsweredLabel(lastAnsweredAt, now, tx), next.replace(/[.。]$/u, "")]
    .filter(Boolean)
    .join(" · ");
}

export interface MachineStatus {
  /** Short state under the machine's name. */
  readonly text: string;
  /** One or two words for a chip beside the name: "Reconnecting", "Not answering". */
  readonly short: string;
  /** The last failure the app saw, so an unreachable machine says why. */
  readonly reason: string | null;
  /** The app has given up or is waiting between attempts, so a manual retry helps. */
  readonly retryable: boolean;
}

/**
 * What the app says about a machine wherever it shows one: the machine picker,
 * a chat's banner, the sidebar and Settings > Machines. A first attempt is
 * "Connecting…"; once an attempt has failed the machine is unreachable and the
 * picker says so, with the reason, instead of looking like it is about to connect.
 */
export function machineStatus(
  connection: ReachConnection,
  canOperate = true,
  isThisMachine = false,
  /** When the machine is judged; a new presentation arrives when its grace ends. */
  now = Date.now(),
): MachineStatus {
  const reason = connection.error ? readableConnectionReason(connection.error) : null;
  const quiet = { reason: null, retryable: false } as const;
  if (isThisMachine && isThisMachineCatchingUp(connection.phase))
    return { text: THIS_MACHINE_CATCHING_UP, short: "Catching up", ...quiet };
  if (connection.phase === "connected")
    return canOperate
      ? { text: "Connected", short: "Connected", ...quiet }
      : { text: "Permission to operate threads required", short: "No permission", ...quiet };
  if (!isThisMachine && needsConnectSignIn(connection)) return NEEDS_SIGN_IN_STATUS;
  const state = machineReach(connection, now).state;
  const words = machineReachWords(state, connection.phase);
  const short = words.short.replace(/…$/, "");
  switch (state) {
    case "connecting":
      return { text: words.short, short, ...quiet };
    case "reconnecting":
      return { text: words.short, short, reason: null, retryable: true };
    case "not-answering":
    case "offline":
    case "cant-reach":
      return { text: `${words.short}. ${RETRIES_BY_ITSELF}`, short, reason, retryable: true };
    case "no-network":
      return { text: words.headline, short, reason: null, retryable: true };
    case "stopped":
      return { text: words.short, short, reason, retryable: connection.phase === "error" };
    default:
      return { text: words.short, short, ...quiet };
  }
}

/** A connection with the facts its reach is judged from, when the caller has them. */
type ReachConnection = Pick<EnvironmentConnectionPresentation, "phase" | "error"> &
  Partial<
    Pick<
      EnvironmentConnectionPresentation,
      "lostAt" | "lastConnectedAt" | "cause" | "connectSignInRequired"
    >
  >;

/** What the app says about its own machine while its server is slow to answer. */
export const THIS_MACHINE_CATCHING_UP = "Catching up…";
/** The banner title for the app's own machine while its server is slow to answer. */
export const THIS_MACHINE_BUSY_TITLE = "SpecWithCode on this machine is busy";

/**
 * The app's own machine is never offline or unreachable: its server shares this
 * device, so any phase short of a stopped ("error") or refused ("unsupported")
 * connection means the server is busy and will catch up on its own.
 */
export function isThisMachineCatchingUp(
  phase: EnvironmentConnectionPresentation["phase"],
): boolean {
  return (
    phase === "connecting" ||
    phase === "reconnecting" ||
    phase === "offline" ||
    phase === "available"
  );
}

/** "last seen 2h ago" for a machine that is not connected now, or null when the app never saw it. */
export function lastSeenLabel(lastSeenAt: number | null, now: number): string | null {
  if (lastSeenAt === null) return null;
  const age = compactAge(lastSeenAt, now);
  return age === "now" ? "last seen just now" : `last seen ${age} ago`;
}

/**
 * The detail line under an unreachable machine: when it was last seen first,
 * then why it can't be reached. Raw connection errors can run long, and a
 * truncated line should still say when the machine was last there.
 */
export function machineDetail(lastSeen: string | null, reason: string | null): string {
  return [lastSeen, reason].filter(Boolean).join(" · ");
}

/** The banner a chat shows while its machine is not connected. */
export function machineUnavailableTitle(
  label: string,
  connection: Pick<EnvironmentConnectionPresentation, "phase" | "error"> &
    Partial<Pick<EnvironmentConnectionPresentation, "connectSignInRequired">>,
  isThisMachine = false,
): string {
  if (isThisMachine) {
    if (isThisMachineCatchingUp(connection.phase)) return THIS_MACHINE_BUSY_TITLE;
    if (connection.phase === "unsupported") return `${label} needs an app update`;
    return "Connection to SpecWithCode on this machine failed";
  }
  switch (connection.phase) {
    case "connecting":
      return `${label} is connecting`;
    case "reconnecting":
      return connection.error ? `Can't reach ${label}` : `${label} is reconnecting`;
    case "unsupported":
      return `${label} needs an app update`;
    case "available":
      return `${label} is not connected`;
    case "offline":
      return "This device is offline";
    case "error":
      return needsConnectSignIn(connection) ? `Sign in to reach ${label}` : `Can't reach ${label}`;
    case "connected":
      return `Can't reach ${label}`;
  }
}

/**
 * The short status on a saved machine's row in Settings > Machines. The
 * reason ("why it failed, what to do") is returned apart so the row can show it
 * on its own wrapped line instead of cutting it off. This machine reads
 * "Catching up" while its server is busy.
 */
export function savedMachineStatus(
  connection: ReachConnection,
  enabled: boolean,
  isThisMachine = false,
  now = Date.now(),
): {
  readonly text: string;
  readonly tone: "muted" | "error";
  readonly reason: string | null;
  readonly retryable: boolean;
} {
  const quiet = { reason: null, retryable: false } as const;
  if (!enabled && connection.phase !== "unsupported")
    return { text: "Off", tone: "muted", ...quiet };
  if (isThisMachine && isThisMachineCatchingUp(connection.phase))
    return { text: "Catching up", tone: "muted", ...quiet };
  const reason = connection.error ? readableConnectionReason(connection.error) : null;
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted", ...quiet };
    case "connecting":
    case "reconnecting":
    case "offline": {
      if (isThisMachine && connection.phase === "reconnecting")
        return { text: "Reconnecting", tone: "error", reason, retryable: true };
      // Inside its grace a machine is only reconnecting, a retry included; after
      // it, the row says why. No network is this device's state, not a failure.
      const state = machineReach(connection, now).state;
      const down = isMachineReachDown(state) && state !== "no-network";
      return {
        text: machineReachWords(state, connection.phase).short.replace(/…$/, ""),
        tone: down ? "error" : "muted",
        reason: down ? reason : null,
        retryable: connection.phase !== "offline" && state !== "connecting",
      };
    }
    // Not a failure: the machine is fine, this build just cannot talk to it.
    case "unsupported":
      return { text: "Client not supported", tone: "muted", reason, retryable: false };
    case "error":
      return needsConnectSignIn(connection) && !isThisMachine
        ? {
            text: "Needs sign-in",
            tone: "error",
            reason: "Sign in to SpecWithCode Connect to reach it from this window.",
            retryable: false,
          }
        : { text: "Connection failed", tone: "error", reason, retryable: true };
    case "available":
      return { text: "Not connected", tone: "muted", ...quiet };
  }
}

/**
 * The machine refused this device's approval, so it has to be paired again
 * from a new pairing code; retrying the same credential cannot fix that.
 */
export function reasonNeedsPairing(reason: string | null): boolean {
  return reason !== null && /approve this device again|new pairing code/i.test(reason);
}

/**
 * The client runtime's status sentence ("Failed to connect. Reconnecting...
 * Reason: ...") for pickers and settings panels that show it, except that this
 * machine reads "Catching up…" while its server is busy.
 */
export function environmentConnectionStatusText(
  connection: EnvironmentConnectionPresentation,
  isThisMachine: boolean,
  now = Date.now(),
): string {
  if (isThisMachine && isThisMachineCatchingUp(connection.phase)) return THIS_MACHINE_CATCHING_UP;
  return connectionStatusText(insideReconnectGrace(connection, now));
}

/** The short form of environmentConnectionStatusText, without the reason. */
export function environmentConnectionStatusTitle(
  connection: EnvironmentConnectionPresentation,
  isThisMachine: boolean,
  now = Date.now(),
): string {
  if (isThisMachine && isThisMachineCatchingUp(connection.phase)) return THIS_MACHINE_CATCHING_UP;
  return connectionStatusTitle(insideReconnectGrace(connection, now));
}

// Inside the grace a dropped connection is only reconnecting: its error is not news yet.
function insideReconnectGrace(
  connection: EnvironmentConnectionPresentation,
  now: number,
): EnvironmentConnectionPresentation {
  if (connection.phase !== "reconnecting" && connection.phase !== "connecting") return connection;
  if (connection.error === null || connection.error === undefined) return connection;
  const state = machineReach(connection, now).state;
  return state === "reconnecting" || state === "connecting"
    ? { ...connection, error: null }
    : connection;
}

/**
 * The toast for a send refused while the chat's machine is not connected. The
 * app's own machine is busy, not gone, so it is not "back" later: it catches up.
 */
export function environmentUnavailableSendToast(input: {
  readonly label: string | null;
  readonly isThisMachineCatchingUp: boolean;
  readonly continueOn: string | null;
}): { readonly title: string; readonly description: string } {
  if (input.isThisMachineCatchingUp) {
    return {
      title: `${THIS_MACHINE_BUSY_TITLE}: not sent yet`,
      description: "Your message stays in the composer. Send it once it catches up.",
    };
  }
  return {
    title: input.label
      ? `Waiting for ${input.label}: not sent yet`
      : "Not connected: message not sent",
    description: `Your message stays in the composer. Send it once ${input.label ?? "the machine"} is back${input.continueOn ? `, or continue on ${input.continueOn}` : ""}.`,
  };
}

// Only a request that got no answer at all; a certificate, CORS or encoding
// failure keeps its own wording, since "no answer" would point the wrong way.
const NO_ANSWER_REASON =
  /^Failed to fetch environment endpoint (https?:\/\/\S+) \((?:[^()]*: )?(?:Transport error|TypeError: (?:fetch failed|Failed to fetch|Load failed|NetworkError))/;
const TIMED_OUT_REASON = /^Environment endpoint (https?:\/\/\S+) timed out after (\d+)ms\.?$/;

/**
 * True when a request to a machine's server got no answer at all (refused,
 * dropped or timed out). That is the machine's connection state, which the
 * composer already shows, not a failure of the request itself.
 */
export function isUnansweredEnvironmentRequest(reason: string): boolean {
  return NO_ANSWER_REASON.test(reason) || TIMED_OUT_REASON.test(reason);
}

/**
 * Says which address did not answer instead of the raw HTTP client error
 * ("Failed to fetch environment endpoint https://…/.well-known/studio/environment
 * (HttpClientError: Transport error (GET …))"). `describe` names the address in
 * words (for example "a relay on M4 Max, port 8444"); without it, or when it
 * returns null, the host is shown. Other reasons pass through unchanged.
 */
export function readableConnectionReason(
  reason: string,
  describe?: (url: URL) => string | null,
): string {
  const failed = NO_ANSWER_REASON.exec(reason);
  const timedOut = TIMED_OUT_REASON.exec(reason);
  const raw = failed?.[1] ?? timedOut?.[1];
  if (raw === undefined) return reason;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reason;
  }
  const words = describe?.(url) ?? null;
  const where = words ? `${words} (${url.host})` : url.host;
  if (timedOut) {
    const seconds = Math.max(1, Math.round(Number(timedOut[2]) / 1000));
    return `No answer from ${where} within ${seconds}s.`;
  }
  return `No answer from ${where}.`;
}

const KNOWN_PHASES = new Set<string>([
  "available",
  "offline",
  "connecting",
  "reconnecting",
  "connected",
  "error",
  "unsupported",
]);

/**
 * A machine's reach state, or, when the app has not judged it (no provider:
 * tests, embedding), what its connection says now.
 */
export function hostReachOr(
  state: MachineReachState | undefined,
  connection: Pick<EnvironmentConnectionPresentation, "phase"> &
    Partial<Pick<EnvironmentConnectionPresentation, "lostAt" | "lastConnectedAt" | "cause">>,
  now = Date.now(),
): MachineReachState {
  if (state !== undefined) return state;
  return KNOWN_PHASES.has(connection.phase)
    ? machineReach(connection, now).state
    : reachFromPhase(connection.phase as EnvironmentConnectionPresentation["phase"]);
}
