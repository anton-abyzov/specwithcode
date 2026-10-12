import type {
  BackgroundWorkKind,
  PendingBackgroundWorkItem,
  PendingBackgroundWorkPresentation,
} from "@specweave-studio/client-runtime/state/thread-execution";
import type { ThreadId } from "@specweave-studio/contracts";
import {
  ActivityIcon,
  BotIcon,
  HourglassIcon,
  SquareIcon,
  SquareTerminalIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const KIND_ICONS: Record<BackgroundWorkKind, LucideIcon> = {
  subagent: BotIcon,
  workflow: WorkflowIcon,
  command: SquareTerminalIcon,
  monitor: ActivityIcon,
  background_task: HourglassIcon,
};

export const STOP_BACKGROUND_WORK_LABEL = "Stop background work";
export const STOPPING_BACKGROUND_WORK_LABEL = "Stopping background work";

/**
 * The kind of work that leads the strip. It pulses when `running` is set; the strip
 * sets it only for work that will wake the agent, and list rows stay still.
 */
export function BackgroundWorkIcon({
  kind,
  running,
  className,
}: {
  readonly kind: BackgroundWorkKind;
  readonly running: boolean;
  readonly className?: string;
}) {
  const Icon = KIND_ICONS[kind];
  return (
    <Icon
      aria-hidden="true"
      data-background-work-kind={kind}
      className={cn("text-foreground", running && "animate-status-pulse", className)}
    />
  );
}

/** Shell commands read as code; names and phrases ("Running a command") do not. */
const looksLikeCode = (item: PendingBackgroundWorkItem) => item.kind === "command" && item.named;

/** One line per piece of work, with subagents opening their own thread. */
function BackgroundWorkList({
  items,
  onOpenRelatedThread,
}: {
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  readonly onOpenRelatedThread: (threadId: ThreadId) => void;
}) {
  return (
    <ul className="space-y-1" aria-label="Background work">
      {items.map((item) => {
        const childThreadId = item.childThreadId;
        return (
          <li key={item.taskId} className="flex min-w-0 items-start gap-1.5">
            <BackgroundWorkIcon
              kind={item.kind}
              running={false}
              className="mt-0.5 size-3 flex-none"
            />
            {childThreadId === undefined ? (
              <span className={cn("min-w-0", looksLikeCode(item) && "font-mono")}>
                {item.label}
              </span>
            ) : (
              <InlineButton
                aria-label={`Open subagent ${item.label}`}
                className="min-w-0 shrink"
                onClick={() => onOpenRelatedThread(childThreadId)}
              >
                {item.label}
              </InlineButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The strip's text: the only piece of work in short form (a shell command in
 * monospace, cut to the command it runs), or compact counts for several. The full
 * text is in a tooltip, which keyboard focus opens too, and in the accessible name.
 * Work with no name reads as a plain phrase ("Running a command") with no tooltip.
 */
export function BackgroundWorkLabel({
  presentation,
  onOpenRelatedThread,
}: {
  readonly presentation: PendingBackgroundWorkPresentation;
  readonly onOpenRelatedThread: (threadId: ThreadId) => void;
}) {
  const [only] = presentation.items;
  const single = presentation.items.length === 1 && only !== undefined ? only : null;
  const accessibleLabel =
    single === null ? `${presentation.title}: ${presentation.fullLabel}` : presentation.title;
  const shortText = (
    <span
      className={cn(
        "min-w-0 truncate",
        single !== null && looksLikeCode(single) ? "font-mono font-normal text-xs" : "font-medium",
      )}
    >
      {presentation.shortLabel}
    </span>
  );

  if (single === null) {
    return (
      <span
        role="group"
        aria-label={accessibleLabel}
        className="flex min-w-0 items-center"
        data-background-work-strip="summary"
      >
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <InlineButton
                aria-label={`Show background work: ${presentation.countSummary ?? presentation.shortLabel}`}
                className="min-w-0 shrink"
              />
            }
          >
            {shortText}
          </PopoverTrigger>
          <PopoverPopup
            aria-label="Background work"
            tooltipStyle
            side="top"
            className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere [--inline-button-text-align:start] [--inline-button-white-space:normal] [&_[data-slot=inline-button]]:max-w-full"
          >
            <BackgroundWorkList
              items={presentation.items}
              onOpenRelatedThread={onOpenRelatedThread}
            />
          </PopoverPopup>
        </Popover>
      </span>
    );
  }

  if (!presentation.named) {
    return (
      <span
        role="group"
        aria-label={accessibleLabel}
        className="flex min-w-0 items-center"
        data-background-work-strip="single"
      >
        {shortText}
      </span>
    );
  }

  const childThreadId = single.childThreadId;
  const trigger =
    childThreadId === undefined ? (
      // Focusable so a keyboard reaches the tooltip with the untruncated command.
      <span
        tabIndex={0}
        className="flex min-w-0 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
    ) : (
      <InlineButton
        aria-label={`Open subagent ${single.label}`}
        className="min-w-0 shrink"
        onClick={() => onOpenRelatedThread(childThreadId)}
      />
    );
  return (
    <span
      role="group"
      aria-label={accessibleLabel}
      className="flex min-w-0 items-center"
      data-background-work-strip="single"
    >
      <Tooltip>
        <TooltipTrigger render={trigger}>{shortText}</TooltipTrigger>
        <TooltipPopup variant={looksLikeCode(single) ? "code" : "default"}>
          {presentation.fullLabel}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}

/**
 * Stops every piece of background work on the thread. It stays hoverable when it
 * cannot act (aria-disabled, not disabled) so its tooltip still names it.
 */
export function BackgroundWorkStopButton({
  stopping,
  disabled,
  onStop,
}: {
  readonly stopping: boolean;
  readonly disabled: boolean;
  readonly onStop: () => void;
}) {
  const label = stopping ? STOPPING_BACKGROUND_WORK_LABEL : STOP_BACKGROUND_WORK_LABEL;
  const inert = disabled || stopping;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            aria-busy={stopping || undefined}
            aria-disabled={inert || undefined}
            onClick={inert ? undefined : onStop}
          />
        }
      >
        {stopping ? (
          <Spinner aria-hidden="true" />
        ) : (
          <SquareIcon aria-hidden="true" className="fill-current" />
        )}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
