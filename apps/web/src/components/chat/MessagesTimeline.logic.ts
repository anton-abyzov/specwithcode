import {
  isSettledRunStatus,
  worktreeSetupAgentStarted,
} from "@specweave-studio/client-runtime/worktree-setup";
export { worktreeSetupAgentStarted } from "@specweave-studio/client-runtime/worktree-setup";
import * as Equal from "effect/Equal";
import { shallow } from "zustand/vanilla/shallow";
import { renderCodexDirectivesForCopy } from "@specweave-studio/client-runtime/codex-markdown-directives";
import {
  commandDisplayText,
  commandProgramName,
} from "@specweave-studio/client-runtime/work-log/command-label";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  summarizeToolGroupChips,
  toolGroupAction,
  toolGroupSummaryKind,
  turnDiffState,
  turnDiffStateMessage,
  workEntryFailureKind,
  type ToolGroupSummaryKind,
  type WorkEntryFailureKind,
} from "@specweave-studio/client-runtime/work-log/presentation";
export {
  normalizeCompactToolLabel,
  toolGroupAction,
} from "@specweave-studio/client-runtime/work-log/presentation";
import {
  deriveRevertTurnCountByUserMessageId,
  formatDuration,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import {
  type MessageId,
  type WorktreeSetupSnapshot,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  RunId,
  type ThreadId,
  type TimelineDetail,
} from "@specweave-studio/contracts";
import type { ThreadRunSummary } from "@specweave-studio/client-runtime/state/shell";
import {
  resolveStudioMcpToolDefinition,
  resolveStudioMcpToolPresentation,
  type StudioMcpToolPresentation,
} from "@specweave-studio/shared/studioMcpToolPresentation";
import { compactDynamicToolOutput } from "@specweave-studio/shared/toolOutput";
import { asksForReport } from "@specweave-studio/shared/threadReport";
import {
  htmlRenderReferencesEqual,
  type HtmlRenderReference,
} from "@specweave-studio/shared/htmlRender";
import { dynamicToolTitle } from "@specweave-studio/shared/toolActivity";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@specweave-studio/shared/toolActivity";
import { isWindowsAbsolutePath } from "@specweave-studio/shared/path";

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.runId;
  }
  if (entry.kind === "html-render") return entry.runId;
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

/** Whether the entry still represents live activity, not a settled result. */
export function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

function singleToolCallLabel(entry: WorkLogEntry): string {
  if (entry.itemType === "reasoning") return entry.detail?.trim().replace(/\s+/g, " ") || "Thought";
  const toolPresentation = resolveWorkEntryToolPresentation(entry, "completed");
  if (toolPresentation) return toolPresentation.displayName;
  const item = entry.structuredPayload;
  const title = item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input) : null;
  if (title) return title;
  // A lone web search keeps its heading; the query stays in its detail.
  if (entry.itemType === "web_search") return entry.toolTitle ?? "Web search";
  return workEntryDisplayLabel(entry, undefined);
}

function workEntryToolDataRecord(entry: WorkLogEntry): Record<string, unknown> | undefined {
  return entry.toolData !== null &&
    typeof entry.toolData === "object" &&
    !Array.isArray(entry.toolData)
    ? (entry.toolData as Record<string, unknown>)
    : undefined;
}

function workEntryReadRawPaths(entry: WorkLogEntry): readonly string[] {
  const fromChanged = entry.changedFiles ?? [];
  if (fromChanged.length > 0) return fromChanged;
  const structured = entry.structuredPayload;
  if (structured?.type === "dynamic_tool") {
    const structuredPaths = collectToolFilePaths({ input: structured.input });
    if (structuredPaths.length > 0) return structuredPaths;
  }
  return collectToolFilePaths(workEntryToolDataRecord(entry));
}

function workEntryReadPaths(entry: WorkLogEntry, workspaceRoot: string | undefined): string[] {
  return workEntryReadRawPaths(entry).map((filePath) =>
    formatWorkspaceRelativePath(filePath, workspaceRoot),
  );
}

export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot: string | undefined) {
  if (entry.itemType === "system_notice") return entry.label;
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    const thought = entry.detail?.trim().replace(/\s+/g, " ");
    return thought || entry.label;
  }
  const toolPresentation = resolveWorkEntryToolPresentation(entry);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command?.trim()) return commandDisplayText(entry.command);
  const action = toolGroupAction(entry);
  if (action === "code-search" || action === "search") {
    // Adapters title file searches with their target; the item keeps only the pattern.
    const searchLabel =
      entry.itemType === "file_search"
        ? entry.label
        : formatSearchToolLabel(workEntryToolDataRecord(entry));
    if (searchLabel) return searchLabel;
  }
  const readPaths = action === "read" ? workEntryReadPaths(entry, workspaceRoot) : [];
  if (action === "read" && readPaths[0]) {
    return formatReadToolLabel(readPaths[0], readPaths.length - 1);
  }
  // Retrying providers keep their progress label; other diagnostics expose
  // the retained message instead of a generic error heading. File bodies
  // are never a compact read label.
  const providerRetry =
    entry.projectedItem?.item.type === "error" && entry.projectedItem.item.retry !== undefined;
  const item = entry.structuredPayload;
  const title = item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input) : null;
  if (title) return title;
  const compactDetail = entry.detail?.trim();
  const detailIsSearchOutput =
    (action === "code-search" || action === "search") && /[\r\n]/.test(compactDetail ?? "");
  if (compactDetail && !providerRetry && action !== "read" && !detailIsSearchOutput) {
    return compactDetail;
  }
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : `${path} +${entry.changedFiles!.length - 1} more`;
  }
  if (action === "read" && !entry.viewedImagePath) {
    return "Read file";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

/** A tool's path in full: relative paths are resolved against the workspace root. */
function workspaceAbsolutePath(path: string, workspaceRoot: string | undefined): string {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (!workspaceRoot || trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
    return trimmed;
  }
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const relative = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
  return `${root}/${relative}`;
}

/** Inspectable read-file output is the path when we have one, otherwise nothing. */
export function workEntryReadOutput(
  entry: Pick<
    WorkLogEntry,
    "changedFiles" | "detail" | "viewedImagePath" | "structuredPayload" | "toolData"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const paths = [
    ...new Set(
      workEntryReadRawPaths(entry as WorkLogEntry)
        .map((path) => workspaceAbsolutePath(path, workspaceRoot))
        .filter((path) => path.length > 0),
    ),
  ];
  if (paths.length > 0) {
    return paths.join("\n");
  }
  return null;
}

/** A read or edit row's label: the verb, the first path, "+N more" and the edit's +/- counts. */
export interface WorkEntryPathLabel {
  readonly verb: string;
  /** Workspace-relative, or absolute when the file lies outside the workspace. */
  readonly path: string;
  /** Every path the row names, exactly as the provider sent it (relative ones joined to the root). */
  readonly fullPaths: ReadonlyArray<string>;
  readonly moreCount: number;
  /** Omitted when the provider sent no counts and none could be computed, never 0 for unknown. */
  readonly additions?: number;
  readonly deletions?: number;
}

/**
 * The path as the provider sent it, joined to the root when relative. Spaces, a no-break space
 * included, are part of a name, so a path that starts with one is relative and is never trimmed.
 */
function exactFullPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot || path.startsWith("/") || isWindowsAbsolutePath(path)) return path;
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${separator}${path.replace(/^(?:\.[\\/])+/, "").replace(/^[\\/]+/, "")}`;
}

function fileChangeVerb(
  change: { readonly operation: string; readonly oldPath?: string | undefined } | undefined,
  inProgress: boolean,
): string {
  const operation = change?.operation.toLowerCase() ?? "";
  const [past, present] =
    change?.oldPath !== undefined || operation === "move" || operation === "rename"
      ? ["Moved", "Moving"]
      : operation === "add" || operation === "create" || operation === "created"
        ? ["Created", "Creating"]
        : operation === "delete" || operation === "remove" || operation === "deleted"
          ? ["Deleted", "Deleting"]
          : ["Edited", "Editing"];
  return inProgress ? present : past;
}

function fileChangeCounts(
  item: Extract<OrchestrationV2TurnItem, { type: "file_change" }>,
): Pick<WorkEntryPathLabel, "additions" | "deletions"> {
  if (item.additions !== undefined && item.deletions !== undefined) {
    return { additions: item.additions, deletions: item.deletions };
  }
  const counted = (item.changes ?? []).flatMap((change) =>
    change.additions !== undefined && change.deletions !== undefined
      ? [{ additions: change.additions, deletions: change.deletions }]
      : [],
  );
  if (counted.length === 0) return {};
  return {
    additions: counted.reduce((sum, change) => sum + change.additions, 0),
    deletions: counted.reduce((sum, change) => sum + change.deletions, 0),
  };
}

/**
 * The path a lone Read or edit row shows instead of a generic heading (AC-01, AC-03), or null
 * when the row is not a plain read or edit with a path. Named tool presentations and
 * commands keep their own labels.
 */
export function workEntryPathLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
): WorkEntryPathLabel | null {
  if (entry.itemType === "reasoning" || entry.command?.trim()) return null;
  if (resolveWorkEntryToolPresentation(entry)) return null;
  const inProgress = entry.toolLifecycleStatus === "inProgress";
  const action = toolGroupAction(entry);
  if (action === "read") {
    const paths = [...new Set(workEntryReadRawPaths(entry))].filter((path) => path.trim());
    const [first] = paths;
    if (first === undefined) return null;
    return {
      verb: inProgress ? "Reading" : "Read",
      path: formatWorkspaceRelativePath(first, workspaceRoot),
      fullPaths: paths.map((path) => exactFullPath(path, workspaceRoot)),
      moreCount: paths.length - 1,
    };
  }
  if (action !== "edit" || entry.itemType !== "file_change") return null;
  const item = entry.projectedItem?.item ?? entry.structuredPayload;
  const fileChange = item?.type === "file_change" ? item : undefined;
  const paths = [...new Set(entry.changedFiles ?? [])].filter((path) => path.trim());
  const [first] = paths;
  if (first === undefined) return null;
  const changes = fileChange?.changes ?? [];
  return {
    verb: fileChangeVerb(changes.length === 1 ? changes[0] : undefined, inProgress),
    path: formatWorkspaceRelativePath(first, workspaceRoot),
    fullPaths: paths.map((path) => exactFullPath(path, workspaceRoot)),
    moreCount: paths.length - 1,
    ...(fileChange ? fileChangeCounts(fileChange) : {}),
  };
}

export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  active: boolean,
) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  if (entry.itemType === "reasoning") {
    return (
      entry.detail?.trim().replace(/\s+/g, " ") ||
      (status === "inProgress" ? "Thinking" : "Thought")
    );
  }
  const toolPresentation = resolveWorkEntryToolPresentation({
    ...entry,
    toolLifecycleStatus: status,
  });
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) {
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${commandProgramName(command) ?? "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    // A stopped call is an outcome ("Stopped sleep"), not an empty row.
    entry.toolLifecycleStatus === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}

// Entries are immutable, and folds, headers and rows ask the same entry on every update.
const failureKindByEntry = new WeakMap<WorkLogEntry, WorkEntryFailureKind | null>();

/** How an entry ended, for its chip and the failure counts (AC-10). */
export function timelineEntryFailureKind(entry: WorkLogEntry): WorkEntryFailureKind | null {
  const cached = failureKindByEntry.get(entry);
  if (cached !== undefined) return cached;
  const kind = workEntryFailureKind(entry);
  failureKindByEntry.set(entry, kind);
  return kind;
}

/** Failed, possibly failed or declined: the entries a fold must not hide silently. */
function workEntryShowsFailureSignal(entry: WorkLogEntry): boolean {
  const kind = timelineEntryFailureKind(entry);
  return kind !== null && kind !== "stopped";
}

export interface ToolFailureCounts {
  /** Failed by status, a nonzero exit code or a provider error; shown at full strength. */
  readonly failedCount: number;
  /** Flagged only by the output heuristic; shown faint and never added to failedCount. */
  readonly possibleFailureCount: number;
  readonly declinedCount: number;
}

export const NO_TOOL_FAILURES: ToolFailureCounts = {
  failedCount: 0,
  possibleFailureCount: 0,
  declinedCount: 0,
};

/** The three counts summarizeToolGroup reports, over every entry, without building its sentence. */
export function toolFailureCounts(entries: ReadonlyArray<WorkLogEntry>): ToolFailureCounts {
  let failedCount = 0;
  let possibleFailureCount = 0;
  let declinedCount = 0;
  for (const entry of entries) {
    if (entry.itemType === "reasoning") continue;
    const kind = timelineEntryFailureKind(entry);
    if (kind === "failed") failedCount += 1;
    else if (kind === "possible") possibleFailureCount += 1;
    else if (kind === "declined") declinedCount += 1;
  }
  return failedCount === 0 && possibleFailureCount === 0 && declinedCount === 0
    ? NO_TOOL_FAILURES
    : { failedCount, possibleFailureCount, declinedCount };
}

/** "2 failed", "1 possible failure", "3 declined", in that order; empty counts are left out. */
export function toolFailureCountLabels(counts: ToolFailureCounts): {
  readonly failed: string | null;
  readonly faint: ReadonlyArray<string>;
} {
  const faint: string[] = [];
  if (counts.possibleFailureCount > 0) {
    faint.push(
      `${counts.possibleFailureCount} possible ${counts.possibleFailureCount === 1 ? "failure" : "failures"}`,
    );
  }
  if (counts.declinedCount > 0) faint.push(`${counts.declinedCount} declined`);
  return { failed: counts.failedCount > 0 ? `${counts.failedCount} failed` : null, faint };
}

/** The chip a settled row keeps at every detail level: "exit 2", "failed", "declined" or "stopped". */
export function workEntryOutcomeChip(
  entry: WorkLogEntry,
): { readonly kind: "failed" | "declined" | "stopped"; readonly label: string } | null {
  const kind = timelineEntryFailureKind(entry);
  if (kind === "failed") {
    const item = entry.projectedItem?.item ?? entry.structuredPayload;
    const exitCode = item?.type === "command_execution" ? item.exitCode : undefined;
    return {
      kind,
      label: exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : "failed",
    };
  }
  if (kind === "declined" || kind === "stopped") return { kind, label: kind };
  return null;
}

/**
 * Why a row's Open diff is disabled, or null when it opens the panel (AC-05). Rows disable it
 * only while the run is live, which the run's status alone decides; every other state opens
 * the panel, which explains itself.
 */
export function turnDiffUnavailableReason(
  runId: RunId | null,
  runs: ReadonlyArray<{ readonly id: RunId; readonly status?: string | undefined }>,
): string | null {
  if (runId === null) return null;
  const run = runs.find((candidate) => candidate.id === runId);
  if (run?.status === undefined) return null;
  const state = turnDiffState({
    runId,
    runs: [{ id: run.id, status: run.status }],
    checkpoints: [],
  });
  return state.kind === "running" ? turnDiffStateMessage(state) : null;
}

const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

/** Restore a visible tool, including a position partway through its expanded output. */
export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

/** Only newly appended calls may follow the end, never status or output updates. */
export function shouldFollowWorkGroupAppend(
  previous: ReadonlyArray<{ readonly id: string }>,
  entries: ReadonlyArray<{ readonly id: string }>,
  distanceFromEnd: number,
): boolean {
  return (
    previous.length > 0 &&
    entries.length > previous.length &&
    distanceFromEnd <= 1 &&
    previous.every((entry, index) => entry.id === entries[index]?.id)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * The follow re-arm band (#5566): strict isAtEnd flickers false for a frame
 * while streaming content grows under the viewport, so follow re-arms within
 * this distance of the real content bottom instead.
 */
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the composer inset spacer, but the composer hides
  // the same amount of viewport, so the inset cancels: plain
  // contentLength - scroll - scrollLength is the gap between the last real row
  // and the visible edge above the composer. LegendList's own isAtEnd subtracts
  // the inset and is true anywhere in the bottom composer-height band, so it is
  // only a fallback here, never a short-circuit.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly itemBounds: ReadonlyArray<{
    readonly top: number | null;
    readonly height: number | null;
  }>;
}): number | null {
  let precedingIndex: number | null = null;

  for (const [index, item] of input.itemBounds.entries()) {
    if (item.top === null) {
      continue;
    }
    const inView =
      item.top < input.scrollBottom && item.top + Math.max(1, item.height ?? 1) > input.scrollTop;
    if (inView) {
      // The first visible marker is the turn at the reader's current position.
      return index;
    }
    if (item.top <= input.scrollTop) {
      precedingIndex = index;
    }
  }

  return precedingIndex;
}

/**
 * Side gutter between the viewport edge and the centered content column.
 * `contentWidth` is the rendered column width, which follows the Chat width
 * setting, so callers measure it rather than assume a fixed maximum.
 */
function resolveTimelineSideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) {
    return 0;
  }
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom, a
 * narrow pane, or a wider Chat width setting. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

// The prev/next buttons are centered 4px into the strip and 20px wide, so
// their hitbox reaches 14px past the strip's left edge.
const TIMELINE_MINIMAP_NAVIGATION_REACH = 14;

/**
 * The prev/next buttons hang outside the strip's height, so the strip's own
 * width cap does not cover them. Keep them inert to the pointer unless the
 * gutter can hold them; keyboard focus still reaches them.
 */
export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow = MessagesTimelineRowContent & {
  readonly continuesWorkLog?: boolean;
  /** Shown inside an open "Used N tools" summary. */
  readonly withinToolActivity?: boolean;
};

export interface ToolActivityCategory {
  kind: ToolGroupSummaryKind;
  label: string;
}

/** A provider-native subagent a run launched, as its parent's timeline names it. */
export interface TurnSubagentReference {
  readonly title: string;
  readonly childThreadId: ThreadId | null;
}

type MessagesTimelineRowContent =
  | {
      kind: "worktree-setup";
      id: string;
      createdAt: string | null;
      snapshot: WorktreeSetupSnapshot;
      embedded: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
      /** Tool calls this row stands in for after the latest one failed. */
      groupId?: string;
      groupCount?: number;
      expanded?: boolean;
    }
  | ({
      kind: "work-toggle";
      id: string;
      createdAt: string;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      /** Tool calls the header opens; narration in the group is not counted. */
      toolCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      toolSurface?: WorkLogEntry["toolSurface"];
      toolIcon?: WorkLogEntry["toolIcon"];
      summaryToolIcon?: "browser" | "device" | "studio-code" | "pull-request";
      /** The group's final call failed; the counts cover every call. */
      hasFailure: boolean;
    } & ToolFailureCounts)
  | ({
      /** Folds a stretch of tool groups and the short narration between them. */
      kind: "tool-activity";
      id: string;
      createdAt: string;
      groupId: string;
      expanded: boolean;
      toolCount: number;
      noteCount: number;
      /** Narration the closed summary hides, so a citation can open it. */
      noteMessageIds: string[];
      categories: ToolActivityCategory[];
    } & ToolFailureCounts)
  | ({
      kind: "turn-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      /** Concise only: what the folded work did, as short counts: "88 commands · 94 thread updates". */
      activitySummary?: string;
      /** Concise only: the whole sentence the short label stands for, for its tooltip. */
      activityDetail?: string;
      expanded: boolean;
    } & ToolFailureCounts)
  | {
      /** Closes an expanded "Worked for …" fold, so a long turn folds again from its end. */
      kind: "turn-fold-end";
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      /** The row after the fold, kept in place when it folds; null at the end of the list. */
      anchorRowId: string | null;
    }
  | {
      kind: "attempt-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      attemptId: RunAttemptId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      active: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      /** The run's edit items, so the changed-files card can tell who reported each file. */
      turnEditItems?: ReadonlyArray<OrchestrationV2TurnItem> | undefined;
      /** The run's provider-native subagents, whose edits the card lists under their name. */
      turnSubagents?: ReadonlyArray<TurnSubagentReference> | undefined;
      /** Failed entries of the run, for the Concise card line. */
      turnFailedCount?: number | undefined;
      revertTurnCount?: number | undefined;
      /** An assistant reply to a message that asked for a report or a document. */
      reportRequested?: true;
    }
  | {
      kind: "assistant-meta";
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: string;
      projectedItem: OrchestrationV2ProjectedTurnItem;
      subagents?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      resourceSummary?: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

export type TimelineToolPresentation = StudioMcpToolPresentation;
export const resolveTimelineToolPresentation = resolveStudioMcpToolPresentation;

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: WorkLogEntry[],
): Extract<MessagesTimelineRow, { kind: "work" }> {
  return {
    kind: "work",
    id: `${groupId}:details`,
    createdAt,
    groupedEntries,
    isExpandedToolGroup: true,
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.runId
      ? `turn:${message.runId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  /** The turn's final assistant message, which stays visible below the fold. */
  terminalEntryId: string | null;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
  activitySummary?: string;
  activityDetail?: string;
  /** Over every folded entry, at every detail level, so no failure folds away unseen (AC-10). */
  failures: ToolFailureCounts;
}

/**
 * The expanded-id sets record what the user toggled. Verbose starts every
 * disclosure open, so a toggled id there means the user closed it.
 */
function isDisclosed<T>(
  toggled: ReadonlySet<T> | undefined,
  id: T,
  detail: TimelineDetail,
): boolean {
  const wasToggled = toggled?.has(id) ?? false;
  return detail === "verbose" ? !wasToggled : wasToggled;
}

/**
 * Concise hides thinking everywhere and, in the response still running, every
 * assistant message but the latest. That message moves up to where the
 * response's current segment starts, so the work around it sits together and
 * folds into one live row below it. Settled turns keep their messages: their
 * fold already hides them, and failed or interrupted turns stay readable.
 * Earlier turns are never touched, even when runless work cannot tell them
 * apart from the running one, and a superseded attempt keeps its own fold.
 */
function applyConciseDetail(
  entries: ReadonlyArray<TimelineEntry>,
  runIsActive: (runId: RunId | null | undefined) => boolean,
): ReadonlyArray<TimelineEntry> {
  const withoutThinking = entries.filter(
    (entry) => !(entry.kind === "work" && entry.entry.itemType === "reasoning"),
  );
  const isUserMessage = (entry: TimelineEntry) =>
    entry.kind === "message" && entry.message.role === "user";
  // The running response starts after the person's last prompt; a steer is part of it.
  const turnStartIndex = withoutThinking.findLastIndex(
    (entry) =>
      entry.kind === "message" &&
      entry.message.role === "user" &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer",
  );
  const isCurrent = (entry: TimelineEntry, index: number) =>
    index > turnStartIndex && entry.attempt?.status !== "superseded";
  const isActiveAssistantMessage = (entry: TimelineEntry, index: number) =>
    isCurrent(entry, index) &&
    entry.kind === "message" &&
    entry.message.role === "assistant" &&
    runIsActive(entry.message.runId);
  const latestIndex = withoutThinking.findLastIndex(isActiveAssistantMessage);
  if (latestIndex < 0) return withoutThinking;
  const latest = withoutThinking[latestIndex]!;
  // Never move a reply above the user message (or steer) that prompted it.
  const lastUserIndex = withoutThinking.findLastIndex(isUserMessage);
  let anchorIndex = withoutThinking.findIndex(
    (entry, index) =>
      index > lastUserIndex &&
      (isActiveAssistantMessage(entry, index) ||
        (isCurrent(entry, index) &&
          entry.kind === "work" &&
          entry.entry.itemType !== "system_notice" &&
          entry.entry.itemType !== "notification" &&
          runIsActive(entry.entry.runId))),
  );
  if (anchorIndex < 0 || anchorIndex > latestIndex) anchorIndex = latestIndex;
  const result: TimelineEntry[] = [];
  for (const [index, entry] of withoutThinking.entries()) {
    if (index === anchorIndex) result.push(latest);
    if (isActiveAssistantMessage(entry, index)) continue;
    result.push(entry);
  }
  return result;
}

interface SupersededAttemptFold {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

/**
 * Groups only provider output owned by an explicitly superseded V2 attempt.
 * User messages remain visible because they are inputs to the logical run,
 * including the steer message that started the replacement attempt.
 */
function deriveSupersededAttemptFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unfoldedRunIds: ReadonlySet<RunId>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const entriesByAttemptId = new Map<RunAttemptId, TimelineEntry[]>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      unfoldedRunIds.has(entry.attempt.runId) ||
      (entry.kind === "message" && entry.message.role === "user") ||
      // A published page stays visible, as it does when its turn folds.
      entry.kind === "html-render" ||
      timelineEntryIsPersistentResourceCard(entry) ||
      (entry.kind === "work" && entry.entry.itemType === "system_notice")
    ) {
      continue;
    }
    const entries = entriesByAttemptId.get(entry.attempt.id) ?? [];
    entries.push(entry);
    entriesByAttemptId.set(entry.attempt.id, entries);
  }

  const foldsByAnchorEntryId = new Map<string, SupersededAttemptFold>();
  for (const entries of entriesByAttemptId.values()) {
    const firstEntry = entries[0];
    const attempt = firstEntry?.attempt;
    if (firstEntry === undefined || attempt === undefined) continue;
    foldsByAnchorEntryId.set(firstEntry.id, {
      runId: attempt.runId,
      attemptId: attempt.id,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(entries.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * The latest turn counts as unsettled while it is still running (or has not
 * recorded a completion). This is deliberately keyed on the turn's own
 * lifecycle rather than transient working state: right after the user sends
 * a message, the previous turn is still the "active" one until the server
 * creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledRunId(
  latestRun: TimelineLatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled =
    latestRun.completedAt !== null &&
    latestRun.status !== "running" &&
    latestRun.status !== "starting" &&
    latestRun.status !== "waiting";
  return isSettled ? null : latestRun.runId;
}

/** `runlessKey` stands in for the run of entries that have none. */
function timelineEntryFoldRunId(entry: TimelineEntry, runlessKey: RunId | null): RunId | null {
  if (entry.kind === "work" && entry.entry.itemType === "system_notice") return null;
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? runlessKey;
  }
  if (entry.kind === "work") {
    return entry.entry.runId ?? runlessKey;
  }
  if (
    entry.kind === "event" &&
    (timelineEntryIsPersistentResourceCard(entry) || entry.projectedItem.item.type === "subagent")
  ) {
    return entry.projectedItem.item.runId ?? runlessKey;
  }
  return null;
}

/** A steer adds input to its existing turn, without creating a new header. */
function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" &&
      entry.message.role === "user" &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer") ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

/**
 * A promptless provider restart replaces the native turn without adding a
 * user message. Keep every provider turn since the initiating prompt in one
 * visual response until the replacement turn settles. Steers keep that
 * boundary; an automatic wake starts a new response with its notification.
 */
function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}

function deriveActiveVisualResponseRunIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  unsettledRunId: RunId | null;
  isWorking: boolean;
}): ReadonlySet<RunId> {
  const runIds = new Set<RunId>();
  if (input.unsettledRunId === null) {
    return runIds;
  }

  runIds.add(input.unsettledRunId);
  if (!input.isWorking) {
    return runIds;
  }

  const latestResponseBoundaryIndex = lastResponseBoundaryIndex(input.timelineEntries);
  for (
    let index = latestResponseBoundaryIndex + 1;
    index < input.timelineEntries.length;
    index += 1
  ) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function timelineEntryFailedItem(entry: TimelineEntry) {
  const item =
    entry.kind === "event"
      ? entry.projectedItem.item
      : entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : null;
  return item?.type === "error" && item.status === "failed" && item.parentItemId === null
    ? item
    : null;
}

function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

/**
 * Settled turns fold activity before their terminal assistant message behind
 * a "Worked for ..." row. Ordinary trailing work joins the fold, while failures
 * and work still in progress stay visible. A prompt without a run (a
 * provider-native subagent, or a turn imported from V1) folds its response
 * the same way.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestRun: TimelineLatestRun | null;
  unfoldedRunIds: ReadonlySet<RunId>;
  /** Keeps the latest runless response open; V2 work must not reopen imported turns. */
  runlessWorkActive: boolean;
  /** Concise detail: summarise the folded work as short counts beside the duration. */
  includeActivitySummary?: boolean;
}): ReadonlyMap<string, TurnFold> {
  const interruptedRunIds = new Set<RunId>();
  for (const entry of input.timelineEntries) {
    if (
      entry.kind === "event" &&
      entry.projectedItem.item.runId !== null &&
      (entry.projectedItem.item.type === "run_interrupt_request" ||
        entry.projectedItem.item.type === "run_interrupt_result")
    ) {
      interruptedRunIds.add(entry.projectedItem.item.runId);
    }
  }

  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message or notification that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
    anchorEntryId: string;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();
  const runlessFailedKeys = new Set<RunId>();

  // Fold state is keyed by run, so each runless prompt lends its response a
  // stable key of its own. Decide per prompt, not per thread: a V1 thread's
  // first V2 run must not unfold every imported turn above it.
  let runlessKey: RunId | null = null;
  let pendingBoundary: { createdAt: string; anchorEntryId: string } | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const nextEntry = input.timelineEntries[index + 1];
      pendingBoundary = nextEntry
        ? { createdAt: entry.createdAt, anchorEntryId: nextEntry.id }
        : null;
      const boundaryRunId =
        entry.kind === "message"
          ? entry.message.runId
          : entry.kind === "work"
            ? entry.entry.runId
            : null;
      runlessKey = boundaryRunId == null ? RunId.make(`runless:${entry.id}`) : null;
      continue;
    }
    const runId = timelineEntryFoldRunId(entry, runlessKey);
    if (!runId) {
      continue;
    }
    if (runId === runlessKey && timelineEntryFailedItem(entry) !== null) {
      runlessFailedKeys.add(runId);
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingBoundary?.createdAt ?? null,
        anchorEntryId: pendingBoundary?.anchorEntryId ?? entry.id,
      };
      pendingBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      input.unfoldedRunIds.has(runId) ||
      interruptedRunIds.has(runId) ||
      runlessFailedKeys.has(runId) ||
      (input.runlessWorkActive && runId === runlessKey)
    ) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction =
        entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
      const isFoldableTrailingActivity =
        entry.kind === "work" &&
        entry.entry.toolLifecycleStatus !== "inProgress" &&
        !workEntryShowsFailureSignal(entry.entry);
      if (!isCompaction && index > terminalEntryIndex && !isFoldableTrailingActivity) {
        continue;
      }
      // Linked resources can outlive their launching run and stay visible
      // after the surrounding work folds.
      if (timelineEntryIsPersistentResourceCard(entry)) {
        continue;
      }
      if (entry.kind === "work" && entry.entry.itemType === "notification") continue;
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction row stays visible on its own; it only folds away as
    // part of a turn that already folds other work.
    const hidesNonCompactionWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction"),
    );
    if (!hidesNonCompactionWork) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestRun?.runId === runId && input.latestRun.status === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestRun?.runId === runId && input.latestRun.startedAt && input.latestRun.completedAt
        ? computeElapsedMs(input.latestRun.startedAt, input.latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";
    const failures = toolFailureCounts(
      group.entries.flatMap((entry) =>
        entry.kind === "work" && hiddenEntryIds.has(entry.id) ? [entry.entry] : [],
      ),
    );
    const foldedTools = input.includeActivitySummary
      ? group.entries.flatMap((entry) =>
          entry.kind === "work" &&
          hiddenEntryIds.has(entry.id) &&
          workLogEntryIsToolLike(entry.entry) &&
          workEntryIsVisibleInGroup(entry.entry)
            ? [entry.entry]
            : [],
        )
      : [];

    foldsByAnchorEntryId.set(group.anchorEntryId, {
      runId,
      anchorEntryId: group.anchorEntryId,
      // Work the fold reveals after the final message moves the fold's end below it.
      terminalEntryId: group.entries.some(
        (entry, index) => index > terminalEntryIndex && hiddenEntryIds.has(entry.id),
      )
        ? null
        : (group.terminalEntry?.id ?? null),
      createdAt: group.startBoundary ?? firstEntry.createdAt,
      hiddenEntryIds,
      failures,
      // Concise reads "31m · 88 commands · 94 thread updates"; the sentence is its tooltip.
      ...(foldedTools.length > 0
        ? {
            label: isLatestInterruptedTurn ? label : (compactDuration(elapsedMs) ?? label),
            activitySummary: summarizeToolGroupChips(foldedTools).join(" · "),
            activityDetail: `${label} · ${summarizeToolGroup(foldedTools).summary}`,
          }
        : { label }),
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * When a settled turn ends with tool calls after its terminal text, treat the
 * text and tools as one visual response. The message metadata becomes the
 * footer for the whole block instead of separating the prose from the tools.
 */
function attachTrailingToolGroupsToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      runId === null
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (candidate.kind === "work-toggle" && candidate.runId === runId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "event" &&
        candidate.resourceSummary &&
        candidate.projectedItem.item.runId === runId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) =>
              workLogEntryIsToolLike(entry) ||
              (entry.projectedItem?.item.type === "error" &&
                entry.projectedItem.item.status === "failed"),
          )
        ) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

interface TurnActivity {
  readonly entries: WorkLogEntry[];
  readonly editItems: OrchestrationV2TurnItem[];
  readonly subagents: TurnSubagentReference[];
}

function subagentReferenceTitle(item: { readonly title: string | null; readonly prompt: string }) {
  return (
    item.title?.trim() ||
    item.prompt
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ||
    "Subagent"
  );
}

/** Per run: its work entries, its edit items and the provider-native subagents it launched. */
function collectTurnActivity(entries: ReadonlyArray<TimelineEntry>): Map<RunId, TurnActivity> {
  const byRunId = new Map<RunId, TurnActivity>();
  const subagentIds = new Set<string>();
  const activity = (runId: RunId) => {
    let value = byRunId.get(runId);
    if (!value) {
      value = { entries: [], editItems: [], subagents: [] };
      byRunId.set(runId, value);
    }
    return value;
  };
  for (const entry of entries) {
    if (entry.kind === "work") {
      if (!entry.entry.runId) continue;
      const turn = activity(entry.entry.runId);
      turn.entries.push(entry.entry);
      const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
      if (item?.type === "file_change") turn.editItems.push(item);
      continue;
    }
    if (entry.kind !== "event") continue;
    const { item } = entry.projectedItem;
    if (item.runId === null) continue;
    if (item.type === "file_change") activity(item.runId).editItems.push(item);
    if (
      item.type === "subagent" &&
      item.origin === "provider_native" &&
      !subagentIds.has(item.subagentId)
    ) {
      subagentIds.add(item.subagentId);
      activity(item.runId).subagents.push({
        title: subagentReferenceTitle(item),
        childThreadId: item.childThreadId,
      });
    }
  }
  return byRunId;
}

// Delegation already has a durable child card. Remove its tool row only after
// the returned task ID identifies that child; pending calls can share a prompt.
function withoutSubagentDelegationRows(entries: ReadonlyArray<TimelineEntry>) {
  const childrenByRun = new Map<RunId, Set<string>>();
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") continue;
    const item = entry.projectedItem.item;
    if (item.origin !== "app_owned" || item.runId === null) continue;
    const children = childrenByRun.get(item.runId) ?? new Set<string>();
    children.add(item.subagentId);
    childrenByRun.set(item.runId, children);
  }
  return entries.filter((entry) => {
    if (entry.kind !== "work" || workEntryShowsFailureSignal(entry.entry)) return true;
    const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
    if (
      item?.type !== "dynamic_tool" ||
      item.runId === null ||
      (item.status !== "running" && item.status !== "completed") ||
      resolveStudioMcpToolDefinition(item.toolName)?.summaryAction !== "delegate"
    )
      return true;
    const output = compactDynamicToolOutput(item.output);
    if (output?.isError) return true;
    if (output?.taskId !== undefined) {
      return !childrenByRun.get(item.runId)?.has(output.taskId);
    }
    return true;
  });
}

const supersededReasoningEntries = new WeakMap<TimelineEntry, TimelineEntry>();

/** A steer or subsequent activity ends thinking even if the provider omits its completion. */
function settleSupersededReasoning(entries: ReadonlyArray<TimelineEntry>) {
  return entries.map((entry, index) => {
    if (
      index === entries.length - 1 ||
      entry.kind !== "work" ||
      entry.entry.itemType !== "reasoning" ||
      entry.entry.toolLifecycleStatus !== "inProgress"
    ) {
      return entry;
    }
    let settled = supersededReasoningEntries.get(entry);
    if (!settled) {
      settled = { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "completed" } };
      supersededReasoningEntries.set(entry, settled);
    }
    return settled;
  });
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  /**
   * The live work has no app run (a provider-native subagent thread), so
   * runless entries are the current response instead of settled history.
   */
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  supportsConversationRollback: boolean;
  /** Task ids of subagents still working, used by the active tool indicator. */
  liveAgentTaskIds?: ReadonlySet<string> | undefined;
  /** Live bootstrap progress. Renders a stage card under the first user message. */
  worktreeSetup?: WorktreeSetupSnapshot | null;
  /** How much work to show; "normal" when omitted. */
  timelineDetail?: TimelineDetail;
}): MessagesTimelineRow[] {
  const detail = input.timelineDetail ?? "normal";
  const unfilteredEntries = withoutSubagentDelegationRows(
    settleSupersededReasoning(input.timelineEntries),
  );
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: unfilteredEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const runlessWorkActive = input.isWorking && input.runlessWorkActive === true;
  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? runlessWorkActive : activeVisualResponseRunIds.has(runId);
  const timelineEntries =
    detail === "concise"
      ? applyConciseDetail(unfilteredEntries, runIdIsActiveResponse)
      : unfilteredEntries;
  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }
  // Read before Concise filtering, so the card's attribution and counts see the whole run.
  let turnActivity: ReadonlyMap<RunId, TurnActivity> | undefined;
  const turnActivityByRunId = () => (turnActivity ??= collectTurnActivity(unfilteredEntries));
  const revertTurnCountByUserMessageId = input.supportsConversationRollback
    ? deriveRevertTurnCountByUserMessageId({
        timelineEntries: timelineEntries,
        checkpoints: input.turnDiffSummaries,
      })
    : new Map<MessageId, number>();
  const nextRows: MessagesTimelineRow[] = [];
  // Settled tool rows a "Used N tools" summary may fold, with the calls each stands for.
  const foldableToolEntriesByRowId = new Map<string, ReadonlyArray<WorkLogEntry>>();
  const foldableToolDetailRowIds = new Set<string>();
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const supersededFoldsByAnchorEntryId = deriveSupersededAttemptFolds(
    timelineEntries,
    failedRunIds,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: timelineEntries,
    terminalAssistantMessageIds,
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
    runlessWorkActive,
    includeActivitySummary: detail === "concise",
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!isDisclosed(input.expandedRunIds, fold.runId, detail)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }
  const collapsedSupersededEntryIds = new Set<string>();
  for (const fold of supersededFoldsByAnchorEntryId.values()) {
    if (!isDisclosed(input.expandedAttemptIds, fold.attemptId, detail)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedSupersededEntryIds.add(entryId);
      }
    }
  }
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    (entry.runId == null ? runlessWorkActive : entry.runId === unsettledRunId);

  // A steer continues the current turn. Keep its elapsed-time header below
  // the initiating prompt (or automatic wake), rather than moving it down.
  const activeTurnHeaderIndex = input.isWorking
    ? lastResponseBoundaryIndex(timelineEntries) + 1
    : timelineEntries.length;

  // Contiguous trailing work entries of the active run collapse into one live
  // row that survives between actions: while a tool runs it shows that tool,
  // and once everything settles it keeps the latest tool in past tense
  // instead of vanishing (#8984).
  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (input.isWorking && (unsettledRunId !== null || runlessWorkActive)) {
    let tailAttemptId: string | null | undefined;
    for (let index = timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
      const entry = timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        entry.entry.tone === "error" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "notification" ||
        !runIdIsActiveResponse(entry.entry.runId) ||
        entry.entry.sourceActivityKind === "context-compaction" ||
        collapsedEntryIds.has(entry.id) ||
        collapsedSupersededEntryIds.has(entry.id) ||
        foldsByAnchorEntryId.has(entry.id) ||
        supersededFoldsByAnchorEntryId.has(entry.id)
      ) {
        break;
      }
      if (tailAttemptId === undefined) {
        tailAttemptId = entry.attempt?.id ?? null;
      } else if ((entry.attempt?.id ?? null) !== tailAttemptId) {
        break;
      }
      activeToolEntries.unshift(entry);
    }
  }
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry));
  const latestToolFailureKind =
    latestVisibleToolEntry === undefined
      ? null
      : timelineEntryFailureKind(latestVisibleToolEntry.entry);
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    (latestToolFailureKind === "failed" || latestToolFailureKind === "possible");

  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${activeWorkAnchor.id}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: isDisclosed(input.expandedWorkGroupIds, groupId, detail),
            active: latestToolKeepsActivityLive,
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : [],
  );
  const appendWorkingRow = () => {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt ?? null,
    });
  };
  let hasActivityRow = false;
  let hasActiveCompaction = false;
  // Verbose opens a group with one tool call straight to that call, so the
  // header naming the same call is not shown twice.
  const headerRepeatsItsOnlyTool = (expanded: boolean, entries: ReadonlyArray<WorkLogEntry>) =>
    detail === "verbose" &&
    expanded &&
    // A thoughts-only group keeps its header: the open trace has no label of its own.
    entries.filter((entry) => entry.itemType !== "reasoning" && workLogEntryIsToolLike(entry))
      .length === 1;
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    if (!headerRepeatsItsOnlyTool(activeWorkRow.expanded, activeWorkRow.groupedEntries)) {
      nextRows.push(activeWorkRow);
    }
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded) return;
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
      ),
    );
  };

  // Replies to a message that asked for a report may show as a report card.
  let reportRequested = false;
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    // The terminal interrupt result is the useful timeline marker. The
    // preceding request is transient bookkeeping and duplicates that marker.
    if (
      timelineEntry.kind === "event" &&
      timelineEntry.projectedItem.item.type === "run_interrupt_request"
    ) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        ...(turnFold.activitySummary === undefined
          ? {}
          : { activitySummary: turnFold.activitySummary }),
        ...(turnFold.activityDetail === undefined
          ? {}
          : { activityDetail: turnFold.activityDetail }),
        expanded: isDisclosed(input.expandedRunIds, turnFold.runId, detail),
        ...turnFold.failures,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
        id: `attempt-fold:${supersededFold.attemptId}`,
        createdAt: supersededFold.createdAt,
        runId: supersededFold.runId,
        attemptId: supersededFold.attemptId,
        label: "Superseded attempt",
        expanded: isDisclosed(input.expandedAttemptIds, supersededFold.attemptId, detail),
      });
    }

    if (collapsedSupersededEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.sourceActivityKind === "context-compaction"
    ) {
      const active = workEntryIsInActiveRun(timelineEntry.entry);
      hasActiveCompaction ||= active;
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        label: timelineEntry.entry.label,
        active,
      });
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        (timelineEntry.entry.runId != null && failedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        timelineEntry.entry.tone === "error" ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice" ||
        timelineEntry.entry.itemType === "notification"
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.sourceActivityKind === "context-compaction" ||
          nextEntry.entry.tone === "error" ||
          nextEntry.entry.sourceActivityKind === "runtime.error" ||
          nextEntry.entry.itemType === "system_notice" ||
          nextEntry.entry.itemType === "notification" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          collapsedSupersededEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id) ||
          supersededFoldsByAnchorEntryId.has(nextEntry.id) ||
          (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null) ||
          nextEntry.attempt?.id !== timelineEntry.attempt?.id
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = isDisclosed(input.expandedWorkGroupIds, groupId, detail);
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          if (!headerRepeatsItsOnlyTool(expanded, visibleGroupedEntries)) {
            nextRows.push({
              kind: "work-live",
              id: `work-live:${timelineEntry.id}`,
              createdAt: timelineEntry.createdAt,
              entry: latestActiveToolEntry,
              groupedEntries: visibleGroupedEntries,
              groupId,
              expanded,
              active: true,
            });
          }
          hasActivityRow = true;
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        } else if (
          visibleGroupedEntries.length === 1 &&
          workLogEntryIsToolLike(visibleGroupedEntries[0]!)
        ) {
          const singleEntry = visibleGroupedEntries[0]!;
          foldableToolEntriesByRowId.set(timelineEntry.id, visibleGroupedEntries);
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries).summary
                : singleToolCallLabel(singleEntry),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = isDisclosed(input.expandedWorkGroupIds, groupId, detail);
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const primarySourceEntry = visibleGroupedEntries.find(
            (entry) => entry.toolSource !== undefined,
          );
          const primarySourceKey = primarySourceEntry?.toolSource?.key;
          const primarySourceIcon = primarySourceKey
            ? (visibleGroupedEntries.find(
                (entry) =>
                  entry.toolSource?.key === primarySourceKey && entry.toolIcon !== undefined,
              )?.toolIcon ?? primarySourceEntry?.toolSource?.icon)
            : undefined;
          const groupToolSurface =
            primarySourceEntry?.toolSurface ??
            visibleGroupedEntries.findLast((entry) => entry.toolSurface !== undefined)?.toolSurface;
          const groupToolIcon =
            primarySourceIcon ??
            visibleGroupedEntries.findLast((entry) => entry.toolIcon !== undefined)?.toolIcon;
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          const usesSingleToolCallLabel =
            singleEntry !== null &&
            workLogEntryIsToolLike(singleEntry) &&
            toolGroupAction(singleEntry) !== "edit";
          const summaryToolIcon = usesSingleToolCallLabel
            ? resolveWorkEntryToolPresentation(singleEntry, "completed")?.icon
            : undefined;
          if (!headerRepeatsItsOnlyTool(expanded, visibleGroupedEntries)) {
            foldableToolEntriesByRowId.set(
              `work-toggle:${timelineEntry.id}`,
              visibleGroupedEntries,
            );
            nextRows.push({
              kind: "work-toggle",
              id: `work-toggle:${timelineEntry.id}`,
              createdAt: timelineEntry.createdAt,
              runId: timelineEntry.entry.runId ?? null,
              groupId,
              hiddenCount: visibleGroupedEntries.length,
              toolCount: visibleGroupedEntries.filter(workLogEntryIsToolLike).length,
              expanded,
              summary: usesSingleToolCallLabel
                ? singleToolCallLabel(singleEntry)
                : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                  ? singleEntry.label
                  : summarizeToolGroup(visibleGroupedEntries).summary,
              summaryKind,
              ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
              ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
              ...(summaryToolIcon ? { summaryToolIcon } : {}),
              hasFailure:
                latestToolEntry !== undefined &&
                timelineEntryFailureKind(latestToolEntry) === "failed",
              ...toolFailureCounts(visibleGroupedEntries),
            });
          }
          if (expanded) {
            const detailsRow = expandedWorkGroupRow(
              groupId,
              timelineEntry.createdAt,
              visibleGroupedEntries,
            );
            foldableToolDetailRowIds.add(detailsRow.id);
            nextRows.push(detailsRow);
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      const previous = nextRows.at(-1);
      if (
        timelineEntry.projectedItem.item.type === "subagent" &&
        previous?.kind === "event" &&
        previous.projectedItem.item.type === "subagent" &&
        previous.projectedItem.item.runId === timelineEntry.projectedItem.item.runId &&
        previous.projectedItem.item.providerTurnId ===
          timelineEntry.projectedItem.item.providerTurnId
      ) {
        nextRows[nextRows.length - 1] = {
          ...previous,
          subagents: [
            ...(previous.subagents ?? [previous.projectedItem]),
            timelineEntry.projectedItem,
          ],
        };
        continue;
      }
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
      });
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;

    if (timelineEntry.message.role === "user") {
      reportRequested = asksForReport(timelineEntry.message.text);
    }
    const assistantTurnDiffSummary =
      timelineEntry.message.role === "assistant"
        ? turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
        : undefined;
    const turnActivity =
      assistantTurnDiffSummary === undefined
        ? undefined
        : turnActivityByRunId().get(assistantTurnDiffSummary.runId);
    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      assistantTurnDiffSummary,
      ...(assistantTurnDiffSummary === undefined
        ? {}
        : {
            turnEditItems: turnActivity?.editItems ?? [],
            turnSubagents: turnActivity?.subagents ?? [],
            turnFailedCount: toolFailureCounts(turnActivity?.entries ?? []).failedCount,
          }),
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
      ...(reportRequested && timelineEntry.message.role === "assistant"
        ? { reportRequested: true as const }
        : {}),
    });
  }

  // Until the agent's turn is live, the setup card sits under the send with
  // the working header above it (the header reads "Setting up worktree…" and
  // later swaps its text in place, so nothing moves at the handoff). "Live"
  // means the turn is in the timeline, not just that the server dispatched
  // it: the card must not vanish in the gap between. Once the turn is live
  // the stage list leaves the timeline; a script that is still running is
  // surfaced by the working header itself. A failed or cancelled setup stays
  // under the send so its outcome and actions remain reachable.
  const setupHandedOff =
    input.worktreeSetup !== null &&
    input.worktreeSetup !== undefined &&
    worktreeSetupAgentStarted(input.worktreeSetup) &&
    input.latestRun?.startedAt != null;
  // A run that settled without going live (the provider session failed to
  // open, the send was cancelled) leaves no handoff to wait for: its failure
  // row takes over and no working header may keep counting above the setup.
  const setupRunSettled = isSettledRunStatus(input.latestRun?.status);
  // A finished setup keeps the slot until the turn is live, so the card does
  // not jump above the working header in the gap before the run starts.
  const setupOwnsWorkingSlot =
    !setupHandedOff &&
    !setupRunSettled &&
    (input.worktreeSetup?.phase === "running" || input.worktreeSetup?.phase === "done");
  if (input.worktreeSetup && (!setupHandedOff || input.worktreeSetup.phase !== "running")) {
    const setupRow = {
      kind: "worktree-setup",
      id: WORKTREE_SETUP_ROW_ID,
      createdAt: input.worktreeSetup.startedAt,
      snapshot: input.worktreeSetup,
      embedded: setupHandedOff,
    } as const;
    const firstUserRowIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.role === "user",
    );
    // While the setup runs, the working header leads the card in the same
    // slot it keeps once the agent's own turn takes over. The main pass may
    // already have placed that header (a bootstrap counts as working).
    const workingRowIndex = setupOwnsWorkingSlot
      ? nextRows.findIndex((row) => row.kind === "working")
      : -1;
    if (workingRowIndex >= 0) {
      nextRows.splice(workingRowIndex + 1, 0, setupRow);
    } else {
      const insertAt = firstUserRowIndex >= 0 ? firstUserRowIndex + 1 : nextRows.length;
      nextRows.splice(
        insertAt,
        0,
        ...(setupOwnsWorkingSlot
          ? [
              {
                kind: "working",
                id: "working-indicator-row",
                createdAt: input.worktreeSetup.startedAt,
              } as const,
              setupRow,
            ]
          : [setupRow]),
      );
    }
  }

  // A setup that owns the working slot sits under it and shows no activity
  // row of its own; every other state gets the usual tail.
  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (input.isWorking && !hasWorkingRow && activeTurnHeaderIndex === timelineEntries.length) {
    appendWorkingRow();
  }
  if (
    input.isWorking &&
    !setupOwnsWorkingSlot &&
    !hasActiveCompaction &&
    (!hasActivityRow || latestToolFailed)
  ) {
    // A failed latest tool hands the row back to thinking, but its group
    // stays reachable through the same disclosure the live row offers.
    const failedGroupAnchor = latestToolFailed ? activeWorkAnchor : undefined;
    if (failedGroupAnchor) {
      const groupId = workGroupId(failedGroupAnchor.id);
      const expanded = isDisclosed(input.expandedWorkGroupIds, groupId, detail);
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        groupId,
        groupCount: visibleActiveToolEntries.filter((entry) => workLogEntryIsToolLike(entry.entry))
          .length,
        expanded,
      });
      if (expanded) {
        nextRows.push(
          expandedWorkGroupRow(
            groupId,
            failedGroupAnchor.createdAt,
            visibleActiveToolEntries.map((entry) => entry.entry),
          ),
        );
      }
    } else {
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
      });
    }
  }

  const trailingAttached = attachTrailingToolGroupsToAssistant(
    attachCreatedThreadSummaries(nextRows, timelineEntries),
  );
  const attached =
    detail === "verbose"
      ? trailingAttached
      : foldToolActivity(trailingAttached, {
          entriesByRowId: foldableToolEntriesByRowId,
          detailRowIds: foldableToolDetailRowIds,
          terminalMessageIds: terminalAssistantMessageIds,
          isExpanded: (groupId) => isDisclosed(input.expandedWorkGroupIds, groupId, detail),
        });
  const result =
    detail === "verbose"
      ? attached
      : withTurnFoldEnds(
          attached,
          new Map(
            [...foldsByAnchorEntryId.values()].map((fold) => [fold.runId, fold.terminalEntryId]),
          ),
        );
  return result.map((row, index) =>
    timelineRowIsWorkLog(row) && timelineRowIsWorkLog(result[index + 1])
      ? { ...row, continuesWorkLog: true }
      : row,
  );
}

/** Rows an open fold must hold before it gets a closing row; a short fold folds from its header. */
export const TURN_FOLD_END_MIN_ROWS = 3;

/**
 * Gives each expanded "Worked for …" fold a closing row right above the
 * turn's final message (or wherever the turn's rows end), so the boundary of
 * the opened work is visible and it can be folded again without scrolling
 * back to its header.
 */
export function withTurnFoldEnds(
  rows: ReadonlyArray<MessagesTimelineRow>,
  terminalEntryIdByRunId: ReadonlyMap<RunId, string | null>,
): MessagesTimelineRow[] {
  const out: MessagesTimelineRow[] = [];
  let open: { fold: Extract<MessagesTimelineRow, { kind: "turn-fold" }>; rows: number } | null =
    null;
  const close = (anchorRowId: string | null) => {
    if (open === null) return;
    if (open.rows >= TURN_FOLD_END_MIN_ROWS) {
      out.push({
        kind: "turn-fold-end",
        id: `turn-fold-end:${open.fold.runId}`,
        createdAt: open.fold.createdAt,
        runId: open.fold.runId,
        label: open.fold.label,
        anchorRowId,
      });
    }
    open = null;
  };
  for (const row of rows) {
    if (
      open !== null &&
      (row.id === terminalEntryIdByRunId.get(open.fold.runId) ||
        row.kind === "turn-fold" ||
        row.kind === "working" ||
        row.kind === "thinking" ||
        (row.kind === "message" && row.message.role === "user"))
    ) {
      close(row.id);
    }
    out.push(row);
    if (open !== null) open.rows += 1;
    if (row.kind === "turn-fold" && row.expanded) open = { fold: row, rows: 0 };
  }
  close(null);
  return out;
}

/** Narration this long, or with code, is content rather than a step note. */
const TOOL_ACTIVITY_NOTE_MAX_LENGTH = 500;

function rowIsToolActivityNote(
  row: MessagesTimelineRow,
  terminalMessageIds: ReadonlySet<string>,
): row is Extract<MessagesTimelineRow, { kind: "message" }> {
  if (
    row.kind !== "message" ||
    terminalMessageIds.has(row.message.id) ||
    row.message.role !== "assistant" ||
    row.showAssistantMeta ||
    row.message.streaming ||
    (row.message.attachments?.length ?? 0) > 0
  ) {
    return false;
  }
  const text = row.message.text.trim();
  return text.length <= TOOL_ACTIVITY_NOTE_MAX_LENGTH && !text.includes("```");
}

function toolActivityCategories(entries: ReadonlyArray<WorkLogEntry>): ToolActivityCategory[] {
  const groups = new Map<string, WorkLogEntry[]>();
  for (const entry of entries) {
    const key = `${toolGroupSummaryKind([entry])}:${entry.toolSource?.key ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.values()].map((group) => ({
    kind: toolGroupSummaryKind(group),
    label: summarizeToolGroup(group).summary,
  }));
}

/**
 * Settled work in one run often alternates short narration ("Checking the
 * build") with tool groups. A stretch that starts and ends with tool rows and
 * holds at least two of them folds into one "Used N tools" row; opening it
 * shows the original rows, each with its own disclosure. Narration before and
 * after the stretch, long messages and anything else break it.
 */
function foldToolActivity(
  rows: ReadonlyArray<MessagesTimelineRow>,
  options: {
    entriesByRowId: ReadonlyMap<string, ReadonlyArray<WorkLogEntry>>;
    detailRowIds: ReadonlySet<string>;
    /** A turn's final reply stays visible even when tool rows follow it. */
    terminalMessageIds: ReadonlySet<string>;
    isExpanded: (groupId: string) => boolean;
  },
): MessagesTimelineRow[] {
  const toolRunId = (row: MessagesTimelineRow) =>
    options.entriesByRowId.get(row.id)?.[0]?.runId ?? null;
  const isNote = (row: MessagesTimelineRow) =>
    rowIsToolActivityNote(row, options.terminalMessageIds);
  const out: MessagesTimelineRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const first = rows[index]!;
    if (!options.entriesByRowId.has(first.id)) {
      out.push(first);
      index += 1;
      continue;
    }
    const runId = toolRunId(first);
    let cursor = index;
    let end = index;
    while (cursor < rows.length) {
      const row = rows[cursor]!;
      if (options.entriesByRowId.has(row.id) && toolRunId(row) === runId) {
        cursor += 1;
        while (cursor < rows.length && options.detailRowIds.has(rows[cursor]!.id)) cursor += 1;
        end = cursor;
        continue;
      }
      if (isNote(row) && row.kind === "message" && (row.message.runId ?? null) === runId) {
        cursor += 1;
        continue;
      }
      break;
    }
    const span = rows.slice(index, end);
    const toolRows = span.filter((row) => options.entriesByRowId.has(row.id));
    const tools = toolRows
      .flatMap((row) => options.entriesByRowId.get(row.id)!)
      .filter((entry) => entry.itemType !== "reasoning");
    if (toolRows.length < 2 || tools.length < 2) {
      out.push(...span);
      index = end;
      continue;
    }
    const notes = span.filter((row) => rowIsToolActivityNote(row, options.terminalMessageIds));
    const groupId = `tool-activity:${first.id}`;
    const expanded = options.isExpanded(groupId);
    out.push({
      kind: "tool-activity",
      id: groupId,
      createdAt: first.createdAt ?? tools[0]!.createdAt,
      groupId,
      expanded,
      toolCount: tools.length,
      noteCount: notes.length,
      noteMessageIds: notes.map((row) => row.message.id),
      ...toolFailureCounts(tools),
      categories: toolActivityCategories(tools),
    });
    if (expanded) {
      out.push(...span.map((row) => ({ ...row, withinToolActivity: true })));
    }
    index = end;
  }
  return out;
}

/** Adjacent work stays one visual list even when virtualization splits its groups. */
function timelineRowIsWorkLog(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.kind === "work" ||
      row.kind === "work-toggle" ||
      row.kind === "tool-activity" ||
      row.kind === "work-live" ||
      row.kind === "thinking")
  );
}

// Keep created chats below the final answer even when the work that created them folds away.
function attachCreatedThreadSummaries(
  rows: MessagesTimelineRow[],
  timelineEntries: ReadonlyArray<TimelineEntry>,
): MessagesTimelineRow[] {
  const terminalIndexes = new Map<RunId, number>();
  const collapsedRuns = new Set<RunId>();
  const createdByRun = new Map<RunId, Array<Extract<MessagesTimelineRow, { kind: "event" }>>>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      terminalIndexes.set(row.message.runId, index);
    }
    if (row.kind === "turn-fold" && !row.expanded) collapsedRuns.add(row.runId);
  }
  for (const entry of timelineEntries) {
    const projectedItem =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : entry.kind === "event"
          ? entry.projectedItem
          : undefined;
    if (projectedItem?.item.type === "thread_created" && projectedItem.item.runId) {
      const runId = projectedItem.item.runId;
      const entries = createdByRun.get(runId) ?? [];
      entries.push({ kind: "event", id: entry.id, createdAt: entry.createdAt, projectedItem });
      createdByRun.set(runId, entries);
    }
  }
  return rows.flatMap((row, index): MessagesTimelineRow[] => {
    if (row.kind === "event" && row.projectedItem.item.type === "thread_created") {
      const runId = row.projectedItem.item.runId;
      const terminalIndex = runId === null ? undefined : terminalIndexes.get(runId);
      if (terminalIndex !== undefined && (collapsedRuns.has(runId!) || index > terminalIndex))
        return [];
    }
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      return [
        row,
        ...(createdByRun.get(row.message.runId) ?? []).map((entry) => ({
          ...entry,
          id: `summary:${entry.id}`,
          resourceSummary: true,
        })),
      ];
    }
    return [row];
  });
}

const WORKTREE_SETUP_ROW_ID = "worktree-setup-row";

type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

export interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    ...context
  } = input;
  // V2 shell and checkpoint selectors produce fresh summaries for each event.
  // Equivalent summaries must not invalidate a text-only projection.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (const [index, entry] of timelineEntries.entries()) {
    const previousEntry = previousEntries[index]!;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0) return previous.rows;
  return previous.rows.map((row) => {
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
}

/** Keep one projection per timeline. Reuse rows only when streaming content changes. */
export function deriveMessagesTimelineRowsWithState(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection | null = null,
): MessagesTimelineRowsProjection {
  return {
    input,
    rows:
      (previous === null ? null : replaceStreamingMessageRows(input, previous)) ??
      deriveMessagesTimelineRows(input),
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function sameToolFailureCounts(a: ToolFailureCounts, b: ToolFailureCounts): boolean {
  return (
    a.failedCount === b.failedCount &&
    a.possibleFailureCount === b.possibleFailureCount &&
    a.declinedCount === b.declinedCount
  );
}

function sameSubagentReference(a: TurnSubagentReference, b: TurnSubagentReference): boolean {
  return a.title === b.title && a.childThreadId === b.childThreadId;
}

function sameElements<T>(
  a: ReadonlyArray<T> | undefined,
  b: ReadonlyArray<T> | undefined,
  same: (left: T, right: T) => boolean = Object.is,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((value, index) => same(value, b[index]!));
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.withinToolActivity !== b.withinToolActivity) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;
    case "thinking": {
      const bt = b as typeof a;
      return (
        a.createdAt === bt.createdAt &&
        a.groupId === bt.groupId &&
        a.expanded === bt.expanded &&
        a.groupCount === bt.groupCount
      );
    }
    case "worktree-setup":
      return a.snapshot === (b as typeof a).snapshot;

    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message === bm.message &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.activitySummary === bf.activitySummary &&
        a.activityDetail === bf.activityDetail &&
        a.expanded === bf.expanded &&
        sameToolFailureCounts(a, bf)
      );
    }

    case "tool-activity": {
      const bt = b as typeof a;
      return (
        a.createdAt === bt.createdAt &&
        a.expanded === bt.expanded &&
        a.toolCount === bt.toolCount &&
        a.noteCount === bt.noteCount &&
        a.noteMessageIds.join() === bt.noteMessageIds.join() &&
        sameToolFailureCounts(a, bt) &&
        a.categories.length === bt.categories.length &&
        a.categories.every(
          (category, index) =>
            category.kind === bt.categories[index]!.kind &&
            category.label === bt.categories[index]!.label,
        )
      );
    }

    case "turn-fold-end": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt && a.label === bf.label && a.anchorRowId === bf.anchorRowId
      );
    }

    case "attempt-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return a.createdAt === bc.createdAt && a.label === bc.label && a.active === bc.active;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Entries rebuild on any tool update; an equal page must keep its mounted frame.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "event":
      return (
        a.projectedItem === (b as typeof a).projectedItem &&
        a.resourceSummary === (b as typeof a).resourceSummary &&
        Equal.equals(a.subagents, (b as typeof a).subagents)
      );

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.toolCount === bw.toolCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.toolSurface === bw.toolSurface &&
        Equal.equals(a.toolIcon, bw.toolIcon) &&
        a.hasFailure === bw.hasFailure &&
        sameToolFailureCounts(a, bw)
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.projectedItem === bm.projectedItem &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        sameElements(a.turnEditItems, bm.turnEditItems) &&
        sameElements(a.turnSubagents, bm.turnSubagents, sameSubagentReference) &&
        a.turnFailedCount === bm.turnFailedCount &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}

/** "45s", "31m", "1h 5m": a turn's length at a glance; the tooltip keeps the seconds. */
export function compactDuration(elapsedMs: number | null): string | null {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** Where the thread's plan stands, so a long turn says which step it is on. */
export interface WorkingPlanProgress {
  readonly completed: number;
  readonly total: number;
  readonly current: string | null;
}

/** "Step 3 of 5: Run the harnesses", or null when there is no plan to count. */
export function workingStepLabel(plan: WorkingPlanProgress | null): string | null {
  if (plan === null || plan.total === 0) return null;
  if (plan.current === null) {
    return plan.completed >= plan.total ? `All ${plan.total} steps done` : null;
  }
  return `Step ${Math.min(plan.completed + 1, plan.total)} of ${plan.total}: ${plan.current}`;
}
