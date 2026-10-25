import type {
  EnvironmentId,
  ScopedThreadRef,
  ProviderApprovalDecision,
  RuntimeRequestId,
} from "@specweave-studio/contracts";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer, PendingUserInputProgress } from "../../pendingUserInput";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useProjectMessageRouting } from "../../studio/projectMessageRouting";
import { COORDINATOR_PROMPT_ID, CoordinatorQuestionRecovery } from "./CoordinatorQuestionCard";

/**
 * The control a keyboard user lands on first, in this order: an approval's
 * Decline (never Approve, so a stray Enter grants nothing, whatever order the
 * provider lists its options in), the request's own action (Answer in chat,
 * the recovery box, Implement plan), then a question's first option.
 */
const FIRST_ACTION_SELECTORS = [
  "section[aria-label='Approval request'] button[data-approval-decision='decline']:not(:disabled)",
  "[data-request-focus]:not(:disabled)",
  "[data-question-option]:not([aria-disabled='true'])",
];

export function firstRequestAction(root: ParentNode | null): HTMLElement | null {
  if (root === null) return null;
  for (const selector of FIRST_ACTION_SELECTORS) {
    const found = root.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return null;
}

/** Native decisions only. The project's conversation and message composer stay in place. */
export function CoordinatorNativeControls({
  markdownContext,
  loading,
  disabled,
  error,
  approvals,
  respondingApprovals,
  onApproval,
  questions,
  answers,
  questionIndex,
  progress,
  respondingQuestions,
  onOption,
  onPrevious,
  onAdvance,
  onDismiss,
  planMarkdown,
  onImplementPlan,
  heldQueue = null,
}: {
  markdownContext: {
    environmentId: EnvironmentId;
    threadRef: ScopedThreadRef | undefined;
    cwd: string | undefined;
  };
  loading: boolean;
  disabled: boolean;
  error: string | null;
  approvals: PendingApproval[];
  respondingApprovals: RuntimeRequestId[];
  onApproval: (id: RuntimeRequestId, decision: ProviderApprovalDecision) => Promise<unknown>;
  questions: PendingUserInput[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  progress: PendingUserInputProgress | null;
  respondingQuestions: RuntimeRequestId[];
  onOption: (questionId: string, option: string) => void;
  onPrevious: () => void;
  onAdvance: () => void;
  onDismiss: (id: RuntimeRequestId) => void;
  planMarkdown: string | null;
  onImplementPlan: () => Promise<boolean>;
  /** Messages held in the coordinator's queue, with Resume and Discard; null when none. */
  heldQueue?: ReactNode;
}) {
  const [implementing, setImplementing] = useState(false);
  const routing = useProjectMessageRouting();
  const rootRef = useRef<HTMLDivElement>(null);
  const sawRequests = useRef(false);
  const resolved = useRef(false);
  const hasRequests =
    approvals.length > 0 || questions.length > 0 || Boolean(planMarkdown) || heldQueue !== null;
  const onResolved = routing?.onCoordinatorRequestsResolved;
  useEffect(() => {
    if (hasRequests) sawRequests.current = true;
    if (
      sawRequests.current &&
      !resolved.current &&
      !hasRequests &&
      !loading &&
      !disabled &&
      !error &&
      !implementing &&
      respondingApprovals.length === 0 &&
      respondingQuestions.length === 0 &&
      onResolved
    ) {
      resolved.current = true;
      onResolved();
    }
  }, [
    hasRequests,
    loading,
    disabled,
    error,
    implementing,
    respondingApprovals.length,
    respondingQuestions.length,
    onResolved,
  ]);
  // Requests that arrive after the dialog opened take the focus it gave its Close button.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || loading || !hasRequests) return;
    focused.current = true;
    const current = document.activeElement;
    if (current instanceof HTMLElement && rootRef.current?.contains(current)) return;
    if (current instanceof HTMLElement && !current.closest("[role='dialog']")) return;
    firstRequestAction(rootRef.current)?.focus();
  }, [loading, hasRequests]);
  const approval = approvals[0];
  const question = questions[0];
  const questionDisabled =
    disabled ||
    question?.responseCapability === "not_resumable" ||
    (question !== undefined && respondingQuestions.includes(question.requestId));
  // On the project page, the question is the page's own: the same card and draft.
  const recovery = routing?.coordinatorQuestion ?? null;
  return (
    <div
      ref={rootRef}
      className="space-y-4"
      data-coordinator-native-controls=""
      aria-busy={loading}
    >
      {error ? (
        <p
          className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive-foreground"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading requests…
        </p>
      ) : null}
      {disabled ? (
        <p className="text-sm text-muted-foreground" role="status">
          Responses are temporarily unavailable. Check the host connection and permissions.
        </p>
      ) : null}
      {approval ? (
        <section
          className="space-y-3 rounded-lg border border-warning/25 bg-warning-surface p-4"
          aria-label="Approval request"
        >
          <ComposerPendingApprovalPanel approval={approval} pendingCount={approvals.length} />
          <div
            className="flex flex-wrap items-center gap-2"
            aria-busy={respondingApprovals.includes(approval.requestId)}
          >
            <ComposerPendingApprovalActions
              requestId={approval.requestId}
              options={approval.options}
              disabled={disabled || approval.responseCapability !== "live"}
              isResponding={respondingApprovals.includes(approval.requestId)}
              canRespond={approval.responseCapability === "live"}
              onRespondToApproval={onApproval}
            />
          </div>
        </section>
      ) : null}
      {question && recovery !== null ? (
        <CoordinatorQuestionRecovery
          recovery={recovery}
          onAnswerInChat={() =>
            routing?.closeCoordinatorRequests?.(document.getElementById(COORDINATOR_PROMPT_ID))
          }
        />
      ) : question ? (
        // Outside the project page there is no message box to answer from: the options remain.
        <section className="space-y-3" aria-label="Coordinator question">
          <ComposerPendingUserInputPanel
            pendingUserInputs={questions}
            disabled={questionDisabled}
            respondingRequestIds={respondingQuestions}
            answers={answers}
            questionIndex={questionIndex}
            onToggleOption={onOption}
            onAdvance={onAdvance}
            onPrevious={onPrevious}
            onDismiss={onDismiss}
          />
          {questionIndex > 0 || progress?.canAdvance ? (
            <div className="flex justify-end gap-2">
              {questionIndex > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={questionDisabled}
                  onClick={onPrevious}
                >
                  Previous question
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={questionDisabled || !progress?.canAdvance}
                aria-busy={respondingQuestions.includes(question.requestId)}
                onClick={onAdvance}
              >
                {respondingQuestions.includes(question.requestId)
                  ? "Sending…"
                  : progress?.isLastQuestion
                    ? "Send answer"
                    : "Next question"}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      {heldQueue !== null ? (
        <section className="space-y-2" aria-label="Held messages" data-coordinator-held="">
          <p className="text-sm text-muted-foreground">
            These messages to the coordinator were held and not delivered. Resume sends them in
            order; Discard drops them.
          </p>
          {heldQueue}
        </section>
      ) : null}
      {planMarkdown ? (
        <section className="space-y-4" aria-label="Proposed plan">
          <ChatMarkdown
            text={planMarkdown}
            environmentId={markdownContext.environmentId}
            threadRef={markdownContext.threadRef}
            cwd={markdownContext.cwd}
            isStreaming={false}
            headingLevelOffset={2}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              data-request-focus=""
              disabled={disabled || implementing || Boolean(approval) || Boolean(question)}
              aria-busy={implementing}
              onClick={async () => {
                if (implementing) return;
                setImplementing(true);
                try {
                  await onImplementPlan();
                } finally {
                  setImplementing(false);
                }
              }}
            >
              {implementing ? "Starting…" : "Implement plan"}
            </Button>
          </div>
        </section>
      ) : null}
      {!loading && !hasRequests ? (
        <p className="text-sm text-muted-foreground" role="status">
          No requests need your response.
        </p>
      ) : null}
    </div>
  );
}
