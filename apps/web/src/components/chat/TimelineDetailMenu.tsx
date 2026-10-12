import type { TimelineDetail } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ListCollapseIcon } from "lucide-react";
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  setTimelineDetail,
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

/** Picks how much agent work the thread and coordinator timelines show. */
export function TimelineDetailMenu({
  className,
  appearance = "chat",
}: {
  className?: string;
  /** "project" matches the project workspace header's icon buttons. */
  appearance?: "chat" | "project";
}) {
  const detail = useClientSettings((settings) => settings.timelineDetail);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "timeline.cycleDetail"),
    [keybindings],
  );
  const label = `Timeline detail: ${TIMELINE_DETAIL_LABELS[detail]}`;
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
                    className={cn(
                      "sws-icon-button",
                      detail !== "normal" && "sws-icon-button-on",
                      className,
                    )}
                  />
                ) : (
                  // Away from Normal the trigger names the level, so a thread that
                  // hides thinking or shows every step says why.
                  <Button
                    size={detail === "normal" ? "icon-xs" : "xs"}
                    variant={detail === "normal" ? "ghost-muted" : "secondary"}
                    aria-label={label}
                    data-timeline-detail={detail}
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
          {appearance === "chat" && detail !== "normal" ? (
            <span aria-hidden data-timeline-detail-label>
              {TIMELINE_DETAIL_LABELS[detail]}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label}
          {shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Timeline detail</MenuGroupLabel>
          <MenuRadioGroup
            value={detail}
            onValueChange={(value) => {
              if (isTimelineDetail(value)) setTimelineDetail(value);
            }}
          >
            {TIMELINE_DETAIL_LEVELS.map((level) => (
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
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {shortcutLabel ? (
          <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
            <span>Cycle levels</span>
            <MenuShortcut>{shortcutLabel}</MenuShortcut>
          </div>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
