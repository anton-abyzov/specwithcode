import type { EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import { MessageSquareTextIcon, PlusIcon } from "lucide-react";
import { useCallback, useId, useRef, useState, useSyncExternalStore } from "react";

import type { ProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import type { AnsweredQuestion } from "../../studio/coordinatorQuestionAnswers";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerBanner } from "../chat/ComposerBanner";
import {
  ComposerPendingUserInputPanel,
  type QuestionTextRenderer,
} from "../chat/ComposerPendingUserInputPanel";
import { DecisionCard } from "../chat/DecisionCard";
import { linkifyQuestionPaths } from "../chat/questionCard.logic";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { submitCoordinatorDraft } from "./CoordinatorComposer";
import {
  coordinatorAttachAccept,
  CoordinatorAttachmentNotice,
  CoordinatorAttachmentStrip,
  filesFrom,
  pastedFilesFrom,
  useCoordinatorAttachments,
} from "./shell/CoordinatorAttachments";
import type { CoordinatorQuestion } from "./useCoordinatorQuestion";

/** Where the coordinator's message box lives; the card's "reply in chat" lands there. */
export const COORDINATOR_PROMPT_ID = "project-prompt";

export function focusCoordinatorPrompt(): boolean {
  const prompt = document.getElementById(COORDINATOR_PROMPT_ID);
  if (!(prompt instanceof HTMLTextAreaElement) || prompt.disabled) return false;
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  return true;
}

function useQuestionText(environmentId: EnvironmentId, cwd: string | undefined) {
  return useCallback<QuestionTextRenderer>(
    (text, variant) => (
      <ChatMarkdown
        text={linkifyQuestionPaths(text)}
        cwd={cwd}
        environmentId={environmentId}
        className={
          variant === "question"
            ? "text-sm leading-snug text-foreground"
            : "text-xs leading-snug text-muted-foreground"
        }
      />
    ),
    [cwd, environmentId],
  );
}

/**
 * The coordinator's open question, above the message box: an option answers it,
 * and so does whatever is typed, pasted or attached below and sent.
 */
export function CoordinatorQuestionCard(props: {
  readonly question: CoordinatorQuestion;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  /** The message box cannot answer now; the requests dialog takes the answer. */
  readonly onAnswerElsewhere: () => void;
}) {
  const { question } = props;
  const renderText = useQuestionText(props.environmentId, props.cwd);
  return (
    <ComposerBanner.Root
      placement="floating"
      variant="info"
      className="mb-2"
      role="region"
      aria-label={`Question from the ${question.askedBy.toLowerCase()}`}
      data-coordinator-question={question.active.requestId}
    >
      <ComposerPendingUserInputPanel
        pendingUserInputs={[...question.requests]}
        disabled={question.disabled}
        respondingRequestIds={question.respondingRequestIds}
        answers={question.answers}
        questionIndex={question.questionIndex}
        onToggleOption={question.toggleOption}
        onAdvance={question.advance}
        onPrevious={question.previous}
        onDismiss={question.dismiss}
        onReplyInChat={() => {
          if (!question.composerCanAnswer || !focusCoordinatorPrompt()) props.onAnswerElsewhere();
        }}
        askedBy={question.askedBy}
        renderText={renderText}
      />
    </ComposerBanner.Root>
  );
}

/** What the requests dialog needs to answer the coordinator's question from the page's draft. */
export interface CoordinatorQuestionRecoveryContext {
  readonly question: CoordinatorQuestion;
  readonly composer: ProjectCoordinatorComposer;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly uploadsSupported: boolean;
  readonly canAttach: boolean;
  readonly maxFileBytes: number | null;
  /** Why the message box cannot send right now; shown above the recovery box. */
  readonly composerProblem: string | null;
}

/**
 * The question inside the requests dialog. While the message box can send, the
 * dialog only points there. Only when it cannot does the dialog take the answer,
 * in a box holding that same draft and its files.
 */
export function CoordinatorQuestionRecovery(props: {
  readonly recovery: CoordinatorQuestionRecoveryContext;
  /** Closes the dialog and puts the cursor in the coordinator's message box. */
  readonly onAnswerInChat: () => void;
}) {
  const { question } = props.recovery;
  const renderText = useQuestionText(props.recovery.environmentId, props.recovery.cwd);
  const answerId = useId();
  return (
    <section
      className="space-y-3"
      aria-label={`Question from the ${question.askedBy.toLowerCase()}`}
    >
      <div className="rounded-lg border border-border/80">
        <ComposerPendingUserInputPanel
          pendingUserInputs={[...question.requests]}
          disabled={question.disabled}
          respondingRequestIds={question.respondingRequestIds}
          answers={question.answers}
          questionIndex={question.questionIndex}
          onToggleOption={question.toggleOption}
          onAdvance={question.advance}
          onPrevious={question.previous}
          onDismiss={question.dismiss}
          onReplyInChat={
            question.composerCanAnswer
              ? props.onAnswerInChat
              : () => document.getElementById(answerId)?.focus()
          }
          askedBy={question.askedBy}
          renderText={renderText}
        />
      </div>
      {question.composerCanAnswer ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-sm text-muted-foreground">
            Type, paste or attach your answer in the message box, then send it.
          </p>
          <Button
            size="sm"
            onClick={props.onAnswerInChat}
            data-answer-in-chat=""
            data-request-focus=""
          >
            <MessageSquareTextIcon aria-hidden />
            Answer in chat
          </Button>
        </div>
      ) : question.active.questions.some((entry) => entry.allowCustomAnswer !== false) ? (
        <CoordinatorDraftAnswer recovery={props.recovery} id={answerId} />
      ) : null}
    </section>
  );
}

/** The recovery box: the coordinator's own draft, text and files, sent as the answer. */
function CoordinatorDraftAnswer(props: {
  readonly recovery: CoordinatorQuestionRecoveryContext;
  readonly id: string;
}) {
  const { question, composer } = props.recovery;
  const { prompt, submitting } = useSyncExternalStore(
    composer.subscribe,
    composer.getSnapshot,
    composer.getSnapshot,
  );
  const attached = useCoordinatorAttachments({
    environmentId: props.recovery.environmentId,
    draft: composer,
    uploadsSupported: props.recovery.uploadsSupported,
    canUpload: props.recovery.canAttach,
    maxFileBytes: props.recovery.maxFileBytes,
  });
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const responding = question.respondingRequestIds.includes(question.active.requestId);
  const locked = question.disabled || submitting || responding;
  const sendDisabled =
    locked ||
    attached.preparing.length > 0 ||
    (!prompt.trim() && attached.attachments.length === 0);
  const send = () => {
    if (sendDisabled) return;
    void submitCoordinatorDraft({
      composer,
      attached,
      onAppCommand: null,
      onSend: question.answerFromDraft,
      onError: setError,
    });
  };
  return (
    <div
      className="grid gap-2"
      data-coordinator-draft-answer=""
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        attached.add(filesFrom(event.dataTransfer));
      }}
    >
      <label htmlFor={props.id} className="text-sm font-medium">
        Your answer
      </label>
      <p className="text-xs text-muted-foreground" data-recovery-reason="">
        {props.recovery.composerProblem
          ? `${props.recovery.composerProblem} `
          : "The message box cannot send right now. "}
        This box holds the same draft, so nothing you type is lost.
      </p>
      <CoordinatorAttachmentNotice problem={attached.problem} onDismiss={attached.dismissProblem} />
      <CoordinatorAttachmentStrip
        attachments={attached.attachments}
        preparing={attached.preparing}
        locked={locked}
        onRemove={(id) => {
          attached.remove(id);
          document.getElementById(props.id)?.focus();
        }}
      />
      <Textarea
        id={props.id}
        size="sm"
        data-request-focus=""
        value={prompt}
        disabled={question.disabled}
        aria-describedby={error ? `${props.id}-error` : undefined}
        onChange={(event) => composer.setPrompt(event.target.value)}
        onPaste={(event) => {
          const files = pastedFilesFrom(event.clipboardData);
          if (files.length === 0) return;
          event.preventDefault();
          attached.add(files);
        }}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter starts a new line, as in the message box.
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      {error ? (
        <p id={`${props.id}-error`} role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <input
          ref={picker}
          type="file"
          accept={coordinatorAttachAccept(props.recovery.maxFileBytes !== null)}
          multiple
          hidden
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            attached.add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!props.recovery.canAttach || locked}
          onClick={() => picker.current?.click()}
        >
          <PlusIcon aria-hidden />
          Attach files
        </Button>
        <Button
          size="sm"
          disabled={sendDisabled}
          aria-busy={submitting || responding}
          onClick={send}
        >
          {submitting || responding ? "Sending…" : "Send answer"}
        </Button>
      </div>
    </div>
  );
}

/**
 * An answered coordinator question in the conversation: the card the agent
 * asked, with what was chosen. An answer sent from the card folds into it; a
 * reply typed in chat follows it as the person's own message.
 */
export function CoordinatorDecisionRow(props: {
  readonly item: AnsweredQuestion;
  readonly askedBy: string;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
}) {
  return (
    <div className="project-decision" data-coordinator-decision={props.item.requestId}>
      <DecisionCard
        item={props.item}
        askedBy={props.askedBy}
        renderText={(text) => (
          <ChatMarkdown
            text={linkifyQuestionPaths(text)}
            cwd={props.cwd}
            threadRef={props.threadRef}
            className="text-sm leading-snug text-foreground"
          />
        )}
      />
    </div>
  );
}
