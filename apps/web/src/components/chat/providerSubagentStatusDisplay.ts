import {
  formatProviderSubagentStatus,
  providerSubagentWorkActive,
  type ProviderSubagentStatus,
} from "@specweave-studio/client-runtime/state/thread-execution";

/** Which glyph the subagent bar shows beside its status. */
export type ProviderSubagentStatusTone =
  | "starting"
  | "idle"
  | "live"
  | "done"
  | "failed"
  | "stopped"
  | "unknown";

export function providerSubagentStatusTone(
  status: ProviderSubagentStatus | null,
): ProviderSubagentStatusTone {
  if (status === null) return "starting";
  if (providerSubagentWorkActive(status)) return "live";
  switch (status.status) {
    case "unknown":
      return "unknown";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    default:
      return "stopped";
  }
}

const COMPLETED_IN = "Completed in ";

/**
 * The bar's status in few characters: "Done 34s" for "Completed in 34s".
 * The full wording stays in the screen-reader announcement.
 */
export function formatProviderSubagentShortStatus(
  status: ProviderSubagentStatus | null,
  nowMs: number,
): string {
  const full = formatProviderSubagentStatus(status, nowMs);
  if (full.startsWith(COMPLETED_IN)) return `Done ${full.slice(COMPLETED_IN.length)}`;
  return full === "Completed" ? "Done" : full;
}
