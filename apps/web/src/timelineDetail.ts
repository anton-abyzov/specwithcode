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
  concise: "Hide thinking, tool runs and in-between messages; one line per turn, opened on click",
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
      title: "Couldn't save what threads show",
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
      title: "Couldn't save what this thread shows",
      description: "Try again.",
    });
  });
}

/** The level a thread's timeline shows; re-renders when either setting changes. */
export function useTimelineDetail(threadKey: string | null | undefined): TimelineDetail {
  return useClientSettings((settings) => resolveTimelineDetail(settings, threadKey));
}

/** Threads whose header is on screen, by the header that registered them. */
const shownThreads = new Map<symbol, string>();

/**
 * Marks a thread as on screen while its header is mounted, so the shortcut
 * knows which conversations the person is looking at.
 */
export function useShownTimelineThread(threadKey: string | null | undefined) {
  useEffect(() => {
    if (!threadKey) return;
    const token = Symbol(threadKey);
    shownThreads.set(token, threadKey);
    return () => {
      shownThreads.delete(token);
    };
  }, [threadKey]);
}

export interface TimelineDetailCycle {
  /** The new default for every thread, when a thread on screen follows it. */
  readonly timelineDetail?: TimelineDetail;
  /** The new per-thread levels, when a thread on screen has its own. */
  readonly threadTimelineDetail?: Record<string, TimelineDetail>;
  /** What the toast says changed. */
  readonly title: string;
}

/**
 * One press of the shortcut: every conversation on screen moves to its next
 * level. A thread with its own level moves that level; the others move the
 * default for every thread, which also moves with no thread on screen.
 */
export function planTimelineDetailCycle(
  settings: DetailSettings,
  shownThreadKeys: Iterable<string>,
): TimelineDetailCycle {
  const shown = [...new Set(shownThreadKeys)];
  const own = shown.filter((key) => threadHasOwnTimelineDetail(settings, key));
  const cyclesDefault = own.length < shown.length || shown.length === 0;
  let threadTimelineDetail: Record<string, TimelineDetail> | undefined;
  const ownLabels: string[] = [];
  for (const key of own) {
    const next = nextTimelineDetail(settings.threadTimelineDetail[key]!);
    threadTimelineDetail = nextThreadTimelineDetails(
      threadTimelineDetail ?? settings.threadTimelineDetail,
      key,
      next,
    );
    if (!ownLabels.includes(TIMELINE_DETAIL_LABELS[next])) {
      ownLabels.push(TIMELINE_DETAIL_LABELS[next]);
    }
  }
  const nextDefault = cyclesDefault ? nextTimelineDetail(settings.timelineDetail) : undefined;
  const ownTitle = ownLabels.length > 0 ? `this thread: ${ownLabels.join(", ")}` : null;
  const title =
    nextDefault === undefined
      ? `Show in ${ownTitle}`
      : ownTitle === null
        ? `Show: ${TIMELINE_DETAIL_LABELS[nextDefault]}`
        : `Show: ${TIMELINE_DETAIL_LABELS[nextDefault]} · ${ownTitle}`;
  return {
    ...(nextDefault === undefined ? {} : { timelineDetail: nextDefault }),
    ...(threadTimelineDetail === undefined ? {} : { threadTimelineDetail }),
    title,
  };
}

/** Moves the conversations on screen to their next level and announces it, for the keyboard shortcut. */
export function useCycleTimelineDetail() {
  return useCallback(() => {
    const { title, ...patch } = planTimelineDetailCycle(getClientSettings(), shownThreads.values());
    void persistClientSettingsPatch(patch).catch(() => {
      toastManager.add({
        type: "error",
        title: "Couldn't save what threads show",
        description: "Try again.",
      });
    });
    toastManager.add({ id: "timeline-detail-cycle", title, timeout: 1500 });
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
