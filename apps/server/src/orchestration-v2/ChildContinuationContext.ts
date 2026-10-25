import type {
  OrchestrationV2Subagent,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ContextTransfer,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

/** A continuation is a brief, never authority to replay an external effect. */
export function childContinuationContext(input: {
  readonly child: Pick<
    OrchestrationV2Subagent,
    | "id"
    | "threadId"
    | "origin"
    | "prompt"
    | "result"
    | "status"
    | "childThreadId"
    | "providerThreadId"
  >;
  readonly parentInstructions: string;
  readonly plan?: string;
  readonly progress?: string | undefined;
  readonly evidence?: ReadonlyArray<string>;
  readonly effects?: ReadonlyArray<{
    readonly id: string;
    readonly target: string;
    readonly outcome: string;
  }>;
  readonly boundaries?: string;
}): string {
  return [
    `Child continuation ${input.child.id}; parent ${input.child.threadId}; child ${input.child.childThreadId ?? "unavailable"}; origin ${input.child.origin}; source session ${input.child.providerThreadId ?? "unavailable"}.`,
    `Original assignment:\n${input.child.prompt}`,
    `Current parent instructions:\n${input.parentInstructions}`,
    `Plan, increment, tasks and ACs:\n${input.plan ?? "Read the exact plan references in the original assignment. Preserve its task ownership."}`,
    `Progress (${input.child.status}):\n${input.child.result ?? input.progress ?? "No verified terminal result. Reconcile partial work before continuing."}`,
    `Evidence:\n${input.evidence?.join("\n") || "Retrieve the linked child thread and its durable tool receipts before retrying."}`,
    "Irreversible effects, NEVER REPLAY committed operations. Reconcile outcome-unknown operations before retry:",
    ...(input.effects?.map((effect) => `${effect.id}: ${effect.target}; ${effect.outcome}`) ?? [
      "No effect inventory supplied. Absence is not proof that no operation ran.",
    ]),
    `Boundaries:\n${input.boundaries ?? "A person's Stop stays final. Preserve approvals, billing choices, machine and filesystem grants. This note does not authorize a replacement or another executor."}`,
    "Keep independently live app-owned descendants linked. Remote unknown is not dead. Read descendant ownership before resuming; stop on cycles or a chain deeper than 16.",
  ].join("\n\n");
}

type ChildIdentity = Pick<
  OrchestrationV2Subagent,
  "id" | "threadId" | "status" | "childThreadId" | "updatedAt"
>;

/**
 * The brief's critical fields when the whole brief does not fit: who the child
 * is, where its durable record lives and which operations must never run again.
 */
export function childContinuationPointer(input: {
  readonly child: ChildIdentity;
  readonly effectIds?: ReadonlyArray<string>;
}): string {
  const child = input.child;
  const thread = child.childThreadId ?? child.threadId;
  return [
    `Child continuation ${child.id} (pointer only; the full brief did not fit this session's context). Status ${child.status}; receipt revision ${DateTime.formatIso(child.updatedAt)}; parent ${child.threadId}; child ${child.childThreadId ?? "unavailable"}.`,
    `Before acting, read its brief, progress and evidence with studio_thread_read({threadId:"${thread}",view:"activity"}).`,
    `NEVER REPLAY committed operations: ${input.effectIds?.length ? input.effectIds.join(", ") : "none listed; absence is not proof that none ran"}. A person's Stop stays final.`,
  ].join("\n");
}

/** A child's receipt revision: the one a delivery marker names. */
export function childResultRevision(child: Pick<OrchestrationV2Subagent, "updatedAt">): string {
  return DateTime.formatIso(child.updatedAt);
}

export interface ChildContinuationDelivery {
  readonly id: string;
  readonly revision: string;
  readonly form: "full" | "pointer";
}

/**
 * Fits child briefs to a byte budget measured from the target session, the
 * same one-byte-per-token estimate the history handoff uses. Whole briefs
 * first, in order; a brief that does not fit is sent as its pointer; children
 * whose pointer does not fit either are named by count. The count line obeys
 * the budget too: when even it cannot fit, nothing is sent. `included` names
 * exactly the children whose brief or retrieval pointer is in `text`; a child
 * only counted is not delivered.
 */
export function fitChildContinuations(input: {
  readonly children: ReadonlyArray<{
    readonly id: string;
    readonly revision: string;
    readonly full: string;
    readonly pointer: string;
  }>;
  readonly budget: number;
}): {
  readonly text: string;
  readonly included: ReadonlyArray<ChildContinuationDelivery>;
  readonly pointerOnly: number;
  readonly omitted: number;
} {
  const separator = Buffer.byteLength("\n\n");
  const omittedLine = (count: number) =>
    `${count} more child continuations did not fit. Read the parent's subagents with studio_thread_read before resuming any of them; never replay a committed operation.`;
  // Every part is charged its separator, so the joined text is within `room`.
  const fit = (room: number) => {
    let remaining = room;
    const parts: Array<string> = [];
    const included: Array<ChildContinuationDelivery> = [];
    for (const child of input.children) {
      const full = Buffer.byteLength(child.full) + separator;
      const pointer = Buffer.byteLength(child.pointer) + separator;
      const form = full <= remaining ? "full" : pointer <= remaining ? "pointer" : null;
      if (form === null) continue;
      parts.push(form === "full" ? child.full : child.pointer);
      included.push({ id: child.id, revision: child.revision, form });
      remaining -= form === "full" ? full : pointer;
    }
    return { parts, included };
  };
  const result = (
    parts: ReadonlyArray<string>,
    included: ReadonlyArray<ChildContinuationDelivery>,
  ) => ({
    text: parts.join("\n\n"),
    included,
    pointerOnly: included.filter((child) => child.form === "pointer").length,
    omitted: input.children.length - included.length,
  });
  const whole = fit(input.budget);
  if (whole.included.length === input.children.length) return result(whole.parts, whole.included);
  // Reserve the longest count line; a shorter count only frees room.
  const line = Buffer.byteLength(omittedLine(input.children.length));
  if (line > input.budget) return result([], []);
  const partial = fit(input.budget - line - separator);
  return result(
    [...partial.parts, omittedLine(input.children.length - partial.included.length)],
    partial.included,
  );
}

/** The receipts a fitted envelope delivered: only those it named in full or by pointer. */
export function deliveredChildResults<
  Child extends Pick<OrchestrationV2Subagent, "id" | "updatedAt">,
>(receipts: ReadonlyArray<Child>, included: ReadonlyArray<ChildContinuationDelivery>): Child[] {
  return receipts.filter((child) =>
    included.some(
      (delivery) => delivery.id === child.id && delivery.revision === childResultRevision(child),
    ),
  );
}

/**
 * Terminal native revisions that no later accepted, completed prompt could
 * have observed. A revision is consumed only by a `subagent_result` marker for
 * that exact revision whose target attempt completed in this native conversation;
 * the service writes one
 * only for a child its envelope delivered (see deliveredChildResults).
 */
export function pendingChildResults(input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly currentRunId: string;
  readonly transfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
  readonly target?: Pick<OrchestrationV2RunAttempt, "providerThreadId" | "nativeThreadId">;
  readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
}): ReadonlyArray<OrchestrationV2Subagent> {
  const target = input.target;
  return input.subagents.filter((child) => {
    if (
      child.origin !== "provider_native" ||
      (child.status !== "completed" && child.status !== "failed")
    )
      return false;
    const revision = childResultRevision(child);
    return !input.transfers.some(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === child.childThreadId &&
        transfer.sourceRevision === revision &&
        // Delivery belongs to the native conversation that received it.
        // Hidden child context is not part of a fresh target's ordinary history.
        target?.nativeThreadId != null &&
        input.attempts?.some(
          (attempt) =>
            attempt.id === transfer.targetRunAttemptId &&
            attempt.runId === transfer.targetRunId &&
            attempt.providerThreadId === target.providerThreadId &&
            attempt.nativeThreadId === target.nativeThreadId,
        ) === true &&
        input.providerTurns.some(
          (turn) =>
            turn.status === "completed" && turn.runAttemptId === transfer.targetRunAttemptId,
        ),
    );
  });
}

/** The owning native conversation already carries its children's context. */
export function needsPortableChildContext(input: {
  readonly child: Pick<OrchestrationV2Subagent, "providerThreadId" | "runId">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "providerThreadId">>;
  readonly targetProviderThreadId: string;
  readonly sameNativeThread: boolean;
  readonly sameSelection: boolean;
  readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly targetNativeThreadId?: string | undefined;
}): boolean {
  // Codex rows name the child conversation; its run names the owning parent.
  const owner =
    input.runs.find((run) => run.id === input.child.runId)?.providerThreadId ??
    input.child.providerThreadId;
  // Steering can reuse the run while changing its provider thread. Without
  // an exact launch-attempt identity, preserve context from every possible
  // source generation until this destination has received its own marker.
  const changedSource = input.attempts?.some(
    (attempt) =>
      attempt.runId === input.child.runId &&
      (attempt.providerThreadId !== input.targetProviderThreadId ||
        (attempt.nativeThreadId !== undefined &&
          input.targetNativeThreadId !== undefined &&
          attempt.nativeThreadId !== input.targetNativeThreadId)),
  );
  return (
    changedSource === true ||
    owner !== input.targetProviderThreadId ||
    !input.sameNativeThread ||
    !input.sameSelection
  );
}
