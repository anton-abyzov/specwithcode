import {
  computerUsePermissionFromError,
  isOrchestrationV2WorkActive,
  isToolLifecycleItemType,
  type AssetResource,
  type ComputerUsePermission,
  type RuntimeItemStatus,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolActivityIcon,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  resolveStudioMcpToolDefinition,
  type StudioMcpToolDefinition,
  type StudioMcpToolSummaryAction,
} from "@specweave-studio/shared/studioMcpToolPresentation";
import { classifyMarkdownImageSource } from "@specweave-studio/client-runtime/markdown-images";
import { resolveMediaSource } from "@specweave-studio/client-runtime/media-source";
import type { ThreadCheckpointSummary } from "@specweave-studio/client-runtime/state/thread-checkpoints";
import { parseChangeRequestUrl } from "@specweave-studio/shared/changeRequestUrl";
import { isWorkspaceImagePreviewPath } from "@specweave-studio/shared/filePreview";
import { isWindowsAbsolutePath } from "@specweave-studio/shared/path";
import { formatTokens } from "@specweave-studio/shared/usageFormat";
import { classifyToolActivity } from "@specweave-studio/shared/toolActivity";
import { toolOutputIndicatesFailure } from "@specweave-studio/shared/toolOutput";

import {
  summarizeStudioToolCalls,
  studioToolResultIndicatesFailure,
  type StudioToolSummaryCall,
} from "@specweave-studio/client-runtime/studioToolSummary";

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped" | "idle";

/** Inspection and copying omit raw outputs, including values from older caches. */
export function toolItemForDisplay(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...displayItem } = item;
      return displayItem;
    }
    case "file_change": {
      const { diffStr, oldStr: _oldStr, newStr: _newStr, ...displayItem } = item;
      // A failed edit's diffStr holds the provider's error, not a diff.
      return item.status === "failed" && diffStr?.trim()
        ? { ...displayItem, diffStr }
        : displayItem;
    }
    default:
      return item;
  }
}

export function contextCompactionLabel(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
    "status" | "beforeTokenCount" | "afterTokenCount"
  >,
): string {
  if (item.status === "running") return "Compacting context";
  if (item.beforeTokenCount !== undefined && item.afterTokenCount !== undefined) {
    return `Context compacted ${formatTokens(item.beforeTokenCount)} → ${formatTokens(item.afterTokenCount)} tokens`;
  }
  return "Context compacted";
}

export interface WorkLogPresentationEntry {
  readonly questionAnswer?: import("@specweave-studio/contracts").UserInputAttachmentAnswerPayload;
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly toolSource?: ToolActivitySource;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
}

export type ToolGroupAction =
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "read"
  | "edit"
  | "command"
  | "thread-create"
  | "browser"
  | "device"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | "pull-request"
  | ToolGroupAction
  | "dynamic-tool"
  | "reasoning"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/** Structured identity is authoritative, including when it identifies a foreign server. */
function workEntryToolName(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "structuredPayload">,
): string | undefined {
  const item = entry.structuredPayload;
  if (item?.type === "dynamic_tool" && item.toolName) return item.toolName;
  const data = asRecord(entry.toolData);
  if (typeof data?.server === "string" && typeof data.tool === "string") {
    return `${data.server}.${data.tool}`;
  }
  if (typeof data?.toolName === "string") return data.toolName;
  return resolveStudioMcpToolDefinition(entry.toolTitle) ? entry.toolTitle : entry.label;
}

function workEntryToolOutput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  return item?.type === "dynamic_tool"
    ? item.output
    : (data?.output ?? data?.result ?? data?.rawOutput ?? data?.content);
}

function resolveStudioMcpToolPresentation(
  definition: StudioMcpToolDefinition | null,
  status: string | undefined,
  data?: unknown,
) {
  if (!definition) return null;
  const [action, running, completed, detail] = definition.labels;
  const verb =
    status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `Failed to ${action.toLowerCase()}`
          : status === "declined"
            ? `Declined to ${action.toLowerCase()}`
            : status === "stopped"
              ? `Stopped ${running.toLowerCase()}`
              : running;

  const actionKind =
    definition.summaryAction === "link-pr" ||
    definition.summaryAction === "unlink-pr" ||
    definition.summaryAction === "list-prs" ||
    definition.summaryAction === "watch-pr" ||
    definition.summaryAction === "unwatch-pr"
      ? definition.summaryAction
      : undefined;
  const payload = asRecord(data);
  const input =
    asRecord(payload?.arguments) ?? asRecord(payload?.input) ?? asRecord(payload?.rawInput);
  const urlTarget = typeof input?.url === "string" ? parseChangeRequestUrl(input.url) : null;
  const number = urlTarget?.number ?? input?.number;
  const target =
    actionKind !== undefined &&
    actionKind !== "list-prs" &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
      ? `PR #${number}`
      : detail;
  return {
    displayName: `${verb} ${target}`,
    icon: definition.icon,
    ...(actionKind === undefined ? {} : { action: actionKind }),
  };
}

/** Only active or completed calls can inherit the live group’s present tense. */
export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") {
    return status;
  }
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

/** Resolves tool identity before choosing labels or icons in either client. */
export function resolveWorkEntryToolPresentation(
  entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolTitle" | "toolData" | "toolLifecycleStatus" | "structuredPayload"
  >,
  fallbackStatus?: "inProgress" | "completed",
) {
  const definition = resolveStudioMcpToolDefinition(workEntryToolName(entry));
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  return resolveStudioMcpToolPresentation(
    definition,
    definition && studioToolResultIndicatesFailure(workEntryToolOutput(entry)) ? "failed" : status,
    entry.toolData,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * Decides whether a command row's `detail` is a synthetic echo of the command
 * rather than real output. OpenCode stores completed output in `detail` with no
 * other output channel, so plain equality is only treated as synthetic when the
 * payload shape shows the detail came from the command: Codex item metadata,
 * an ACP tool call (`data.toolCallId`, `kind: "execute"`), a Claude tool-name
 * prefix, or no structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) return false;
  if (
    resolveStudioMcpToolDefinition(workEntryToolName(entry)) &&
    studioToolResultIndicatesFailure(workEntryToolOutput(entry))
  ) {
    return true;
  }
  const item = entry.structuredPayload;
  if (item?.type === "command_execution") {
    if (item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0)) {
      return true;
    }
    // Older servers/caches can still carry output. Read only the previous
    // preview-sized prefix for status, without exposing it in the row detail.
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) {
      return true;
    }
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolOutputIndicatesFailure(output);
}

/** Includes legacy activities that stored error output in the command field. */
export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

/** Checks rendered output without treating the user's command as an error. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

export type WorkEntryFailureKind = "failed" | "possible" | "declined" | "stopped";

/**
 * How a row ended, for its chip and the group counts. `failed`: failed status,
 * a nonzero exit code or a provider error. `possible`: only the output
 * heuristic matched, so it is never counted as failed. `declined`: the user
 * declined it (its status stays `cancelled`). `stopped`: interrupted or
 * cancelled, which no count includes.
 */
export function workEntryFailureKind(entry: WorkLogPresentationEntry): WorkEntryFailureKind | null {
  const item = entry.structuredPayload;
  const declined =
    (item?.type === "command_execution" || item?.type === "file_change") && item.declined === true;
  if (entry.toolLifecycleStatus === "declined" || declined) return "declined";
  if (
    entry.toolLifecycleStatus === "stopped" ||
    item?.status === "interrupted" ||
    item?.status === "cancelled"
  ) {
    return "stopped";
  }
  if (entry.tone === "error" || entry.toolLifecycleStatus === "failed") return "failed";
  if (!workLogEntryIsToolLike(entry)) return null;
  if (
    resolveStudioMcpToolDefinition(workEntryToolName(entry)) &&
    studioToolResultIndicatesFailure(workEntryToolOutput(entry))
  ) {
    return "failed";
  }
  if (item?.type === "command_execution") {
    if (item.exitCode !== undefined && item.exitCode !== 0) return "failed";
    // On the wire this flag is a nonzero exit or a heuristic match; the exit case returned above.
    if (item.outputIndicatesFailure) return "possible";
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) return "possible";
  }
  const detail = entry.detail ?? "";
  return detail.length > 0 && toolOutputIndicatesFailure(detail) ? "possible" : null;
}

/** Claude in Chrome's message, and the SpecWithCode Browser extension's (`noProfileHint`). */
const CHROME_DISCONNECTED = /browser extension is not connected|no chrome profile is connected/i;

/** True when a browser tool failed because Chrome's extension is unreachable on the run's machine. */
export function workEntryReportsChromeDisconnected(
  entry: Pick<WorkLogPresentationEntry, "detail" | "toolData" | "structuredPayload">,
): boolean {
  if (entry.detail && CHROME_DISCONNECTED.test(entry.detail)) return true;
  const output = workEntryToolOutput(entry);
  if (output === undefined || output === null) return false;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return CHROME_DISCONNECTED.test(text.slice(0, 8_192));
}

/** The macOS permission a failed `computer_*` tool says SpecWithCode is missing, if any. */
export function workEntryComputerUsePermission(
  entry: Pick<WorkLogPresentationEntry, "detail" | "toolData" | "structuredPayload">,
): ComputerUsePermission | undefined {
  const fromDetail = entry.detail ? computerUsePermissionFromError(entry.detail) : undefined;
  if (fromDetail !== undefined) return fromDetail;
  const output = workEntryToolOutput(entry);
  if (output === undefined || output === null) return undefined;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return computerUsePermissionFromError(text.slice(0, 8_192));
}

/** Decides whether the row can show a success marker. */
export function workEntryIndicatesToolSuccess(entry: WorkLogPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "idle" &&
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped"
  );
}

function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "file_search" ||
    (entry.itemType === "web_search" &&
      /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label)))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (entry.itemType === "thread_created") return "thread-create";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation?.action !== undefined) return presentation.action;
  if (presentation?.icon === "browser") return "browser";
  if (presentation?.icon === "device") return "device";
  if (entry.requestKind === "file-read" || entry.viewedImagePath !== undefined) return "read";
  // Approvals and questions describe requested work, not work that ran.
  if (entry.itemType === "approval_request" || entry.itemType === "user_input_request") {
    return workLogEntryIsToolLike(entry) ? "other" : "update";
  }
  const data = asRecord(entry.toolData) ?? {};
  const toolName =
    entry.structuredPayload?.type === "dynamic_tool"
      ? entry.structuredPayload.toolName
      : typeof data.toolName === "string"
        ? data.toolName
        : entry.toolTitle;
  const classified = classifyToolActivity({
    itemType:
      entry.itemType === "command_execution" ||
      entry.itemType === "file_change" ||
      entry.itemType === "web_search"
        ? entry.itemType
        : entry.itemType === "dynamic_tool"
          ? "dynamic_tool_call"
          : undefined,
    title: entry.toolTitle ?? entry.label,
    data: {
      ...data,
      ...(toolName ? { toolName } : {}),
    },
  });
  if (classified === "read") return "read";
  if (classified === "file_change" || entry.itemType === "file_change") return "edit";
  // A command whose typed actions are all searches or listings (Codex) searched code.
  if (classified === "search" && entry.itemType === "command_execution") return "code-search";
  if (classified === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (classified === "search") {
    return entry.itemType === "web_search" && !workLogEntryIsLocalCodeSearch(entry)
      ? "search"
      : "code-search";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  if ((entry.changedFiles?.length ?? 0) > 0) return "edit";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  // A relative path with no known workspace still names a media-file relative
  // to the thread's workspace, so classify against "." and drop the prefix.
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
    } else {
      for (const file of entry.changedFiles) changedFiles.add(file);
    }
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "link-pr":
      return `Linked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "unlink-pr":
      return `Unlinked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "watch-pr":
      return `Watching ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "unwatch-pr":
      return `Stopped watching ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "list-prs":
      return count === 1
        ? "Checked linked pull requests"
        : `Checked linked pull requests ${count} times`;
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "thread-create":
      return `Created ${count} ${count === 1 ? "thread" : "threads"}`;
    case "device":
      return `Used device controls ${count} ${count === 1 ? "time" : "times"}`;
    case "browser":
      return `Used browser ${count} ${count === 1 ? "time" : "times"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

function studioToolSummaryCall(entry: WorkLogPresentationEntry): StudioToolSummaryCall {
  const item = entry.structuredPayload;
  const data =
    entry.toolData !== null && typeof entry.toolData === "object"
      ? (entry.toolData as Record<string, unknown>)
      : undefined;
  return {
    input:
      item?.type === "dynamic_tool"
        ? item.input
        : (data?.arguments ?? data?.input ?? data?.rawInput),
    output: workEntryToolOutput(entry),
    outcome:
      entry.toolLifecycleStatus === "failed" ||
      entry.toolLifecycleStatus === "declined" ||
      entry.tone === "error"
        ? "failed"
        : entry.toolLifecycleStatus === "completed"
          ? "completed"
          : "unfinished",
  };
}

function summaryActionPriority(action: ToolGroupAction | StudioMcpToolSummaryAction): number {
  switch (action) {
    case "command":
    case "edit":
    case "delegate":
    case "task-cancel":
    case "thread-create":
    case "thread-send":
    case "thread-interrupt":
    case "thread-stop-all":
    case "thread-continue-all":
    case "thread-migrate":
    case "thread-continue-here":
    case "schedule-create":
    case "schedule-update":
    case "schedule-delete":
    case "schedule-run":
    case "thread-configure":
    case "thread-fork":
    case "thread-merge":
    case "thread-organize":
    case "thread-update":
    case "queue-edit":
    case "queue-cancel":
    case "queue-reorder":
    case "queue-steer":
    case "queue-resume":
    case "question-respond":
    case "worktree-handoff":
    case "project-create":
    case "project-update":
    case "project-delete":
    case "project-clone":
    case "environment-update":
    case "attachment-prepare":
    case "attachment-discard":
    case "attachment-send":
      return 0;
    case "other":
    case "update":
      return 2;
    default:
      return 1;
  }
}

/**
 * The app's own MCP server keeps its registered protocol name, "SpecWeave Studio"
 * (docs/studio/naming.md); people read the product name.
 */
export function displayToolSourceName(name: string): string {
  return /^specweave[\s_-]*studio$/i.test(name.trim()) ? "SpecWithCode" : name;
}

export interface ToolGroupSummary {
  readonly summary: string;
  /** `failedCount > 0`. */
  readonly hasFailure: boolean;
  /** Entries that failed by status, exit code or provider error, over every entry. */
  readonly failedCount: number;
  /** Entries only the output heuristic flags; shown faint, never added to failedCount. */
  readonly possibleFailureCount: number;
  readonly declinedCount: number;
}

/**
 * Summarizes at most two action categories; every omitted call still counts in the remainder.
 * The failure counts cover every entry, not only the summarized ones.
 */
export function summarizeToolGroup(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummary {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary: entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
      failedCount: 0,
      possibleFailureCount: 0,
      declinedCount: 0,
    };
  }
  entries = toolEntries;
  let failedCount = 0;
  let possibleFailureCount = 0;
  let declinedCount = 0;
  for (const entry of entries) {
    const kind = workEntryFailureKind(entry);
    if (kind === "failed") failedCount += 1;
    else if (kind === "possible") possibleFailureCount += 1;
    else if (kind === "declined") declinedCount += 1;
  }
  const groups = new Map<
    ToolGroupAction | StudioMcpToolSummaryAction,
    {
      action: ToolGroupAction;
      studioAction: StudioMcpToolSummaryAction | null;
      entries: WorkLogPresentationEntry[];
    }
  >();
  const sources = new Map<string, ToolActivitySource>();
  for (const entry of entries) {
    const studioAction =
      resolveStudioMcpToolDefinition(workEntryToolName(entry))?.summaryAction ?? null;
    if (entry.toolSource && studioAction === null) {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const key = studioAction ?? action;
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { action, studioAction, entries: [entry] });
  }
  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.entries.length,
    priority: summaryActionPriority(action),
    ...(group.studioAction
      ? summarizeStudioToolCalls(group.studioAction, group.entries.map(studioToolSummaryCall))
      : {
          label: toolGroupActionLabel(
            group.action,
            toolGroupActionCount(group.action, group.entries),
          ),
        }),
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = sourceValues.map((source) => displayToolSourceName(source.name));
    const formattedNames =
      sourceNames.length < 2
        ? sourceNames[0]!
        : sourceNames.length === 2
          ? sourceNames.join(" and ")
          : `${sourceNames.slice(0, -1).join(", ")}, and ${sourceNames.at(-1)}`;
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `Used ${formattedNames}${allIntegrations ? ` ${sources.size === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const sourcedCount = entries.filter(
    (entry) =>
      entry.toolSource !== undefined &&
      resolveStudioMcpToolDefinition(workEntryToolName(entry)) === null,
  ).length;
  const remainingCount =
    entries.length - sourcedCount - selected.reduce((count, group) => count + group.count, 0);
  if (remainingCount > 0) {
    labels.push(`Performed ${remainingCount} other ${remainingCount === 1 ? "action" : "actions"}`);
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary =
    sentenceLabels.length < 3
      ? sentenceLabels.join(" and ")
      : `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
  return {
    summary,
    hasFailure: failedCount > 0,
    failedCount,
    possibleFailureCount,
    declinedCount,
  };
}

/** The noun a compact chip counts for one kind of action: "88 commands", "94 thread updates". */
function compactActionNoun(
  action: ToolGroupAction | StudioMcpToolSummaryAction,
): readonly [string, string] {
  switch (action) {
    case "command":
      return ["command", "commands"];
    case "edit":
      return ["file changed", "files changed"];
    case "read":
      return ["file read", "files read"];
    case "search":
      return ["web search", "web searches"];
    case "code-search":
      return ["code search", "code searches"];
    case "browser":
      return ["browser step", "browser steps"];
    case "device":
      return ["device step", "device steps"];
    case "link-pr":
    case "unlink-pr":
    case "watch-pr":
    case "unwatch-pr":
    case "list-prs":
      return ["pull request check", "pull request checks"];
    case "update":
      return ["update", "updates"];
    case "other":
      return ["tool call", "tool calls"];
    case "delegate":
      return ["delegation", "delegations"];
    case "thread-create":
      return ["thread started", "threads started"];
    case "knowledge-search":
      return ["knowledge search", "knowledge searches"];
    case "knowledge-read":
      return ["knowledge read", "knowledge reads"];
    case "thread-list":
    case "thread-read":
    case "thread-search":
    case "thread-wait":
    case "thread-transfers":
    case "thread-configuration":
    case "task-status":
      return ["thread check", "thread checks"];
    default:
      if (action.startsWith("thread-")) return ["thread update", "thread updates"];
      if (action.startsWith("queue-")) return ["queue update", "queue updates"];
      if (action.startsWith("schedule-")) return ["schedule update", "schedule updates"];
      if (action.startsWith("project-")) return ["project update", "project updates"];
      return ["SpecWithCode action", "SpecWithCode actions"];
  }
}

/**
 * The same work as summarizeToolGroup, as at most `limit` short counts, largest first:
 * ["88 commands", "94 thread updates"]. The sentence stays available as the full text.
 */
export function summarizeToolGroupChips(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
  limit = 2,
): string[] {
  const counts = new Map<
    string,
    { count: number; nouns: readonly [string, string]; index: number }
  >();
  const add = (key: string, nouns: readonly [string, string], amount = 1) => {
    const current = counts.get(key);
    if (current) current.count += amount;
    else counts.set(key, { count: amount, nouns, index: counts.size });
  };
  for (const entry of entries) {
    if (entry.itemType === "reasoning") continue;
    const studioAction =
      resolveStudioMcpToolDefinition(workEntryToolName(entry))?.summaryAction ?? null;
    if (entry.toolSource && studioAction === null) {
      const name = displayToolSourceName(entry.toolSource.name);
      add(`source:${entry.toolSource.key}`, [`${name} call`, `${name} calls`]);
      continue;
    }
    const action = studioAction ?? toolGroupAction(entry);
    const nouns = compactActionNoun(action);
    // Chips that read the same ("thread updates") add up, whatever tool made them.
    add(nouns[1], nouns, action === "edit" ? toolGroupActionCount("edit", [entry]) : 1);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, limit)
    .map(({ count, nouns }) => `${count} ${count === 1 ? nouns[0] : nouns[1]}`);
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) return "reasoning";
  entries = toolEntries;
  if (
    entries.length > 0 &&
    entries.every((entry) => resolveWorkEntryToolPresentation(entry)?.icon === "pull-request")
  )
    return "pull-request";
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";
  const action = actions.values().next().value!;
  if (action !== "other") return action;
  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "dynamic_tool") return "dynamic-tool";
      if (entry.itemType === "subagent") return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}

export interface PathRoots {
  /** The checkpoint's stamped repository root. */
  readonly repoRoot?: string | null | undefined;
  /** The thread's current workspace root, used when repoRoot is unknown (old checkpoints). */
  readonly workspaceRoot?: string | null | undefined;
}

interface AbsolutePath {
  readonly windows: boolean;
  readonly segments: ReadonlyArray<string>;
}

function isAbsoluteProviderPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^~(?:[\\/]|$)/.test(path) ||
    isWindowsAbsolutePath(path) ||
    /^[a-zA-Z]:/.test(path)
  );
}

/** Applies `.` and `..`; null when `..` climbs above the first segment. */
function resolvePathSegments(parts: ReadonlyArray<string>): string[] | null {
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments;
}

function absolutePath(value: string | null | undefined): AbsolutePath | null {
  const path = value?.trim();
  if (!path || !isAbsoluteProviderPath(path) || /^~/.test(path)) return null;
  const windows = isWindowsAbsolutePath(path) || /^[a-zA-Z]:/.test(path);
  const segments = resolvePathSegments(windows ? path.split(/[\\/]+/) : path.split("/"));
  return segments ? { windows, segments } : null;
}

/** The segments of `path` below `root`, empty when they are the same folder. */
function segmentsWithin(path: AbsolutePath, root: AbsolutePath): ReadonlyArray<string> | null {
  if (path.windows !== root.windows || path.segments.length < root.segments.length) return null;
  const same = root.segments.every((segment, index) => {
    const candidate = path.segments[index]!;
    return root.windows ? candidate.toLowerCase() === segment.toLowerCase() : candidate === segment;
  });
  return same ? path.segments.slice(root.segments.length) : null;
}

interface RelativizedPath {
  readonly path: string;
  /** Relative to the stamped repository root; otherwise only a suffix of the real path. */
  readonly exact: boolean;
  readonly caseInsensitive: boolean;
}

function relativizePath(path: string, roots: PathRoots): RelativizedPath | null {
  const value = path.trim();
  if (!value) return null;
  const repoRoot = absolutePath(roots.repoRoot);
  const workspaceRoot = absolutePath(roots.workspaceRoot);
  const root = repoRoot ?? workspaceRoot;
  const caseInsensitive = root?.windows ?? false;
  if (isAbsoluteProviderPath(value)) {
    const target = absolutePath(value);
    const segments = target && root ? segmentsWithin(target, root) : null;
    return segments && segments.length > 0
      ? { path: segments.join("/"), exact: repoRoot !== null, caseInsensitive }
      : null;
  }
  // A relative provider path is relative to the thread's folder.
  const base = repoRoot && workspaceRoot ? segmentsWithin(workspaceRoot, repoRoot) : null;
  const segments = resolvePathSegments([...(base ?? []), ...value.split(/[\\/]+/)]);
  return segments && segments.length > 0
    ? { path: segments.join("/"), exact: base !== null, caseInsensitive }
    : null;
}

/** A provider path in repository-relative form, or null when it lies outside the root. */
export function repoRelativePath(path: string, roots: PathRoots): string | null {
  return relativizePath(path, roots)?.path ?? null;
}

export interface DiffPathMatch {
  readonly path: string;
  /** "file_name" when only a unique suffix matched; label it "Matched by file name". */
  readonly matchedBy: "exact" | "file_name";
}

/**
 * The candidate (repo-relative) path a link names: exact first, then a unique suffix, else null.
 * A path relativized against the stamped repository root matches only exactly, so a file
 * missing from the patch is reported as missing instead of revealing a namesake. The suffix
 * step serves old checkpoints, whose paths are relative to the workspace root, which can be
 * a subfolder of the repository. It never picks the longest of several suffix matches.
 */
export function matchDiffPath(
  path: string,
  candidates: ReadonlyArray<string>,
  roots: PathRoots,
): DiffPathMatch | null {
  const target = relativizePath(path, roots);
  if (!target) return null;
  const key = (value: string) => (target.caseInsensitive ? value.toLowerCase() : value);
  const wanted = key(target.path);
  const keyed = candidates.flatMap((candidate) => {
    const segments = resolvePathSegments(candidate.trim().split(/[\\/]+/));
    return segments && segments.length > 0 ? [{ candidate, key: key(segments.join("/")) }] : [];
  });
  const exact = keyed.find((entry) => entry.key === wanted);
  if (exact) return { path: exact.candidate, matchedBy: "exact" };
  if (target.exact) return null;
  const suffixMatches = keyed.filter((entry) => entry.key.endsWith(`/${wanted}`));
  const first = suffixMatches[0];
  return first && suffixMatches.every((entry) => entry.key === first.key)
    ? { path: first.candidate, matchedBy: "file_name" }
    : null;
}

/** Every path an edit item names: fileName, each change path and oldPath. */
export function fileChangeItemPaths(item: OrchestrationV2TurnItem): ReadonlyArray<string> {
  if (item.type !== "file_change") return [];
  const paths = new Set([item.fileName]);
  for (const change of item.changes ?? []) {
    paths.add(change.path);
    if (change.oldPath) paths.add(change.oldPath);
  }
  return [...paths];
}

/** Failed, declined and cancelled edits did not do their work, so they never account for a file. */
function editItemSucceeded(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "file_change" &&
    item.status !== "failed" &&
    item.status !== "cancelled" &&
    item.declined !== true
  );
}

function filesNamedByEdits(
  files: ReadonlyArray<string>,
  editItems: ReadonlyArray<OrchestrationV2TurnItem>,
  roots: PathRoots,
): ReadonlySet<string> {
  const named = new Set<string>();
  for (const item of editItems) {
    if (!editItemSucceeded(item)) continue;
    for (const path of fileChangeItemPaths(item)) {
      const match = matchDiffPath(path, files, roots);
      if (match) named.add(match.path);
    }
  }
  return named;
}

export interface ChangedFilesAttribution {
  /** Checkpoint files no successful edit item names (AC-07). */
  readonly notReported: ReadonlyArray<string>;
  /** Files named by a loaded subagent's edit items (AC-19). */
  readonly bySubagent: ReadonlyArray<{
    readonly title: string;
    readonly files: ReadonlyArray<string>;
  }>;
  /** Titles of this run's subagents whose items are not loaded; the not-reported label names them. */
  readonly unloadedSubagentTitles: ReadonlyArray<string>;
}

/**
 * Splits a turn's checkpoint files by who reported them. A file no successful edit item of
 * the turn or of a loaded subagent names stays not reported: a command, another tool, another
 * agent in the same checkout, or a subagent whose items are not loaded changed it.
 */
export function filesChangedOutsideEditItems(input: {
  readonly files: ReadonlyArray<string>;
  readonly editItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly subagents?: ReadonlyArray<{
    readonly title: string;
    readonly loaded: boolean;
    readonly editItems: ReadonlyArray<OrchestrationV2TurnItem>;
  }>;
  readonly roots: PathRoots;
}): ChangedFilesAttribution {
  const files = [...new Set(input.files)];
  const attributed = new Set(filesNamedByEdits(files, input.editItems, input.roots));
  const bySubagent: Array<{ title: string; files: ReadonlyArray<string> }> = [];
  const unloadedSubagentTitles: string[] = [];
  for (const subagent of input.subagents ?? []) {
    if (!subagent.loaded) {
      if (!unloadedSubagentTitles.includes(subagent.title)) {
        unloadedSubagentTitles.push(subagent.title);
      }
      continue;
    }
    const named = filesNamedByEdits(files, subagent.editItems, input.roots);
    const listed = files.filter((file) => named.has(file));
    if (listed.length === 0) continue;
    for (const file of listed) attributed.add(file);
    bySubagent.push({ title: subagent.title, files: listed });
  }
  return {
    notReported: files.filter((file) => !attributed.has(file)),
    bySubagent,
    unloadedSubagentTitles,
  };
}

/** A subagent's title, else the first line of its prompt. */
function subagentTitle(subagent: OrchestrationV2Subagent): string {
  return (
    subagent.title?.trim() ||
    subagent.prompt
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ||
    "Subagent"
  );
}

/** For a provider-native subagent's child thread: where its edits' Open diff goes (AC-19). */
export function subagentDiffTarget(input: {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly parentSubagents: ReadonlyArray<OrchestrationV2Subagent> | null;
}): {
  readonly parentThreadId: ThreadId;
  readonly runId: RunId | null;
  readonly title: string;
  readonly origin: "provider_native" | "app_owned";
  readonly running: boolean;
} | null {
  if (input.parentThreadId === null) return null;
  if (input.parentSubagents === null) {
    // The parent projection is not loaded, so the launching run, title and origin
    // are not known yet; load the parent before routing a link through this.
    return {
      parentThreadId: input.parentThreadId,
      runId: null,
      title: "Subagent",
      origin: "provider_native",
      running: false,
    };
  }
  const subagent = input.parentSubagents.findLast(
    (candidate) => candidate.childThreadId === input.childThreadId,
  );
  if (!subagent) return null;
  return {
    parentThreadId: input.parentThreadId,
    runId: subagent.runId,
    title: subagentTitle(subagent),
    origin: subagent.origin,
    running: isOrchestrationV2WorkActive(subagent.status),
  };
}

export type TurnDiffState =
  | { readonly kind: "available"; readonly turnCount: number; readonly fromBaseline: boolean }
  | { readonly kind: "running" }
  | { readonly kind: "snapshot_error" }
  | { readonly kind: "snapshot_missing" }
  | { readonly kind: "snapshot_stale" }
  | { readonly kind: "not_git" }
  | { readonly kind: "failed_no_snapshot" }
  | { readonly kind: "unknown" };

const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "pending",
  "running",
  "waiting",
]);

/** Run outcomes whose ready checkpoint the server diffs. */
const DIFFABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "cancelled",
]);

/**
 * Which diff, if any, Open diff can show for a run (AC-05). Never another run's. Rows
 * disable Open diff only while the run is live; every other state opens the panel, which
 * shows `turnDiffStateMessage` instead of a diff. The base of the diff (the previous run's
 * checkpoint or the scope snapshot one ordinal earlier) is resolved by the server, so
 * `fromBaseline` is always false here.
 */
export function turnDiffState(input: {
  readonly runId: RunId;
  readonly runs: ReadonlyArray<{ readonly id: RunId; readonly status: string }>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
}): TurnDiffState {
  const run = input.runs.find((candidate) => candidate.id === input.runId);
  if (!run) return { kind: "unknown" };
  if (LIVE_RUN_STATUSES.has(run.status)) return { kind: "running" };
  const checkpoints = input.checkpoints.filter((checkpoint) => checkpoint.runId === input.runId);
  const ready = checkpoints.find((checkpoint) => checkpoint.status === "ready");
  if (ready) {
    return DIFFABLE_RUN_STATUSES.has(run.status)
      ? { kind: "available", turnCount: ready.checkpointTurnCount, fromBaseline: false }
      : { kind: "unknown" };
  }
  const checkpoint = checkpoints[0];
  if (!checkpoint)
    return run.status === "failed" ? { kind: "failed_no_snapshot" } : { kind: "unknown" };
  if (checkpoint.notGitRepository === true) return { kind: "not_git" };
  switch (checkpoint.status) {
    case "error":
      return { kind: "snapshot_error" };
    case "stale":
      return { kind: "snapshot_stale" };
    case "missing":
      return { kind: "snapshot_missing" };
  }
  return { kind: "unknown" };
}

/** The AC-05 text for a state, or null when the diff is available. */
export function turnDiffStateMessage(state: TurnDiffState): string | null {
  switch (state.kind) {
    case "available":
      return null;
    case "running":
      return "Diff available when the turn ends";
    case "snapshot_error":
      return "No diff: this turn's snapshot failed";
    case "snapshot_missing":
      return "No diff: this turn's snapshot is missing";
    case "snapshot_stale":
      return "No diff: this turn's snapshot is out of date";
    case "not_git":
      return "No diff: this folder is not a Git repository";
    case "failed_no_snapshot":
      return "No diff: this turn ended with an error before a snapshot was taken";
    case "unknown":
      return "No diff recorded for this turn";
  }
}
