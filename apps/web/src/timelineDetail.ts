import type { TimelineDetail } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect } from "react";

import { toastManager } from "./components/ui/toast";
import { getClientSettings, persistClientSettingsPatch } from "./hooks/useSettings";
import { resolveShortcutCommand } from "./keybindings";
import { isTerminalFocused } from "./lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "./state/server";

export type { TimelineDetail };

/** Display order, also the order the shortcut cycles through. */
export const TIMELINE_DETAIL_LEVELS: ReadonlyArray<TimelineDetail> = [
  "concise",
  "normal",
  "verbose",
];

export const TIMELINE_DETAIL_LABELS: Record<TimelineDetail, string> = {
  concise: "Concise",
  normal: "Normal",
  verbose: "Verbose",
};

export const TIMELINE_DETAIL_DESCRIPTIONS: Record<TimelineDetail, string> = {
  concise: "Hide thinking and in-between messages; one summary per turn",
  normal: "Fold finished turns and tool groups",
  verbose: "Open every turn, tool call and thought",
};

export function nextTimelineDetail(current: TimelineDetail): TimelineDetail {
  const index = TIMELINE_DETAIL_LEVELS.indexOf(current);
  return TIMELINE_DETAIL_LEVELS[(index + 1) % TIMELINE_DETAIL_LEVELS.length]!;
}

export function setTimelineDetail(detail: TimelineDetail, options: { announce?: boolean } = {}) {
  void persistClientSettingsPatch({ timelineDetail: detail }).catch(() => {
    toastManager.add({
      type: "error",
      title: "Couldn't save timeline detail",
      description: "Try again.",
    });
  });
  if (options.announce) {
    toastManager.add({
      id: "timeline-detail-cycle",
      title: `Timeline detail: ${TIMELINE_DETAIL_LABELS[detail]}`,
      timeout: 1500,
    });
  }
}

/** Moves to the next level and announces it, for the keyboard shortcut. */
export function useCycleTimelineDetail() {
  return useCallback(() => {
    setTimelineDetail(nextTimelineDetail(getClientSettings().timelineDetail), {
      announce: true,
    });
  }, []);
}

/**
 * Listens for `timeline.cycleDetail` anywhere in the app. Mounted once, with
 * the command palette at the root, so every page shares one handler.
 */
export function useTimelineDetailShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const cycle = useCycleTimelineDetail();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "timeline.cycleDetail") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) cycle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle, keybindings]);
}
