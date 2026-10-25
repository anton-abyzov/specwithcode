import type { EnvironmentId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useMemo, type ReactNode } from "react";

import { useThreadShell } from "../../state/entities";
import { questionAskerLabel, type AnsweredQuestion } from "../../studio/coordinatorQuestionAnswers";
import { useProjectMessageRouting } from "../../studio/projectMessageRouting";
import { DecisionCard } from "./DecisionCard";

/** A decision in a thread's timeline, naming the agent that asked: the coordinator or the thread. */
export function ThreadDecisionCard(props: {
  readonly item: AnsweredQuestion;
  readonly environmentId: EnvironmentId;
  readonly renderText?: ((text: string) => ReactNode) | undefined;
}) {
  const { item, environmentId } = props;
  const ref = useMemo(
    () => scopeThreadRef(environmentId, item.threadId),
    [environmentId, item.threadId],
  );
  const shell = useThreadShell(ref);
  const routing = useProjectMessageRouting();
  return (
    <DecisionCard
      item={item}
      renderText={props.renderText}
      askedBy={questionAskerLabel({
        threadId: item.threadId,
        title: shell?.title,
        isCoordinator: routing?.coordinatorThreadId === item.threadId,
      })}
    />
  );
}
