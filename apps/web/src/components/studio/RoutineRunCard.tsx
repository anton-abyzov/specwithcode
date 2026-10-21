import type { EnvironmentId, ScheduledTaskId } from "@specweave-studio/contracts";
import { ChevronRightIcon, CircleCheckIcon, CodeIcon, TableIcon, TimerIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useConversationFindQueryWithin } from "../find/conversationFindStore";

import type { RoutineRunMessage, RoutineTrigger } from "../../studio/routineRunMessage";
import { routinePromptPreview } from "../../studio/routineRunMessage";
import { ScheduledTaskLink } from "../settings/ScheduledTaskLink";
import { JsonDataView } from "../chat/StructuredBlocks";
import { parseJsonData } from "../chat/structuredBlocks.logic";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MessageCopyButton } from "../chat/MessageCopyButton";

const TRIGGER_LABEL: Record<RoutineTrigger, string> = {
  scheduled: "Scheduled",
  manual: "Run now",
  webhook: "Webhook",
};

/** Plain output taller than this folds behind "Show all". */
const OUTPUT_PREVIEW_LINES = 12;

function CheckOutput({ output, truncated }: { output: string; truncated: boolean }) {
  const data = useMemo(() => (truncated ? null : parseJsonData(output)), [output, truncated]);
  const [raw, setRaw] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (output.length === 0) {
    return <p className="text-xs text-muted-foreground">The check printed nothing.</p>;
  }
  const lines = output.split("\n");
  const folded = data === null && !expanded && lines.length > OUTPUT_PREVIEW_LINES;
  const toggleLabel = raw ? "Show formatted" : "Show raw";
  return (
    <div className="relative" data-routine-check-output="">
      {data !== null && !raw ? (
        <JsonDataView data={data} />
      ) : (
        <pre className="max-h-96 overflow-auto rounded-md bg-secondary px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words dark:bg-input/32">
          {folded ? lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n") : output}
          {truncated ? "\n…" : ""}
        </pre>
      )}
      {folded || truncated ? (
        <div className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
          {folded ? (
            <Button type="button" variant="ghost-muted" size="xs" onClick={() => setExpanded(true)}>
              Show all {lines.length} lines
            </Button>
          ) : null}
          {truncated ? <span>Output was cut at 4,000 characters.</span> : null}
        </div>
      ) : null}
      <span className="absolute -top-8 right-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/check:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        {data !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  onClick={() => setRaw((value) => !value)}
                  aria-label={toggleLabel}
                />
              }
            >
              {raw ? <TableIcon className="size-3" /> : <CodeIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
        <MessageCopyButton text={output} variant="ghost" size="icon-xs" />
      </span>
    </div>
  );
}

/**
 * A fired routine in the conversation: which routine, how it fired and when, the check
 * it passed with its output laid out, and its instructions folded to one line.
 */
export function RoutineRunCard({
  run,
  environmentId,
  taskId,
  cadence,
  time,
  fullText,
  renderMarkdown,
}: {
  readonly run: RoutineRunMessage;
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId;
  /** The routine's schedule in words, when the routine is still there. */
  readonly cadence: string | null;
  readonly time: ReactNode;
  /** The message exactly as the agent received it, for copying. */
  readonly fullText: string;
  readonly renderMarkdown: (text: string) => ReactNode;
}) {
  const title = run.title ?? "Routine";
  const trigger =
    run.trigger === "scheduled" && cadence !== null
      ? cadence
      : run.trigger !== null
        ? TRIGGER_LABEL[run.trigger]
        : cadence;
  const preview = routinePromptPreview(run.prompt);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  // Find in the conversation reaches the instructions only while they are mounted.
  const findQuery = useConversationFindQueryWithin(section).toLowerCase();
  const findInInstructions =
    findQuery.length > 0 &&
    [run.where, run.brief, run.prompt].some((part) => part?.toLowerCase().includes(findQuery));
  return (
    <section
      ref={setSection}
      className="rounded-xl border border-border/80 bg-card/40 text-sm"
      aria-label={`Routine ${title}`}
      data-routine-run-card={taskId}
    >
      <header className="flex items-center gap-2 px-3.5 pt-2.5 pb-2">
        <TimerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <ScheduledTaskLink
          environmentId={environmentId}
          taskId={taskId}
          className="min-w-0 truncate font-medium text-foreground hover:underline"
        >
          {title}
        </ScheduledTaskLink>
        {trigger ? (
          <span
            className="shrink-0 rounded-full bg-secondary px-2 py-px text-2xs text-muted-foreground"
            data-routine-trigger={run.trigger ?? ""}
          >
            {trigger}
          </span>
        ) : null}
        <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">{time}</span>
      </header>
      {run.check !== null ? (
        <div className="group/check border-t border-border/60 px-3.5 py-2.5" data-routine-check="">
          <p className="mb-2 flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
            <CircleCheckIcon className="size-3.5 shrink-0 text-success-foreground" aria-hidden />
            <span className="shrink-0">Check passed</span>
            <code className="min-w-0 rounded bg-secondary px-1.5 py-px font-mono text-2xs break-all text-foreground">
              {run.check.command}
            </code>
          </p>
          <CheckOutput output={run.check.output} truncated={run.check.truncated} />
        </div>
      ) : null}
      <Collapsible open={instructionsOpen || findInInstructions} onOpenChange={setInstructionsOpen}>
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-2 border-t border-border/60 px-3.5 py-2 text-left text-xs text-muted-foreground hover:text-foreground data-panel-open:[&>svg]:rotate-90"
          data-routine-instructions-toggle=""
        >
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform" aria-hidden />
          <span className="shrink-0 font-medium">Instructions</span>
          <span className="min-w-0 truncate">{preview}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="border-t border-border/60 px-3.5 py-2.5" data-routine-instructions="">
            {run.where ? <p className="mb-2 text-xs text-muted-foreground">{run.where}</p> : null}
            {run.brief ? (
              <div className="mb-2 text-xs text-muted-foreground" data-routine-brief="">
                {renderMarkdown(run.brief)}
              </div>
            ) : null}
            {renderMarkdown(run.prompt)}
            <div className="mt-1 flex justify-end">
              <MessageCopyButton text={fullText} variant="ghost" size="icon-xs" />
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
