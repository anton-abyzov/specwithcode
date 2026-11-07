import type { ServerSettings, WorktreeSubmodules } from "@specweave-studio/contracts";

import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { THREAD_FINISH_ACTION_LABELS } from "./threadFinishAction";

const WRITING_STYLE_LABELS: Record<string, string> = {
  repo_conventions: "Repository conventions",
  conventional_commits: "Conventional Commits",
  custom: "Custom instructions",
};

const WORKTREE_LOCATION_LABELS: Record<string, string> = {
  managed: "App-managed",
  project: "Inside project",
  custom: "Custom folder",
};

/** Enum values shared by several keys (runtime modes, limit actions, streaming). */
const VALUE_LABELS: Readonly<Record<string, string>> = {
  "approval-required": "Ask for approval",
  "auto-accept-edits": "Accept edits",
  auto: "Automatic",
  "full-access": "Full access",
  ask: "Ask",
  wait: "Wait",
  switch: "Switch",
  "on-request": "On request",
  automatic: "Automatic",
  disabled: "Off",
  concise: "Concise",
  detailed: "Detailed",
  turn: "Per turn",
  paragraph: "Per paragraph",
  "top-level": "Top level",
  recursive: "Recursive",
  none: "None",
  "same-machine-first": "This machine",
  "other-machine-first": "Other machines",
};

/** Names a list item (a provider instance ID, say); undefined falls back to the raw text. */
export type SettingValueNamer = (item: string) => string | undefined;

function listItemLabel(item: unknown, name: SettingValueNamer | undefined): string {
  if (typeof item === "string") return name?.(item) ?? item;
  if (typeof item === "object" && item !== null && "model" in item) {
    return typeof item.model === "string" ? item.model : "Custom";
  }
  return typeof item === "number" ? String(item) : "Custom";
}

/** Up to two names, then "+N": "Devin, Copilot +1". */
function formatList(values: readonly unknown[], name: SettingValueNamer | undefined): string {
  if (values.length === 0) return "None";
  const shown = values.slice(0, 2).map((item) => listItemLabel(item, name));
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

/**
 * A short label for one setting's value, as people read it: "Open PR and
 * auto-merge", not `auto_merge`. Never shows a raw enum or JSON.
 */
export function formatSettingValueFor(
  key: keyof ServerSettings,
  value: unknown,
  name?: SettingValueNamer,
): string {
  if (value === null || value === undefined) {
    return key === "pullRequestMergeMethod"
      ? "Last selected"
      : key === "sidebarAutoSettleAfterDays"
        ? "Never"
        : key === "defaultModelSelection"
          ? "Automatic"
          : key === "sourceControlWriterModelSelection"
            ? "Text generation model"
            : key === "defaultThreadEnvMode" || key === "worktreeSubmodules"
              ? "Inherit"
              : "Not set";
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    return key === "sidebarAutoSettleAfterDays"
      ? `${value} ${value === 1 ? "day" : "days"}`
      : key === "providerLimitSwitchAtPercent"
        ? `${value}%`
        : key === "providerLimitWaitUnderMinutes"
          ? `${value} min`
          : String(value);
  }
  if (typeof value === "string") {
    if (key === "defaultThreadEnvMode" && (value === "local" || value === "worktree")) {
      return resolveEnvModeLabel(value);
    }
    if (key === "worktreeSubmodules" && value in WORKTREE_SUBMODULES_LABELS) {
      return WORKTREE_SUBMODULES_LABELS[value as WorktreeSubmodules];
    }
    if (key === "worktreeLocationMode") return WORKTREE_LOCATION_LABELS[value] ?? value;
    if (key === "threadFinishAction" && value in THREAD_FINISH_ACTION_LABELS) {
      return THREAD_FINISH_ACTION_LABELS[value as keyof typeof THREAD_FINISH_ACTION_LABELS];
    }
    if (key === "pullRequestMergeMethod" && value in PULL_REQUEST_MERGE_METHOD_LABELS) {
      return PULL_REQUEST_MERGE_METHOD_LABELS[
        value as keyof typeof PULL_REQUEST_MERGE_METHOD_LABELS
      ];
    }
    if (value === "") return "Empty";
    const label = VALUE_LABELS[value];
    if (label) return label;
    return value.length > 40 ? `${value.slice(0, 39)}…` : value;
  }
  if (Array.isArray(value)) return formatList(value, name);
  if (typeof value === "object") {
    if ("model" in value && typeof value.model === "string") return value.model;
    if ("mode" in value && typeof value.mode === "string") {
      return WRITING_STYLE_LABELS[value.mode] ?? VALUE_LABELS[value.mode] ?? value.mode;
    }
  }
  return "Custom";
}
