import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { CheckIcon, ChevronDownIcon, CircleCheckIcon, PencilLineIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
 * The record of an answered question. It rests as one line, a check, how many
 * questions were answered and what was chosen, so a finished decision stops
 * taking space in the thread; a click shows each question and its choice.
 */
export function DecisionCard(props: {
  readonly item: AnsweredQuestionItem;
  readonly renderText?: ((text: string) => ReactNode) | undefined;
  readonly defaultExpanded?: boolean | undefined;
}) {
  const { item } = props;
  const decision = useMemo(
    () => deriveDecision(item.questions, item.questionAnswer),
    [item.questionAnswer, item.questions],
  );
  const answeredAt = item.completedAt ?? item.updatedAt;
  const answeredDate = new Date(DateTime.toEpochMillis(answeredAt));
  const byAgent = item.questionAnswer.answeredByThreadId !== undefined;
  const chooser = byAgent ? "An agent" : "You";
  const when = formatDecisionTime(answeredDate);
  const renderText = props.renderText ?? ((text: string) => text);
  const chosen = decision.flatMap((question) => question.choices.map((choice) => choice.label));

  return (
    <Collapsible defaultOpen={props.defaultExpanded ?? false}>
      <section
        data-decision-card={item.requestId}
        aria-label="Decision"
        className="rounded-xl border border-border/80 bg-card/40"
      >
        <CollapsibleTrigger
          data-decision-toggle
          className="group/decision flex w-full min-w-0 items-center gap-2 rounded-xl px-4 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
        >
          <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-success-foreground" />
          {/* A narrow panel puts the choices on a second line under the status. */}
          <span className="@container min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-x-2 gap-y-0.5 @max-[26rem]:flex-wrap">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                Decision
                {decision.length > 1 ? (
                  <span className="@max-[26rem]:hidden">{` · ${decision.length} answered`}</span>
                ) : null}
              </span>
              <span
                data-decision-summary
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground group-data-panel-open/decision:invisible @max-[26rem]:order-last @max-[26rem]:basis-full @max-[26rem]:group-data-panel-open/decision:hidden"
              >
                {chosen.join(", ")}
              </span>
              <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                {byAgent
                  ? "Answered by an agent"
                  : item.questionAnswer.answeredInChat
                    ? "Answered in chat"
                    : "Sent to the agent"}{" "}
                · <time dateTime={answeredDate.toISOString()}>{when}</time>
              </span>
            </span>
          </span>
          <ChevronDownIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open/decision:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-2.5 px-4 pb-3">
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
                      : "chose"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}

export type { AnsweredQuestionItem };
