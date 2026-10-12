import type { EnvironmentConnectionPhase } from "@specweave-studio/client-runtime/connection";
import type { BackgroundFloatingStatus } from "./background-work-status";

/**
 * What the floating pill says. Connection, syncing, and working share one
 * element so the label swaps in place instead of one pill fading out for
 * another. The connection variant is tappable and triggers a reconnect.
 */
export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  // The turn settled while background work it started still runs.
  | BackgroundFloatingStatus
  // A native /goal on an idle thread: paused, blocked, complete, or set.
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  // A task whose thread the server has not created yet: the worktree may
  // still be checking out, so there is no turn to time.
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

/**
 * The pill's connection variant, or null once the environment is connected and
 * the pill is free to report sync and working state instead.
 */
export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable("You are offline");
    case "unsupported":
      return unavailable("Client not supported");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}

/**
 * The status row's React key. A new key mounts a fresh row that cross-fades in, so it
 * changes only when the pill should read as a different status. The timer, compaction
 * and background work keep their row while their text updates: background work carries
 * a stop button and a long press, and a workflow's label changes on every progress tick.
 */
export function floatingStatusLabelKey(status: FloatingWorkingStatus): string {
  switch (status.kind) {
    case "working":
    case "compacting":
    case "background":
      return status.kind;
    default:
      return `${status.kind}:${status.label}`;
  }
}

/** True when the status row holds its own touch targets, so the capsule must pass touches. */
export function floatingStatusInteractive(status: FloatingWorkingStatus | null): boolean {
  return status?.kind === "connection" || status?.kind === "background";
}
