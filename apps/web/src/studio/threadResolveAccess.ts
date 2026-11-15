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
  /** This browser's operate grant on the thread's own machine. */
  readonly canOperate: boolean;
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
}

/** Why a thread cannot be resolved or reopened from here, or null when it can. */
export function threadResolveBlockedReason(input: ThreadResolveAccessInput): string | null {
  const { canOperate, connection, supportsSettlement, environmentId, machineLabel } = input;
  // A label can fall back to the ID, which stays out of sight.
  const label = machineLabel && machineLabel !== environmentId ? machineLabel : null;
  const done = input.action === "reopen" ? "reopened" : "resolved";
  if (connection?.blockedReason === "authentication") {
    return `This browser is signed out of ${label ?? "that machine"}. Sign in to it again to ${input.action} this thread.`;
  }
  if (connection?.phase !== "connected") {
    return `${label ?? "That machine"} isn't connected right now, so this thread can't be ${done}.`;
  }
  if (!canOperate) return `This connection can't change threads ${label ? `on ${label}` : "there"}.`;
  if (supportsSettlement === undefined) {
    return `Still loading ${label ?? "that machine"}'s details. Try again in a moment.`;
  }
  if (!supportsSettlement) {
    return `${label ?? "That machine"} runs an older version that can't ${input.action} threads. Update it first.`;
  }
  return null;
}
