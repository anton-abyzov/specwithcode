import type {
  BackgroundWorkKind,
  PendingBackgroundWorkPresentation,
} from "@specweave-studio/client-runtime/state/thread-execution";

import type { AppSymbolName } from "../../components/AppSymbol";

export const STOP_BACKGROUND_WORK_LABEL = "Stop background work";
export const STOPPING_BACKGROUND_WORK_LABEL = "Stopping background work";

/** The same kinds the web strip draws: agent, workflow, terminal, activity, hourglass. */
export const BACKGROUND_WORK_SYMBOLS: Record<BackgroundWorkKind, AppSymbolName> = {
  subagent: "person.2",
  workflow: "point.3.connected.trianglepath.dotted",
  command: "terminal",
  monitor: "waveform.path.ecg",
  background_task: "hourglass",
};

export interface BackgroundWorkStop {
  readonly stopping: boolean;
  readonly onStop: () => void;
}

/** The floating pill while a settled thread still runs background work. */
export interface BackgroundFloatingStatus {
  readonly kind: "background";
  /** The kind that leads the roster; picks the icon. */
  readonly workKind: BackgroundWorkKind;
  /** One line: the only item cut to the command it runs, or the counts. */
  readonly label: string;
  /** A named shell command, shown in monospace. */
  readonly code: boolean;
  /** The untruncated work for screen readers: "Running: ID=$(gh run list …)". */
  readonly accessibilityLabel: string;
  /**
   * What a long press shows and copies: the full command, or one line per piece of work.
   * Null for one piece of work with no name ("Running a command"): there is nothing more
   * to show, so the pill offers no long press.
   */
  readonly details: string | null;
  readonly detailsTitle: string;
  /** Null when this device may not operate the thread. */
  readonly stop: BackgroundWorkStop | null;
}

export function backgroundFloatingStatus(
  presentation: PendingBackgroundWorkPresentation,
  stop: BackgroundWorkStop | null,
): BackgroundFloatingStatus {
  const [only] = presentation.items;
  const single = presentation.items.length === 1 && only !== undefined ? only : null;
  return {
    kind: "background",
    workKind: presentation.kind,
    label: presentation.shortLabel,
    code: single !== null && single.kind === "command" && single.named,
    accessibilityLabel:
      single === null ? `${presentation.title}: ${presentation.fullLabel}` : presentation.title,
    details:
      single === null
        ? presentation.items.map((item) => item.label).join("\n")
        : presentation.named
          ? presentation.fullLabel
          : null,
    detailsTitle: presentation.waiting ? "Waiting on background work" : "Running in the background",
    stop,
  };
}
