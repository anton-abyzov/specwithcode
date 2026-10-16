import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { CheckIcon, PencilLineIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { deriveDecision } from "./questionCard.logic";

type AnsweredQuestionItem = Extract<OrchestrationV2TurnItem, { type: "user_input_request" }> & {
  readonly questionAnswer: NonNullable<
    Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>["questionAnswer"]
  >;
};

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Today: the time. This week: the weekday. Older: the month and day. */
export function formatDecisionTime(date: Date, now: Date = new Date()): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (dayDiff <= 0) return timeFormatter.format(date);
  if (dayDiff < 7) return weekdayFormatter.format(date);
  return monthDayFormatter.format(date);
}

/**
 * The compact record of an answered question: what was asked, the lettered
 * choice that was picked, who picked it and when.
 */
export function DecisionCard(props: {
  readonly item: AnsweredQuestionItem;
  readonly renderText?: ((text: string) => ReactNode) | undefined;
}) {
  const { item } = props;
  const decision = useMemo(
    () => deriveDecision(item.questions, item.questionAnswer),
    [item.questionAnswer, item.questions],
  );
  const answeredAt = item.completedAt ?? item.updatedAt;
  const answeredDate = new Date(DateTime.toEpochMillis(answeredAt));
  const chooser = item.questionAnswer.answeredByThreadId === undefined ? "You" : "An agent";
  const when = formatDecisionTime(answeredDate);
  const renderText = props.renderText ?? ((text: string) => text);

  return (
    <section
      data-decision-card={item.requestId}
      aria-label="Decision"
      className="rounded-xl border border-border/80 bg-card/40 px-4 py-3"
    >
      <h3 className="text-xs font-medium text-muted-foreground">Decision</h3>
      <div className="mt-1 space-y-2.5">
        {decision.map((question) => (
          <div key={question.id} className="min-w-0">
            {question.question ? (
              <div className="text-sm text-foreground">{renderText(question.question)}</div>
            ) : null}
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {question.choices.map((choice) => (
                <span
                  key={`${choice.letter ?? "text"}:${choice.label}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-xs font-medium",
                      choice.letter === null
                        ? "bg-muted text-muted-foreground"
                        : "bg-success/14 text-success-foreground",
                    )}
                  >
                    {choice.letter === null ? (
                      <PencilLineIcon className="size-3" />
                    ) : (
                      <>
                        <CheckIcon className="size-3" />
                        {choice.letter}
                      </>
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 text-sm text-foreground",
                      choice.letter === null ? "whitespace-pre-wrap" : "font-semibold",
                    )}
                  >
                    {choice.label}
                  </span>
                </span>
              ))}
              <span className="text-xs text-muted-foreground">
                {chooser}{" "}
                {question.choices.length > 0 &&
                question.choices.every((choice) => choice.letter === null)
                  ? "replied"
                  : "chose"}{" "}
                · <time dateTime={answeredDate.toISOString()}>{when}</time>
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export type { AnsweredQuestionItem };
