import type { TimelineDetail } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ListCollapseIcon } from "lucide-react";
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  resolveTimelineDetail,
  setThreadTimelineDetail,
  setTimelineDetail,
  threadHasOwnTimelineDetail,
  TIMELINE_DETAIL_DESCRIPTIONS,
  TIMELINE_DETAIL_LABELS,
  TIMELINE_DETAIL_LEVELS,
} from "~/timelineDetail";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function isTimelineDetail(value: unknown): value is TimelineDetail {
  return TIMELINE_DETAIL_LEVELS.includes(value as TimelineDetail);
}

/** The "This thread" choice that follows the default for every thread. */
const FOLLOW_DEFAULT = "default";

/**
 * Picks how much agent work a thread's timeline shows: its own level, or the
 * default every other thread follows. The trigger always names the level.
 */
export function TimelineDetailMenu({
  className,
  appearance = "chat",
  threadKey = null,
}: {
  className?: string;
  /** "project" matches the project workspace header's icon buttons. */
  appearance?: "chat" | "project";
  /** `environmentId:threadId` of the thread this header belongs to. */
  threadKey?: string | null;
}) {
  const defaultDetail = useClientSettings((settings) => settings.timelineDetail);
  const detail = useClientSettings((settings) => resolveTimelineDetail(settings, threadKey));
  const ownLevel = useClientSettings((settings) => threadHasOwnTimelineDetail(settings, threadKey));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "timeline.cycleDetail"),
    [keybindings],
  );
  const label = `Timeline detail: ${TIMELINE_DETAIL_LABELS[detail]}${
    ownLevel ? " (this thread)" : ""
  }`;
  const levelItem = (level: TimelineDetail) => (
    <MenuRadioItem key={level} value={level} closeOnClick>
      <span className="flex items-start gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
          <MenuRadioItemIndicator />
        </span>
        <span className="flex min-w-0 flex-col">
          <span>{TIMELINE_DETAIL_LABELS[level]}</span>
          <span className="text-muted-foreground text-xs">
            {TIMELINE_DETAIL_DESCRIPTIONS[level]}
          </span>
        </span>
      </span>
    </MenuRadioItem>
  );
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                appearance === "project" ? (
                  <button
                    type="button"
                    aria-label={label}
                    data-timeline-detail={detail}
                    data-timeline-detail-own={ownLevel || undefined}
                    className={cn("sws-icon-button", ownLevel && "sws-icon-button-on", className)}
                    style={{ width: "auto", paddingInline: 6, gap: 4 }}
                  />
                ) : (
                  <Button
                    size="xs"
                    variant={ownLevel ? "secondary" : "ghost-muted"}
                    aria-label={label}
                    data-timeline-detail={detail}
                    data-timeline-detail-own={ownLevel || undefined}
                    className={cn("shrink-0", className)}
                  />
                )
              }
            />
          }
        >
          <ListCollapseIcon
            aria-hidden
            className={appearance === "chat" ? "size-3.5" : undefined}
          />
          <span aria-hidden data-timeline-detail-label className="text-xs">
            {TIMELINE_DETAIL_LABELS[detail]}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label}
          {shortcutLabel ? ` (${shortcutLabel} cycles the default)` : ""}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-64">
        {threadKey ? (
          <MenuGroup>
            <MenuGroupLabel>This thread</MenuGroupLabel>
            <MenuRadioGroup
              value={ownLevel ? detail : FOLLOW_DEFAULT}
              onValueChange={(value) => {
                if (value === FOLLOW_DEFAULT) setThreadTimelineDetail(threadKey, null);
                else if (isTimelineDetail(value)) setThreadTimelineDetail(threadKey, value);
              }}
            >
              <MenuRadioItem value={FOLLOW_DEFAULT} closeOnClick>
                <span className="flex items-start gap-2">
                  <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                    <MenuRadioItemIndicator />
                  </span>
                  <span>Use default ({TIMELINE_DETAIL_LABELS[defaultDetail]})</span>
                </span>
              </MenuRadioItem>
              {TIMELINE_DETAIL_LEVELS.map(levelItem)}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>
            {threadKey ? "Default for all threads" : "Timeline detail"}
          </MenuGroupLabel>
          <MenuRadioGroup
            value={defaultDetail}
            onValueChange={(value) => {
              if (isTimelineDetail(value)) setTimelineDetail(value);
            }}
          >
            {TIMELINE_DETAIL_LEVELS.map(levelItem)}
          </MenuRadioGroup>
        </MenuGroup>
        {shortcutLabel ? (
          <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
            <span>Cycle the default</span>
            <MenuShortcut>{shortcutLabel}</MenuShortcut>
          </div>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
