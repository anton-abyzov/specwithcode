import type { OrchestrationV2ThreadProjection } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { latestExecutedRun } from "./orchestrationV2ThreadError.ts";

/** Delivery evidence is independent of provider runtime status and PR readiness. */
export interface LifecycleRequest {
  readonly requestId: string;
  readonly runId: string;
  /** Changes when acceptance is reopened, even if the original request is retained. */
  readonly acceptanceRevision: string;
  readonly requestedAt: string;
}

export type LifecycleWaitKind =
  | "agent_work"
  | "resource"
  | "network"
  | "tool"
  | "deployment"
  | "review"
  | "dependency"
  | "user_action"
  | "authentication"
  | "provider"
  | "usage_limit"
  | "nested_work"
  | "stopped"
  | "unknown";

export interface LifecycleObligation {
  readonly kind: LifecycleWaitKind;
  readonly reason: string;
  readonly owner: string;
  readonly nextEvent: string;
  /** A resource/provider failure is not user attention unless it needs user output. */
  readonly needsUserOutput: boolean;
}

export interface VerifiedLifecycleEvidence {
  readonly status: "verified";
  readonly reference: string;
  readonly observedAt: string;
  readonly scopeRevision: string;
}

export type LifecycleGate =
  | VerifiedLifecycleEvidence
  | { readonly status: "not_applicable"; readonly rationale: string }
  | { readonly status: "pending"; readonly reason: string };

export interface LifecycleGoal {
  readonly id: string;
  readonly scope: string;
  readonly scopeRevision: string;
  readonly obligations: readonly (LifecycleObligation & {
    readonly id: string;
    readonly completion: LifecycleGate;
  })[];
}

/** Stable requirements cannot disappear when a reporter narrows a turn's scope. */
export function lifecycleGoalUpdateError(
  previous: LifecycleGoal | undefined,
  next: LifecycleGoal | undefined,
  nowMs: number,
): string | null {
  const goal = next ?? previous;
  if (goal === undefined) return null;
  for (const item of goal.obligations) {
    const completion = item.completion;
    if (completion.status !== "verified") continue;
    const observed = Date.parse(completion.observedAt);
    if (
      !completion.reference.trim() ||
      completion.scopeRevision !== goal.scopeRevision ||
      !Number.isFinite(observed) ||
      !Number.isFinite(nowMs) ||
      observed > nowMs
    )
      return `Completion evidence must already verify this goal revision: ${item.reason}.`;
  }
  if (next === undefined) return null; // The command inherits previous.
  if (
    next.obligations.length === 0 ||
    new Set(next.obligations.map((item) => item.id)).size !== next.obligations.length
  )
    return "A goal needs distinct required obligation IDs.";
  if (previous === undefined) return null;
  if (
    previous.id !== next.id ||
    previous.scope !== next.scope ||
    previous.scopeRevision !== next.scopeRevision
  )
    return "A recorded goal's identity and scope cannot be replaced by a narrower delivery report.";
  for (const old of previous.obligations) {
    const item = next.obligations.find((candidate) => candidate.id === old.id);
    if (item === undefined || item.kind !== old.kind || item.reason !== old.reason)
      return `Required goal work cannot be removed or redefined: ${old.reason}.`;
  }
  return null;
}

/** Evidence persists across runs, but must verify each requirement for this goal revision. */
export function pendingLifecycleGoalObligations(
  goal: LifecycleGoal | undefined,
  nowMs: number,
  recordedAtMs: number = nowMs,
) {
  if (goal === undefined) return [];
  return goal.obligations.filter(({ completion }) => {
    if (completion.status !== "verified") return true;
    const observed = Date.parse(completion.observedAt);
    return (
      !completion.reference.trim() ||
      completion.scopeRevision !== goal.scopeRevision ||
      !Number.isFinite(observed) ||
      !Number.isFinite(nowMs) ||
      !Number.isFinite(recordedAtMs) ||
      observed > Math.min(nowMs, recordedAtMs)
    );
  });
}

export interface LifecycleReceipt extends LifecycleRequest {
  readonly kind: "code" | "no_code";
  readonly scope: string;
  readonly scopeRevision: string;
  readonly recordedAt: string;
  readonly validUntil: string;
  /** Filled from the authenticated reporting context, never provider final prose. */
  readonly reportedBy: string;
  readonly obligations: readonly LifecycleObligation[];
  readonly goal?: LifecycleGoal | undefined;
  readonly push: LifecycleGate;
  readonly merge: LifecycleGate;
  readonly deployment: LifecycleGate;
  readonly deliverable: LifecycleGate;
  readonly verification: LifecycleGate;
}

export type LifecycleEvidenceDecision =
  | "accepted"
  | "missing_evidence"
  | "superseded_request"
  | "stale_evidence"
  | "outstanding_obligations"
  | "incomplete_evidence";

const nonempty = (value: string): boolean => value.trim().length > 0;

/**
 * Pure gate shared by automatic and deferred resolution. It validates a recorded
 * adjudication; it does not turn an agent's assertion into independently verified evidence.
 * Callers must additionally enforce permissions and pending-work/Stop guards under lock.
 */
export function evaluateLifecycleEvidence(
  request: LifecycleRequest,
  receipt: LifecycleReceipt | null | undefined,
  nowMs: number,
): LifecycleEvidenceDecision {
  if (receipt == null) return "missing_evidence";
  if (
    !nonempty(request.requestId) ||
    !nonempty(request.runId) ||
    !nonempty(request.acceptanceRevision) ||
    request.requestId !== receipt.requestId ||
    request.runId !== receipt.runId ||
    request.acceptanceRevision !== receipt.acceptanceRevision ||
    request.requestedAt !== receipt.requestedAt
  )
    return "superseded_request";
  const requested = Date.parse(request.requestedAt);
  const recorded = Date.parse(receipt.recordedAt);
  const expires = Date.parse(receipt.validUntil);
  if (
    ![requested, recorded, expires, nowMs].every(Number.isFinite) ||
    recorded < requested ||
    recorded > nowMs ||
    expires <= nowMs ||
    expires <= recorded
  )
    return "stale_evidence";
  if (
    receipt.obligations.length > 0 ||
    pendingLifecycleGoalObligations(receipt.goal, nowMs, Date.parse(receipt.recordedAt)).length > 0
  )
    return "outstanding_obligations";
  if (![receipt.scope, receipt.scopeRevision, receipt.reportedBy].every(nonempty))
    return "incomplete_evidence";
  const verified = (gate: LifecycleGate): boolean => {
    if (gate.status !== "verified") return false;
    const observed = Date.parse(gate.observedAt);
    return (
      nonempty(gate.reference) &&
      gate.scopeRevision === receipt.scopeRevision &&
      Number.isFinite(observed) &&
      observed >= requested &&
      observed <= recorded
    );
  };
  const notApplicable = (gate: LifecycleGate): boolean =>
    gate.status === "not_applicable" && nonempty(gate.rationale);
  const codeGates = [receipt.push, receipt.merge, receipt.deployment];
  if (!codeGates.every(receipt.kind === "code" ? verified : notApplicable))
    return "incomplete_evidence";
  return verified(receipt.deliverable) && verified(receipt.verification)
    ? "accepted"
    : "incomplete_evidence";
}

/** A wait's owner/reason is preserved; this never resumes a stopped thread. */
export function lifecycleWaitGroup(
  obligation: LifecycleObligation,
): "Stopped" | "Unknown" | "Waiting on you" | "Operational wait" | "Agent work" {
  if (obligation.kind === "stopped") return "Stopped";
  if (obligation.kind === "unknown") return "Unknown";
  if (obligation.needsUserOutput) return "Waiting on you";
  return obligation.kind === "agent_work" || obligation.kind === "nested_work"
    ? "Agent work"
    : "Operational wait";
}

const PENDING_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * The request a receipt must name: the turn that executed last, once it
 * completed, while no other turn waits to run and no newer user message waits
 * for one. Queued turns are delivered out of ordinal order, and a queued turn
 * cancelled before it started never ran. Null means current work supersedes
 * any receipt.
 */
export function currentLifecycleRequest(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
): LifecycleRequest | null {
  const run = latestExecutedRun(projection.runs);
  if (!run || run.status !== "completed") return null;
  if (
    projection.runs.some(
      (candidate) => candidate.id !== run.id && PENDING_RUN_STATUSES.has(candidate.status),
    )
  )
    return null;
  const request = projection.messages.find((message) => message.id === run.userMessageId);
  if (!request || request.role !== "user") return null;
  // A new request can exist before a new run has been created. Messages with a
  // run are this turn's steers or requests that ran before it.
  const requestMs = DateTime.toEpochMillis(request.createdAt);
  if (
    projection.messages.some(
      (message) =>
        message.role === "user" &&
        message.id !== request.id &&
        message.runId === null &&
        DateTime.toEpochMillis(message.createdAt) >= requestMs,
    )
  )
    return null;
  return {
    requestId: run.userMessageId,
    runId: run.id,
    acceptanceRevision: projection.thread.lifecycleRevision ?? run.id,
    requestedAt: DateTime.formatIso(run.requestedAt),
  };
}

export interface LifecycleDeliveryStatus {
  readonly tone: "verified" | "waiting" | "unverified";
  readonly title: string;
  readonly lines: readonly string[];
}

const WAIT_GROUP_ORDER = [
  "Waiting on you",
  "Stopped",
  "Unknown",
  "Operational wait",
  "Agent work",
] as const;

const GATE_LABELS = {
  push: "Push",
  merge: "Merge",
  deployment: "Deployment",
  deliverable: "Deliverable",
  verification: "Verification",
} as const;

/**
 * What the thread view says about recorded delivery evidence. Nothing for legacy
 * threads or superseded receipts: current work is shown by runtime status instead.
 */
export function lifecycleDeliveryStatus(
  receipt: LifecycleReceipt | null | undefined,
  request: LifecycleRequest | null,
  nowMs: number,
): LifecycleDeliveryStatus | null {
  const pendingGoal = pendingLifecycleGoalObligations(
    receipt?.goal,
    nowMs,
    Date.parse(receipt?.recordedAt ?? ""),
  );
  if (pendingGoal.length > 0)
    return {
      tone: "waiting",
      title: "Goal still open",
      lines: pendingGoal.map(
        (item) => `${item.reason} Owner: ${item.owner}. Next: ${item.nextEvent}.`,
      ),
    };
  if (receipt == null || request === null) return null;
  const decision = evaluateLifecycleEvidence(request, receipt, nowMs);
  switch (decision) {
    case "missing_evidence":
    case "superseded_request":
      return null;
    case "accepted":
      return {
        tone: "verified",
        title: "Delivery verified",
        lines: [receipt.scope, `Reported by ${receipt.reportedBy}.`],
      };
    case "outstanding_obligations": {
      const groups = receipt.obligations.map(lifecycleWaitGroup);
      const title = WAIT_GROUP_ORDER.find((group) => groups.includes(group)) ?? "Operational wait";
      return {
        tone: "waiting",
        title,
        // The title already names the most urgent group; other groups keep their label.
        lines: receipt.obligations.map(
          (obligation, index) =>
            `${groups[index] === title ? "" : `${groups[index]}: `}${obligation.reason} Owner: ${obligation.owner}. Next: ${obligation.nextEvent}.`,
        ),
      };
    }
    case "stale_evidence":
      return {
        tone: "unverified",
        title: "Delivery evidence expired",
        lines: [
          `Recorded by ${receipt.reportedBy}. It needs a fresh check before this thread can resolve.`,
        ],
      };
    case "incomplete_evidence": {
      const pending = (Object.keys(GATE_LABELS) as Array<keyof typeof GATE_LABELS>).flatMap(
        (gate) => {
          const value = receipt[gate];
          return value.status === "pending" ? [`${GATE_LABELS[gate]}: ${value.reason}`] : [];
        },
      );
      return {
        tone: "unverified",
        title: "Delivery not verified",
        lines:
          pending.length > 0
            ? pending
            : ["Some delivery gates lack current verified evidence for this scope."],
      };
    }
  }
}
