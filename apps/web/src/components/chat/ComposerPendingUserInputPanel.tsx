import { type RuntimeRequestId } from "@specweave-studio/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { ArrowRightIcon, CheckIcon, ChevronLeftIcon, CornerDownLeftIcon } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn, isMacPlatform } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import {
  deriveQuestionStep,
  presentQuestionOption,
  questionOptionIndexForKey,
  questionOptionLetter,
  splitQuestionText,
} from "./questionCard.logic";

/**
 * Renders question and option text. The composer passes a markdown renderer so
 * file paths open in the app and URLs open externally; the default is plain.
 */
export type QuestionTextRenderer = (text: string, variant: "question" | "description") => ReactNode;

const renderPlainQuestionText: QuestionTextRenderer = (text) => text;

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  /**
   * Steps back one question. When present, multi-select questions get their
   * own Back / Next / Submit footer; hosts with their own buttons omit it.
   */
  onPrevious?: (() => void) | undefined;
  onDismiss: (requestId: RuntimeRequestId) => void;
  /** Moves focus to where a free-text answer is typed. Hidden when absent. */
  onReplyInChat?: (() => void) | undefined;
  renderText?: QuestionTextRenderer | undefined;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onPrevious,
  onDismiss,
  onReplyInChat,
  renderText = renderPlainQuestionText,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      waitingCount={pendingUserInputs.length - 1}
      disabled={disabled}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onPrevious={onPrevious}
      onDismiss={onDismiss}
      onReplyInChat={onReplyInChat}
      renderText={renderText}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  waitingCount,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onPrevious,
  onDismiss,
  onReplyInChat,
  renderText,
}: {
  prompt: PendingUserInput;
  /** Requests queued behind this one; each shows after this one is answered. */
  waitingCount: number;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onPrevious: (() => void) | undefined;
  onDismiss: (requestId: RuntimeRequestId) => void;
  onReplyInChat: (() => void) | undefined;
  renderText: QuestionTextRenderer;
}) {
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  // Collapsing hides everything but the header so a tall prompt stops covering
  // the thread the user is trying to read. Scoped to a single question: the card
  // is keyed by request id so the next prompt starts expanded, and storing the
  // collapsed question's id (rather than a bare flag) reopens the card when the
  // prompt advances to its next question, which can happen without a click —
  // sending from the composer advances the active question.
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    if (disabled && autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, [disabled]);

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionValues,
  ]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = useCallback(
    (questionId: string, optionValue: string) => {
      if (disabled || isResponding) return;
      if (activeQuestion?.multiSelect) {
        onToggleOption(questionId, optionValue);
        return;
      }
      setOptimisticSingleSelect({ questionId, optionValue });
      onToggleOption(questionId, optionValue);
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvanceRef.current();
      }, 200);
    },
    [activeQuestion, disabled, isResponding, onToggleOption],
  );

  // Keyboard shortcuts while focus is outside editable fields: a letter (A, B,
  // C …) or number key picks that option. Multi-select prompts toggle options
  // in place; single-select prompts keep the auto-advance. Collapsed prompts
  // opt out, since the options they refer to are not on screen.
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest(
          '[contenteditable]:not([contenteditable="false"]),[role="dialog"],[role="menu"]',
        )
      ) {
        return;
      }
      const optionIndex = questionOptionIndexForKey(event.key, activeQuestion.options.length);
      if (optionIndex === -1) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, handleOptionSelection, isCollapsed, responseDisabled]);

  const showStepFooter = Boolean(onPrevious && activeQuestion?.multiSelect);
  const step = deriveQuestionStep({
    questionIndex: progress.questionIndex,
    questionCount: prompt.questions.length,
    selectedCount:
      progress.customAnswer.trim().length > 0 ? 0 : progress.selectedOptionValues.length,
    isLastQuestion: progress.isLastQuestion,
    canAdvance: progress.canAdvance,
    isComplete: progress.isComplete,
    isResponding,
  });
  const canStep = showStepFooter && step.enabled && !responseDisabled;
  const isMac = isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform);

  // Cmd/Ctrl+Enter takes the footer's step from anywhere outside a text field;
  // inside the composer, Enter already submits the same answer.
  useEffect(() => {
    if (!canStep || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest(
          '[contenteditable]:not([contenteditable="false"]),[role="dialog"],[role="menu"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      onAdvanceRef.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [canStep, isCollapsed]);

  // Arrow keys move between options like a list; Enter or Space picks one.
  const moveOptionFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[data-question-option]:not([aria-disabled='true'])",
      ),
    );
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % options.length
            : (current - 1 + options.length) % options.length;
    event.preventDefault();
    options[next]?.focus();
  }, []);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const { headline, details } = splitQuestionText(activeQuestion.question);

  return (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          isCollapsed ? "Show the question and its options" : "Hide the question and its options"
        }
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
      >
        <ComposerBanner.Icon />
        <ComposerBanner.Content>
          <span className="shrink-0 font-medium text-muted-foreground">
            {activeQuestion.header}
          </span>
          {isCollapsed ? (
            <span className="min-w-0 flex-1 truncate text-secondary-label">{headline}</span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {waitingCount > 0 ? (
            <span
              data-pending-user-input-waiting={waitingCount}
              className="rounded px-1.5 py-px text-3xs font-medium whitespace-nowrap bg-muted text-muted-foreground tabular-nums"
            >
              <span aria-hidden>+{waitingCount} more</span>
              <span className="sr-only">
                {`${waitingCount} more ${waitingCount === 1 ? "request is" : "requests are"} waiting; each opens after you answer this one`}
              </span>
            </span>
          ) : null}
          {prompt.questions.length > 1 ? (
            <span className="text-3xs font-medium text-muted-foreground tabular-nums">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          {prompt.dismissible ? (
            // Sits inside the trigger button, so stop the click from toggling
            // the disclosure. Dismiss closes the question without a reply.
            <ComposerBanner.Dismiss
              render={<span role="button" tabIndex={0} />}
              aria-label="Dismiss question without answering"
              title="Dismiss question without answering"
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
            />
          ) : null}
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <div
            className="px-2 pt-1 pb-1.5 wrap-anywhere sm:px-3"
            data-question-card
            data-question-card-request={prompt.requestId}
          >
            <div className="text-sm leading-snug font-medium text-foreground">
              {renderText(headline, "question")}
            </div>
            {details !== null ? (
              <div
                className="mt-1.5 text-xs leading-snug text-muted-foreground"
                data-question-details
              >
                {renderText(details, "description")}
              </div>
            ) : null}
            {activeQuestion.multiSelect ? (
              <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
            ) : null}
            <div
              role={activeQuestion.multiSelect ? "group" : "radiogroup"}
              aria-label={headline}
              className="mt-2 divide-y divide-border/60"
              onKeyDown={moveOptionFocus}
            >
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const presented = presentQuestionOption(option);
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected ||
                  (!customAnswerActive && progress.selectedOptionValues.includes(optionValue));
                const letter = questionOptionLetter(index);
                const unavailable = disabled || isResponding;
                return (
                  // A div, not a button: descriptions may hold links, which
                  // cannot nest inside a button and must not pick the option.
                  <div
                    key={`${activeQuestion.id}:${optionValue}`}
                    role={activeQuestion.multiSelect ? "checkbox" : "radio"}
                    tabIndex={unavailable ? -1 : 0}
                    aria-checked={isSelected}
                    aria-disabled={unavailable || undefined}
                    aria-keyshortcuts={letter.length === 1 ? letter : undefined}
                    data-question-option={letter}
                    data-recommended={presented.recommended ? "true" : undefined}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a,button")) return;
                      handleOptionSelection(activeQuestion.id, optionValue);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key !== "Enter" && event.key !== " ") return;
                      // Let the card's step shortcut reach its document handler.
                      if (
                        showStepFooter &&
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      handleOptionSelection(activeQuestion.id, optionValue);
                    }}
                    className={cn(
                      "group/option flex w-full items-start gap-3 rounded-md px-1.5 py-2 text-left outline-none transition-colors duration-150",
                      "focus-visible:bg-muted/45 focus-visible:ring-1 focus-visible:ring-primary/30",
                      isSelected ? "bg-muted/55" : "hover:bg-muted/35",
                      unavailable ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-medium tabular-nums transition-colors",
                        isSelected
                          ? "border-primary/40 bg-primary/12 text-primary"
                          : "border-border bg-background/60 text-muted-foreground group-hover/option:text-foreground group-focus-visible/option:text-foreground",
                      )}
                    >
                      {isSelected ? <CheckIcon className="size-3.5" /> : letter}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-semibold text-foreground">
                          {presented.label}
                        </span>
                        {presented.recommended ? (
                          <span
                            data-question-recommended
                            className="rounded px-1.5 py-px text-3xs font-medium bg-info/12 text-info-foreground"
                          >
                            Recommended
                          </span>
                        ) : null}
                      </span>
                      {presented.description ? (
                        <div className="text-xs leading-snug text-muted-foreground">
                          {renderText(presented.description, "description")}
                        </div>
                      ) : null}
                    </div>
                    <CornerDownLeftIcon
                      aria-hidden
                      className={cn(
                        "mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity",
                        !unavailable &&
                          "group-hover/option:opacity-100 group-focus-visible/option:opacity-100",
                      )}
                    />
                  </div>
                );
              })}
            </div>
            {onReplyInChat && activeQuestion.allowCustomAnswer !== false && !showStepFooter ? (
              <p className="mt-1.5 px-1.5 text-xs text-muted-foreground">
                Or just{" "}
                <button
                  type="button"
                  data-question-reply-in-chat
                  className="cursor-pointer underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-foreground/60 focus-visible:text-foreground focus-visible:outline-none"
                  onClick={onReplyInChat}
                >
                  reply in chat
                </button>
                .
              </p>
            ) : null}
          </div>
        </ComposerBanner.Scroll>
        {showStepFooter ? (
          // Outside the scroll area, so the step stays in reach however long
          // the option list is.
          <div
            data-question-step
            className="mx-2 mt-0.5 flex items-center gap-2 border-t border-border/60 pt-2 pb-1 sm:mx-3"
          >
            <p className="flex min-w-0 flex-1 items-baseline px-1.5 text-xs text-muted-foreground">
              <span
                aria-live="polite"
                data-question-step-selection
                className={cn(
                  "shrink-0 whitespace-nowrap tabular-nums",
                  progress.selectedOptionValues.length > 0 && "text-foreground",
                )}
              >
                {step.selection}
              </span>
              {onReplyInChat && activeQuestion.allowCustomAnswer !== false ? (
                // Narrow panels keep the count and the step; the composer below
                // still takes a typed reply.
                <span className="min-w-0 truncate whitespace-pre @max-[420px]:hidden">
                  <span aria-hidden> · </span>
                  <button
                    type="button"
                    data-question-reply-in-chat
                    className="cursor-pointer underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-foreground/60 focus-visible:text-foreground focus-visible:outline-none"
                    onClick={onReplyInChat}
                  >
                    or reply in chat
                  </button>
                </span>
              ) : null}
            </p>
            {progress.questionIndex > 0 && onPrevious ? (
              <button
                type="button"
                data-question-step-back
                disabled={responseDisabled}
                onClick={onPrevious}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <ChevronLeftIcon aria-hidden className="size-3.5" />
                Back
              </button>
            ) : null}
            <button
              type="button"
              data-question-step-next={step.isSubmit ? "submit" : "next"}
              disabled={!canStep}
              aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"}
              onClick={() => onAdvanceRef.current()}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-message-action pr-1.5 pl-3 text-xs font-medium text-message-action-foreground shadow-xs shadow-message-action/24 outline-none transition-colors hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-(--disabled-opacity) disabled:shadow-none"
            >
              {step.label}
              {step.isSubmit ? (
                <CheckIcon aria-hidden className="size-3.5" />
              ) : (
                <ArrowRightIcon aria-hidden className="size-3.5" />
              )}
              <span
                aria-hidden
                className="hidden rounded bg-message-action-foreground/15 px-1 text-3xs leading-4 sm:inline"
              >
                {isMac ? "⌘↵" : "Ctrl+↵"}
              </span>
            </button>
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
});
