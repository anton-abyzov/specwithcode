import {
  MACHINE_HANDOFF_MAX_BUSY_THREADS,
  MachineHandoffError,
  type MachineHandoffBusyReason,
  type MachineHandoffBusyThread,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

/** What one blocking row says, before it is cut to the wire limits. */
export interface BusyThreadInput {
  readonly threadId: string;
  readonly title: string | null;
  readonly projectId: string;
  readonly projectTitle?: string | null;
  readonly reason: MachineHandoffBusyReason;
}

const clip = (value: string, max = 512) => (value.length > max ? value.slice(0, max) : value);

/**
 * The busy refusal naming the threads that hold the project: each thread once, the first
 * MACHINE_HANDOFF_MAX_BUSY_THREADS of them, and the total of all.
 */
export function busyHandoffError(rows: ReadonlyArray<BusyThreadInput>): MachineHandoffError {
  const seen = new Map<string, MachineHandoffBusyThread>();
  for (const row of rows) {
    if (seen.has(row.threadId)) continue;
    const projectTitle = row.projectTitle ? clip(row.projectTitle) : undefined;
    seen.set(row.threadId, {
      threadId: ThreadId.make(row.threadId),
      title: clip(row.title?.trim() || "Untitled thread"),
      projectId: ProjectId.make(row.projectId),
      ...(projectTitle ? { projectTitle } : {}),
      reason: row.reason,
    });
  }
  const threads = [...seen.values()];
  if (threads.length === 0) return new MachineHandoffError({ code: "busy" });
  return new MachineHandoffError({
    code: "busy",
    busy: { total: threads.length, threads: threads.slice(0, MACHINE_HANDOFF_MAX_BUSY_THREADS) },
  });
}

/**
 * The one reason a thread shows, the one the person can act on first. A row with no flag
 * set still blocks (the query only returns busy threads) and reads as running work, as
 * does a pending dynamic tool call: the app answers that itself, nobody approves it.
 */
export function busyReasonOf(flags: {
  readonly waitingForAnswer: unknown;
  readonly waitingForSignIn: unknown;
  readonly pendingApproval: unknown;
  readonly running: unknown;
  readonly providerSession: unknown;
  readonly pendingEffect: unknown;
}): MachineHandoffBusyReason {
  if (Number(flags.waitingForAnswer)) return "waiting_for_answer";
  if (Number(flags.waitingForSignIn)) return "waiting_for_sign_in";
  if (Number(flags.pendingApproval)) return "pending_approval";
  if (Number(flags.running)) return "running";
  if (Number(flags.providerSession)) return "provider_session";
  if (Number(flags.pendingEffect)) return "pending_effect";
  return "running";
}
