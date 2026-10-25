import {
  CommandId,
  type ChatAttachment,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type RuntimeRequestId,
  type ThreadId,
  type UserInputAttachments,
} from "@specweave-studio/contracts";
import { derivePendingThreadRequests } from "@specweave-studio/client-runtime/state/thread-requests";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
  type PendingUserInputProgress,
} from "../../pendingUserInput";
import { planQuestionChatReply } from "../../questionChatReply";
import { derivePendingUserInputs, type PendingUserInput } from "../../session-logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import {
  COORDINATOR_ASKER,
  QUESTION_ALREADY_SETTLED,
  questionAnswerCommandId,
} from "../../studio/coordinatorQuestionAnswers";
import type { ProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import { useLatestRef } from "../../hooks/useLatestRef";
import { releaseDraftAttachment } from "../../lib/attachmentUploadQueue";
import { useQuestionSettleAnnouncements } from "../chat/questionLiveStatus";
import {
  answerProblemFor,
  isAnswerProblemOutdated,
  questionSendResult,
  settleQuestionAnswer,
  settleQuestionDismiss,
  type AnswerProblem,
  type QuestionSendProblem,
} from "../chat/questionSendOutcome";

type AnswerFile = UserInputAttachments[string][number];
type AnswersByQuestion = Record<string, PendingUserInputDraftAnswer>;

/**
 * The coordinator's open question, answered from the project page: its card
 * above the composer, the composer's text and files as the answer, and the
 * requests dialog's recovery box all use this one state.
 */
export interface CoordinatorQuestion {
  readonly requests: ReadonlyArray<PendingUserInput>;
  readonly active: PendingUserInput;
  readonly askedBy: string;
  readonly answers: AnswersByQuestion;
  readonly questionIndex: number;
  readonly progress: PendingUserInputProgress;
  readonly respondingRequestIds: RuntimeRequestId[];
  /** This connection cannot answer: the host is out of reach or the grant is missing. */
  readonly disabled: boolean;
  /** The coordinator's composer can send now; otherwise the dialog's box answers. */
  readonly composerCanAnswer: boolean;
  readonly toggleOption: (questionId: string, optionValue: string) => void;
  readonly advance: () => void;
  readonly previous: () => void;
  readonly dismiss: (requestId: RuntimeRequestId) => void;
  /**
   * Sends the composer's text and uploaded files as the answer to the active
   * question. It throws the reason it did not, so the draft stays. An earlier
   * question of a card keeps its files' uploads for the answer still to come.
   */
  readonly answerFromDraft: (
    text: string,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ) => Promise<CoordinatorDraftSent>;
}

/** What became of a sent draft's uploads: kept for a later answer, or delivered. */
export interface CoordinatorDraftSent {
  readonly keepUploads: boolean;
}

const isAnswerFile = (attachment: ChatAttachment): attachment is AnswerFile =>
  attachment.type === "image" || attachment.type === "file";

const announceNothing = (_text: string) => {};

export function useCoordinatorQuestion(input: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorId: ThreadId | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly composer: ProjectCoordinatorComposer;
  readonly supportsQuestionAttachments: boolean;
  readonly disabled: boolean;
  readonly composerCanAnswer: boolean;
  /** Shows a reason beside the composer, or clears it with null. */
  readonly reportError: (message: string | null) => void;
  /** Clears the reason beside the composer if it still says this. */
  readonly retireError: (message: string) => void;
  /** Tells a screen reader the answer was sent or the question settled. */
  readonly announce?: ((text: string) => void) | undefined;
}): CoordinatorQuestion | null {
  const { environmentId, coordinatorId, projection, composer, reportError, retireError } = input;
  const announce = input.announce ?? announceNothing;
  const projectionRef = useLatestRef(projection);
  const respondCommand = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissCommand = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const requests = useMemo(
    () =>
      projection === null
        ? []
        : derivePendingUserInputs(derivePendingThreadRequests(projection).userInputs),
    [projection],
  );
  const [answersByRequest, setAnswersByRequest] = useState<Record<string, AnswersByQuestion>>({});
  const [indexByRequest, setIndexByRequest] = useState<Record<string, number>>({});
  // Files a chat reply gave an earlier question of the same card, already uploaded.
  const [filesByRequest, setFilesByRequest] = useState<
    Record<string, Record<string, ReadonlyArray<AnswerFile>>>
  >({});
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);
  const inFlight = useRef(new Set<string>());

  const pendingRequestIds = useMemo(() => requests.map((request) => request.requestId), [requests]);
  const pendingRequestIdsRef = useLatestRef(pendingRequestIds);
  // The settled question's reason this page shows beside the composer, if any.
  const settledReason = useRef<AnswerProblem | null>(null);
  // As in a thread, it goes once a question newer than its send waits: sending
  // the box then would answer that question.
  useEffect(() => {
    const shown = settledReason.current;
    if (shown === null || !isAnswerProblemOutdated(shown, coordinatorId, pendingRequestIds)) return;
    settledReason.current = null;
    retireError(shown.text);
  }, [coordinatorId, pendingRequestIds, retireError]);
  /**
   * Shows a settled question's reason, judged against the requests waiting at
   * the send; false, retiring `earlier`, when a newer question outdates it.
   */
  const showSettled = useCallback(
    (
      threadId: string,
      requestId: string,
      settled: QuestionSendProblem,
      waitingAtSend: ReadonlyArray<string>,
      earlier: string | null,
    ) => {
      const reason = answerProblemFor({
        threadId,
        requestId,
        problem: settled,
        pendingRequestIds: waitingAtSend,
      });
      if (isAnswerProblemOutdated(reason, threadId, pendingRequestIdsRef.current)) {
        if (earlier !== null) retireError(earlier);
        return false;
      }
      settledReason.current = reason;
      reportError(settled.text);
      return true;
    },
    [pendingRequestIdsRef, reportError, retireError],
  );
  const settle = useQuestionSettleAnnouncements(
    projection === null || coordinatorId === null ? null : `${environmentId}:${coordinatorId}`,
    pendingRequestIds,
    announce,
  );
  const active = requests[0] ?? null;
  const activeId = active?.requestId ?? null;
  const storedAnswers = activeId === null ? undefined : answersByRequest[activeId];
  const storedFiles = activeId === null ? undefined : filesByRequest[activeId];
  const answers = useMemo<AnswersByQuestion>(() => {
    if (active === null) return {};
    return Object.fromEntries(
      active.questions.map((question) => {
        const files = storedFiles?.[question.id]?.length ?? 0;
        return [
          question.id,
          { ...storedAnswers?.[question.id], ...(files > 0 ? { attachmentCount: files } : {}) },
        ];
      }),
    );
  }, [active, storedAnswers, storedFiles]);
  const questionIndex = activeId === null ? 0 : (indexByRequest[activeId] ?? 0);
  const progress = useMemo(
    () =>
      active === null
        ? null
        : derivePendingUserInputProgress(active.questions, answers, questionIndex),
    [active, answers, questionIndex],
  );

  const setIndex = useCallback((requestId: string, index: number) => {
    setIndexByRequest((current) => ({ ...current, [requestId]: index }));
  }, []);

  /** Null when the host took the answer; otherwise what to show beside the composer. */
  const respond = useCallback(
    async (
      request: PendingUserInput,
      requestAnswers: Record<string, string | string[]>,
      files: Record<string, ReadonlyArray<AnswerFile>>,
      answeredInChat: boolean,
      // The requests waiting when the person sent it.
      waitingAtSend: ReadonlyArray<string>,
      onLanded?: () => void,
    ): Promise<string | null> => {
      if (coordinatorId === null) return "The coordinator is not loaded yet.";
      if (request.responseCapability === "not_resumable")
        return "This question can no longer be answered: its run ended.";
      if (inFlight.current.has(request.requestId)) return "The answer is still being sent.";
      const attachmentsByQuestionId = Object.fromEntries(
        Object.entries(files).filter(([, list]) => list.length > 0),
      ) as UserInputAttachments;
      inFlight.current.add(request.requestId);
      settle.claim(request.requestId);
      setRespondingRequestIds((current) => [...current, request.requestId]);
      const result = await respondCommand({
        environmentId,
        input: {
          commandId: CommandId.make(
            questionAnswerCommandId({
              requestId: request.requestId,
              answers: requestAnswers,
              attachmentIdsByQuestionId: Object.fromEntries(
                Object.entries(attachmentsByQuestionId).map(([id, list]) => [
                  id,
                  list.map((file) => file.id),
                ]),
              ),
            }),
          ),
          threadId: coordinatorId,
          requestId: request.requestId,
          answers: requestAnswers,
          ...(Object.keys(attachmentsByQuestionId).length > 0 ? { attachmentsByQuestionId } : {}),
          ...(answeredInChat ? { answeredInChat: true } : {}),
        },
      });
      inFlight.current.delete(request.requestId);
      setRespondingRequestIds((current) => current.filter((id) => id !== request.requestId));
      const threadId = coordinatorId;
      // This send's reason beside the composer, once known.
      let shown: string | null = null;
      // Its settled reason was put beside the composer: a settle that later
      // retires it has nothing new to say.
      let saidSettled = false;
      const problem = settleQuestionAnswer({
        result: questionSendResult(result, "The answer was not sent."),
        requestId: request.requestId,
        answers: requestAnswers,
        files: attachmentsByQuestionId,
        heldInBox: answeredInChat,
        runtimeRequests: () => projectionRef.current?.runtimeRequests,
        settle,
        announce,
        onLanded: () => {
          // A send that seemed to fail landed after all: the reply in the box went.
          reportError(null);
          onLanded?.();
        },
        onSettledElsewhere: (settled) => {
          const showing = showSettled(threadId, request.requestId, settled, waitingAtSend, shown);
          shown = showing ? settled.text : null;
          saidSettled ||= showing;
          return saidSettled;
        },
      });
      if (problem === null) return null;
      // A settled reason is already beside the composer, or rightly not: an
      // empty text keeps the reply in the box with nothing more to show.
      if (problem.settled) return shown ?? "";
      shown = problem.text;
      return problem.text;
    },
    [
      announce,
      coordinatorId,
      environmentId,
      projectionRef,
      reportError,
      respondCommand,
      settle,
      showSettled,
    ],
  );

  const toggleOption = useCallback(
    (questionId: string, optionValue: string) => {
      if (active === null) return;
      const question = active.questions.find((entry) => entry.id === questionId);
      if (!question) return;
      // A typed answer gives way to the option, back into the composer, never lost.
      const displaced = answersByRequest[active.requestId]?.[questionId]?.customAnswer;
      composer.setPrompt((prompt) => carryDisplacedCustomAnswerIntoPrompt(prompt, displaced));
      setAnswersByRequest((current) => ({
        ...current,
        [active.requestId]: {
          ...current[active.requestId],
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            current[active.requestId]?.[questionId],
            optionValue,
          ),
        },
      }));
    },
    [active, answersByRequest, composer],
  );

  const advance = useCallback(() => {
    if (active === null || progress === null || !progress.canAdvance) return;
    if (!progress.isLastQuestion) {
      setIndex(active.requestId, progress.questionIndex + 1);
      return;
    }
    const requestAnswers = buildPendingUserInputAnswers(active.questions, answers);
    if (requestAnswers === null) return;
    reportError(null);
    void respond(active, requestAnswers, storedFiles ?? {}, false, pendingRequestIds).then(
      (problem) => {
        if (problem) reportError(problem);
      },
    );
  }, [active, answers, pendingRequestIds, progress, reportError, respond, setIndex, storedFiles]);

  const previous = useCallback(() => {
    if (active === null || progress === null) return;
    setIndex(active.requestId, Math.max(progress.questionIndex - 1, 0));
  }, [active, progress, setIndex]);

  const dismiss = useCallback(
    (requestId: RuntimeRequestId) => {
      if (coordinatorId === null) return;
      const threadId = coordinatorId;
      const waitingAtSend = pendingRequestIds;
      settle.claim(requestId);
      setRespondingRequestIds((current) => [...current, requestId]);
      void dismissCommand({ environmentId, input: { threadId, requestId } }).then((result) => {
        setRespondingRequestIds((current) => current.filter((id) => id !== requestId));
        // As for an answer: a settled reason once shown is not said again.
        let shown: string | null = null;
        let saidSettled = false;
        const problem = settleQuestionDismiss({
          result: questionSendResult(result, "The question was not dismissed."),
          requestId,
          runtimeRequests: () => projectionRef.current?.runtimeRequests,
          settle,
          announce,
          onSettledElsewhere: (settled) => {
            const showing = showSettled(threadId, requestId, settled, waitingAtSend, shown);
            shown = showing ? settled.text : null;
            saidSettled ||= showing;
            return saidSettled;
          },
        });
        if (problem !== null && !problem.settled) reportError(problem.text);
      });
    },
    [
      announce,
      coordinatorId,
      dismissCommand,
      environmentId,
      pendingRequestIds,
      projectionRef,
      reportError,
      settle,
      showSettled,
    ],
  );

  const answerFromDraft = useCallback(
    async (text: string, attachments: ReadonlyArray<ChatAttachment> | undefined) => {
      const question = progress?.activeQuestion;
      if (active === null || progress === null || !question)
        throw new Error(QUESTION_ALREADY_SETTLED);
      const snapshot = composer.getSnapshot();
      const reply = planQuestionChatReply({
        draft: {
          prompt: text,
          images: snapshot.attachments.filter((entry) => entry.type === "image"),
          files: snapshot.attachments.filter((entry) => entry.type === "file"),
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
          threadContexts: [],
        },
        allowCustomAnswer: question.allowCustomAnswer,
        supportsQuestionAttachments: input.supportsQuestionAttachments,
      });
      if (reply.kind === "blocked") throw new Error(reply.reason);
      const files = (attachments ?? []).filter(isAnswerFile);
      if (!progress.isLastQuestion) {
        // Later questions still wait: the reply answers this one and the card moves on.
        setAnswersByRequest((current) => ({
          ...current,
          [active.requestId]: {
            ...current[active.requestId],
            [question.id]: setPendingUserInputCustomAnswer(
              current[active.requestId]?.[question.id],
              reply.kind === "reply" ? reply.text : "",
            ),
          },
        }));
        // A new reply replaces this question's files too, even with none.
        setFilesByRequest((current) => ({
          ...current,
          [active.requestId]: { ...current[active.requestId], [question.id]: files },
        }));
        setIndex(active.requestId, progress.questionIndex + 1);
        return { keepUploads: files.length > 0 };
      }
      const requestAnswers = buildPendingUserInputAnswers(active.questions, {
        ...answers,
        [question.id]: {
          customAnswer: reply.kind === "reply" ? reply.text : "",
          attachmentCount: files.length,
        },
      });
      if (requestAnswers === null)
        throw new Error("Answer each question on the card before sending.");
      const sentFiles = new Set(snapshot.attachments.map((attachment) => attachment.id));
      const problem = await respond(
        active,
        requestAnswers,
        { ...storedFiles, [question.id]: files },
        true,
        pendingRequestIds,
        // The box still holds this reply after a failed send; once it lands, it goes,
        // released as a confirmed send releases it: the host holds its own copy.
        () => {
          composer.clearSentPrompt(snapshot.promptRevision);
          for (const attachment of composer.getSnapshot().attachments) {
            if (!sentFiles.has(attachment.id) || composer.outgoing.has(attachment.id)) continue;
            releaseDraftAttachment(attachment);
            if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
          }
          composer.setAttachments((current) =>
            current.filter((attachment) => !sentFiles.has(attachment.id)),
          );
        },
      );
      if (problem !== null) throw new Error(problem);
      return { keepUploads: false };
    },
    [
      active,
      answers,
      composer,
      input.supportsQuestionAttachments,
      pendingRequestIds,
      progress,
      respond,
      setIndex,
      storedFiles,
    ],
  );

  if (active === null || progress === null) return null;
  return {
    requests,
    active,
    askedBy: COORDINATOR_ASKER,
    answers,
    questionIndex,
    progress,
    respondingRequestIds,
    disabled: input.disabled,
    composerCanAnswer: input.composerCanAnswer,
    toggleOption,
    advance,
    previous,
    dismiss,
    answerFromDraft,
  };
}
