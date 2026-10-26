import type { ClientSettings, TimelineDetail } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect } from "react";

import { toastManager } from "./components/ui/toast";
import {
  getClientSettings,
  persistClientSettingsPatch,
  useClientSettings,
} from "./hooks/useSettings";
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
  concise: "Results only",
  normal: "Folded steps",
  verbose: "Everything",
};

export const TIMELINE_DETAIL_DESCRIPTIONS: Record<TimelineDetail, string> = {
  concise: "Hide thinking and in-between messages; one line per finished turn",
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
      title: `Show: ${TIMELINE_DETAIL_LABELS[detail]}`,
      timeout: 1500,
    });
  }
}

/** Threads with their own level that are remembered; the oldest choice is dropped first. */
export const MAX_THREAD_TIMELINE_DETAILS = 300;

type DetailSettings = Pick<ClientSettings, "timelineDetail" | "threadTimelineDetail">;

/** The thread's own level when it has one, otherwise the default for every thread. */
export function resolveTimelineDetail(
  settings: DetailSettings,
  threadKey: string | null | undefined,
): TimelineDetail {
  return (
    (threadKey ? settings.threadTimelineDetail[threadKey] : undefined) ?? settings.timelineDetail
  );
}

export function threadHasOwnTimelineDetail(
  settings: DetailSettings,
  threadKey: string | null | undefined,
): boolean {
  return threadKey ? settings.threadTimelineDetail[threadKey] !== undefined : false;
}

/** The thread overrides with `detail` set, or without it for null; newest last. */
export function nextThreadTimelineDetails(
  current: Readonly<Record<string, TimelineDetail>>,
  threadKey: string,
  detail: TimelineDetail | null,
): Record<string, TimelineDetail> {
  const next: Record<string, TimelineDetail> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key !== threadKey) next[key] = value;
  }
  if (detail !== null) next[threadKey] = detail;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_THREAD_TIMELINE_DETAILS))) {
    delete next[key];
  }
  return next;
}

/** Gives one thread its own level, or null to follow the default again. */
export function setThreadTimelineDetail(threadKey: string, detail: TimelineDetail | null) {
  const threadTimelineDetail = nextThreadTimelineDetails(
    getClientSettings().threadTimelineDetail,
    threadKey,
    detail,
  );
  void persistClientSettingsPatch({ threadTimelineDetail }).catch(() => {
    toastManager.add({
      type: "error",
      title: "Couldn't save timeline detail",
      description: "Try again.",
    });
  });
}

/** The level a thread's timeline shows; re-renders when either setting changes. */
export function useTimelineDetail(threadKey: string | null | undefined): TimelineDetail {
  return useClientSettings((settings) => resolveTimelineDetail(settings, threadKey));
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
