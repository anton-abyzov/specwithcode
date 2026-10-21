import type { EnvironmentId, ScheduledTaskId, ScopedThreadRef } from "@specweave-studio/contracts";
import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import { useMemo } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { RoutineRunCard } from "../studio/RoutineRunCard";
import { parseRoutineRunMessage } from "../../studio/routineRunMessage";
import { useKnownRoutines } from "../../studio/useKnownRoutines";
import { formatDayAwareTimestamp } from "../../timestampFormat";

/** A fired routine's message in a thread, as the same card the coordinator shows. */
export function ThreadRoutineRun({
  message,
  taskId,
  environmentId,
  timestampFormat,
  cwd,
  threadRef,
}: {
  readonly message: { readonly id: string; readonly text: string; readonly createdAt: string };
  readonly taskId: ScheduledTaskId;
  readonly environmentId: EnvironmentId;
  readonly timestampFormat: TimestampFormat;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const routines = useKnownRoutines(environmentId, true);
  const known = routines.get(taskId);
  const run = useMemo(() => parseRoutineRunMessage(message, known), [message, known]);
  return (
    <RoutineRunCard
      run={run}
      environmentId={environmentId}
      taskId={taskId}
      cadence={known?.cadence ?? null}
      fullText={message.text}
      time={
        <time dateTime={message.createdAt}>
          {formatDayAwareTimestamp(message.createdAt, timestampFormat)}
        </time>
      }
      renderMarkdown={(part) => (
        <ChatMarkdown
          text={part}
          cwd={cwd}
          {...(threadRef ? { threadRef } : {})}
          isStreaming={false}
          lineBreaks
          parseRawHtml={false}
        />
      )}
    />
  );
}
