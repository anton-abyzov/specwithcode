import { CoordinatorQuestionAttachments } from "./CoordinatorQuestionAttachments";
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
import { Textarea } from "../ui/textarea";
import ChatMarkdown from "../ChatMarkdown";
import { useEffect, useId, useRef, useState } from "react";
import { useProjectMessageRouting } from "../../studio/projectMessageRouting";

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
  onCustomAnswer,
  questionAttachmentContext,
  onPrevious,
  onAdvance,
  onDismiss,
  planMarkdown,
  onImplementPlan,
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
  onCustomAnswer: (questionId: string, value: string) => void;
  questionAttachmentContext?:
    | {
        environmentId: import("@specweave-studio/contracts").EnvironmentId;
        threadId: import("@specweave-studio/contracts").ThreadId;
        maxFileBytes: number | null;
      }
    | undefined;
  onPrevious: () => void;
  onAdvance: () => void;
  onDismiss: (id: RuntimeRequestId) => void;
  planMarkdown: string | null;
  onImplementPlan: () => Promise<boolean>;
}) {
  const answerId = useId();
  const [implementing, setImplementing] = useState(false);
  const routing = useProjectMessageRouting();
  const sawRequests = useRef(false);
  const resolved = useRef(false);
  const hasRequests = approvals.length > 0 || questions.length > 0 || Boolean(planMarkdown);
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
  const approval = approvals[0];
  const question = questions[0];
  const questionDisabled =
    disabled ||
    question?.responseCapability === "not_resumable" ||
    (question !== undefined && respondingQuestions.includes(question.requestId));
  return (
    <div className="space-y-4" data-coordinator-native-controls="" aria-busy={loading}>
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
      {question ? (
        <section className="space-y-3" aria-label="Coordinator question">
          <ComposerPendingUserInputPanel
            pendingUserInputs={questions}
            disabled={questionDisabled}
            respondingRequestIds={respondingQuestions}
            answers={answers}
            questionIndex={questionIndex}
            onToggleOption={onOption}
            onAdvance={onAdvance}
            onDismiss={onDismiss}
          />
          {progress?.activeQuestion && progress.activeQuestion.allowCustomAnswer !== false ? (
            <label htmlFor={answerId} className="grid gap-2 text-sm">
              <span className="font-medium">Your answer</span>
              <Textarea
                id={answerId}
                size="sm"
                value={progress.customAnswer}
                disabled={questionDisabled}
                onChange={(event) =>
                  onCustomAnswer(progress.activeQuestion!.id, event.target.value)
                }
              />
            </label>
          ) : null}
          {questionAttachmentContext &&
          progress?.activeQuestion &&
          progress.activeQuestion.allowCustomAnswer !== false ? (
            <CoordinatorQuestionAttachments
              {...questionAttachmentContext}
              requestId={question.requestId}
              questionId={progress.activeQuestion.id}
              allQuestionIds={question.questions.map((question) => question.id)}
              disabled={questionDisabled}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            {questionIndex > 0 ? (
              <Button variant="outline" size="sm" disabled={questionDisabled} onClick={onPrevious}>
                Previous question
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={questionDisabled || !progress?.canAdvance}
              aria-busy={question !== undefined && respondingQuestions.includes(question.requestId)}
              onClick={onAdvance}
            >
              {question !== undefined && respondingQuestions.includes(question.requestId)
                ? "Sending…"
                : progress?.isLastQuestion
                  ? "Send answer"
                  : "Next question"}
            </Button>
          </div>
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
      {!loading && !approval && !question && !planMarkdown ? (
        <p className="text-sm text-muted-foreground" role="status">
          No requests need your response.
        </p>
      ) : null}
    </div>
  );
}
