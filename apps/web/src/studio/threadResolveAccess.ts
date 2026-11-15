/**
 * Whether a thread can be resolved or reopened from here.
 *
 * A thread settles on the machine that runs it, so this reads that machine's
 * connection, grant and version, never the viewed project's. A thread that runs
 * on another machine resolves from any machine that reaches it and may operate it.
 *
 * @module threadResolveAccess
 */

export interface ThreadResolveAccessInput {
  /**
   * This browser's operate grant on the thread's own machine: "unknown" while the
   * grant has not loaded, which is not a refusal.
   */
  readonly access: "granted" | "denied" | "signed-out" | "unknown";
  /** The thread's own machine's connection, or null when this app does not know that machine. */
  readonly connection:
    | { readonly phase: string; readonly blockedReason?: string | undefined }
    | null
    | undefined;
  /**
   * Whether that machine's server resolves threads: true or false once its
   * details loaded, undefined while they have not.
   */
  readonly supportsSettlement: boolean | undefined;
  readonly environmentId: string;
  readonly machineLabel: string | undefined;
  /** What the button would do: an archived or resolved thread reopens. */
  readonly action: "resolve" | "reopen";
  /**
   * False for history a server only archived: restoring it needs no settlement
   * support, so a machine that predates Resolve can still reopen it.
   */
  readonly needsSettlement: boolean;
}

/** What the Resolve button of a thread would do. */
export function threadResolveAction(thread: {
  readonly archivedAt: string | null;
  readonly settledOverride: string | null;
}): Pick<ThreadResolveAccessInput, "action" | "needsSettlement"> {
  const settled = thread.settledOverride === "settled";
  const archived = thread.archivedAt !== null;
  return {
    action: archived || settled ? "reopen" : "resolve",
    needsSettlement: settled || !archived,
  };
}

/** Why a thread cannot be resolved or reopened from here, or null when it can. */
export function threadResolveBlockedReason(input: ThreadResolveAccessInput): string | null {
  const { access, connection, supportsSettlement, environmentId, machineLabel, action } = input;
  // A label can fall back to the ID, which stays out of sight.
  const label = machineLabel && machineLabel !== environmentId ? machineLabel : null;
  const done = action === "reopen" ? "reopened" : "resolved";
  const signedOut = `This browser is signed out of ${label ?? "that machine"}. Sign in to it again to ${action} this thread.`;
  if (connection === null || connection === undefined) {
    // Reconnecting never helps here: this app holds no connection to that machine at all.
    return `This device is not paired with ${label ?? "that machine"}, so this thread can't be ${done} from here.`;
  }
  if (connection.blockedReason === "authentication") return signedOut;
  if (connection.phase !== "connected") {
    return `${label ?? "That machine"} isn't connected right now, so this thread can't be ${done}.`;
  }
  if (access === "signed-out") return signedOut;
  if (access === "unknown") {
    return `Still checking this browser's access to ${label ?? "that machine"}. Try again in a moment.`;
  }
  if (access === "denied") {
    return `This connection can't change threads ${label ? `on ${label}` : "there"}.`;
  }
  if (!input.needsSettlement) return null;
  if (supportsSettlement === undefined) {
    return `Still loading ${label ?? "that machine"}'s details. Try again in a moment.`;
  }
  if (!supportsSettlement) {
    return `${label ?? "That machine"} runs an older version that can't ${action} threads. Update it first.`;
  }
  return null;
}
