/**
 * An opened thread's header, as in the Claude desktop app: one title row with
 * a "Threads ›" breadcrumb back, the title with model, pull request and
 * subagent chips, then a Resolve button, the thread's action menu, expand and
 * close. It takes the place of the panel's tab bar, in the same title row.
 *
 * The title outranks the controls: as the panel narrows, the chips give way
 * first, then the chat's panel toggles fold into the action menu and Resolve
 * drops its label, so the title stays readable; hovering it shows it whole.
 * A coordinator names its workers, so their titles are read-only here.
 */
import { ThreadArtifactsMenu } from "../../chat/ThreadArtifacts";
import { TimelineDetailMenu } from "../../chat/TimelineDetailMenu";
import { scopedThreadKey, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { resolveThreadCurrentPullRequestLink } from "@specweave-studio/shared/threadPullRequests";
import type { ThreadId } from "@specweave-studio/contracts";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  EllipsisIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { isElectron } from "../../../env";

import {
  useThreadActionMenu,
  type ThreadMenuOverflowItem,
} from "../../../hooks/useThreadActionMenu";
import { cn } from "../../../lib/utils";
import { threadEnvironment } from "../../../state/threads";
import { useOrchestrationCommand } from "../../../state/use-orchestration-command";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { toastManager } from "../../ui/toast";
import type { SubagentEntry } from "../../../studio/threadSubagents";
import { isCoordinatorNamedThread, threadTitleTip } from "../../../studio/threadTitles";
import { ModelBadge, ThreadModelBadge, useProviderEntries } from "./ModelBadge";
import { RoutingDecisionChip } from "./RoutingDecisionChip";
import { SubagentsChip } from "./SubagentsChip";
import { Tip } from "./Tip";
import { HandoffThreadHeaderBadge } from "../../handoff/HandoffBadge";
import { useOpenThread } from "../../../hooks/useOpenThread";
import { usePrimaryEnvironmentId } from "../../../state/environments";

const FOLDED_CONTROL_ICONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/thread details/i, "square-menu"],
  [/terminal/i, "panel-bottom"],
  [/right panel/i, "panel-right"],
  [/maximize|restore/i, "maximize"],
];

/**
 * The chat's panel toggles, as action-menu items, while the narrow header
 * hides their slot. Each item clicks the hidden toggle, so its state and
 * shortcut handling stay in the chat that owns it.
 */
export function foldedHeaderControls(slot: HTMLElement | null): ThreadMenuOverflowItem[] {
  if (!slot || slot.childElementCount === 0 || getComputedStyle(slot).display !== "none") {
    return [];
  }
  return [...slot.querySelectorAll<HTMLButtonElement>("button[aria-label]")].map((button) => {
    const ariaLabel = button.getAttribute("aria-label") ?? "";
    const pressed = button.getAttribute("aria-pressed");
    // "Toggle terminal drawer" reads as "Show terminal drawer" or "Hide …" in a menu.
    const label =
      ariaLabel.startsWith("Toggle ") && pressed !== null
        ? `${pressed === "true" ? "Hide" : "Show"} ${ariaLabel.slice("Toggle ".length)}`
        : ariaLabel.charAt(0).toUpperCase() + ariaLabel.slice(1);
    const icon = FOLDED_CONTROL_ICONS.find(([pattern]) => pattern.test(ariaLabel))?.[1];
    return {
      label,
      ...(icon ? { icon } : {}),
      disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
      onSelect: () => button.click(),
    };
  });
}

export function ProjectThreadHeader(props: {
  thread: EnvironmentThreadShell;
  /** Subagents this thread started, for the chip and popover beside the title. */
  subagents: readonly SubagentEntry[];
  /** Opens a subagent's read-only transcript over this thread. */
  onPeekSubagent: (threadId: ThreadId) => void;
  providerEntry: Parameters<typeof ModelBadge>[0]["entry"];
  projectCwd: string;
  canChange: boolean;
  expanded: boolean;
  onBack: () => void;
  onToggleResolved: () => void;
  onToggleExpanded: () => void;
  onClose: () => void;
  onOpenPullRequest: (url: string) => void;
  /** Receives the slot where the embedded chat portals its terminal and details toggles. */
  toolsSlotRef?: (node: HTMLSpanElement | null) => void;
}) {
  const { thread } = props;
  const providerEntries = useProviderEntries(thread.environmentId);
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const headerProject = useMemo(
    () =>
      thread.projectId
        ? { environmentId: thread.environmentId, projectId: thread.projectId }
        : null,
    [thread.environmentId, thread.projectId],
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const titleLocked = isCoordinatorNamedThread(thread);
  const canRename = props.canChange && !titleLocked;
  const toolsSlot = useRef<HTMLSpanElement | null>(null);
  const { toolsSlotRef } = props;
  const setToolsSlot = useCallback(
    (node: HTMLSpanElement | null) => {
      toolsSlot.current = node;
      toolsSlotRef?.(node);
    },
    [toolsSlotRef],
  );
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: props.projectCwd,
    onStartRename: () => {
      if (canRename) setRenaming(thread.title);
    },
  });
  const menuButton = useRef<HTMLButtonElement>(null);
  const localEnvironmentId = usePrimaryEnvironmentId();
  const { openThread } = useOpenThread();
  const settled = thread.settledOverride === "settled";
  const archived = thread.archivedAt !== null;
  const resolveLabel = archived || settled ? "Reopen" : "Resolve";
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  const prState =
    link?.snapshot?.state === "open" && link.snapshot.isDraft
      ? "draft"
      : (link?.snapshot?.state ?? "open");
  const pr = link ? { ...PULL_REQUEST_STATE_PRESENTATION[prState], url: link.url } : null;

  const commitRename = (value: string) => {
    setRenaming(null);
    const title = value.trim();
    if (title.length === 0) {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (title === thread.title) return;
    void updateMetadata({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };

  return (
    <div className={cn("sws-pane-head sws-thread-head", isElectron && "drag-region")}>
      <Tip label="Back to threads (Esc)">
        <button
          type="button"
          className="sws-thread-crumb"
          aria-label="Back to project threads"
          onClick={props.onBack}
        >
          <ArrowLeftIcon aria-hidden className="sws-thread-crumb-back" />
          <span aria-hidden className="sws-thread-crumb-label">
            Threads
          </span>
        </button>
      </Tip>
      <ChevronRightIcon aria-hidden className="sws-thread-crumb-sep" />
      <div className="sws-thread-head-text">
        {renaming !== null ? (
          <input
            className="sws-thread-rename"
            aria-label="Thread title"
            autoFocus
            defaultValue={renaming}
            onBlur={(event) => commitRename(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") commitRename(event.currentTarget.value);
              else if (event.key === "Escape") {
                event.stopPropagation();
                setRenaming(null);
              }
            }}
          />
        ) : (
          <Tip label={threadTitleTip(thread)}>
            <h2
              data-title-locked={titleLocked ? "true" : undefined}
              onDoubleClick={canRename ? () => setRenaming(thread.title) : undefined}
            >
              {thread.title || "Untitled thread"}
            </h2>
          </Tip>
        )}
        <span className="sws-thread-head-chips">
          <ThreadModelBadge thread={thread} entries={providerEntries} variant="chip" focusable />
          <RoutingDecisionChip
            routing={thread.routing}
            entries={providerEntries}
            projectId={thread.projectId}
            environmentId={thread.environmentId}
          />
          {pr && link ? (
            <button
              type="button"
              className="sws-chip"
              data-state={prState}
              onClick={() => props.onOpenPullRequest(pr.url)}
            >
              <pr.Icon aria-hidden className={pr.toneClassName} />
              <span className="sr-only">Pull request </span>#{link.number}
              <span className="sr-only">, {pr.label}</span>
            </button>
          ) : null}
        </span>
        <HandoffThreadHeaderBadge
          environmentId={thread.environmentId}
          threadId={thread.id}
          localEnvironmentId={localEnvironmentId}
          canOperate={props.canChange}
          onOpenThread={(threadId, environmentId) =>
            void openThread(scopeThreadRef(environmentId, threadId))
          }
        />
        {/* Outside the chip row, which clips as the panel narrows: subagents stay reachable. */}
        <SubagentsChip
          environmentId={thread.environmentId}
          entries={props.subagents}
          onPeek={props.onPeekSubagent}
        />
      </div>
      {settled || archived ? (
        <span className="sws-chip" role="status">
          Resolved
        </span>
      ) : null}
      <ThreadArtifactsMenu threadRef={threadRef} cwd={thread.worktreePath ?? props.projectCwd} />
      <TimelineDetailMenu
        appearance="project"
        threadKey={scopedThreadKey(threadRef)}
        project={headerProject}
      />
      <span ref={setToolsSlot} className="sws-thread-head-tools" />
      <Tip label={`${resolveLabel} thread`}>
        <button
          type="button"
          className="sws-icon-button sws-thread-resolve"
          style={{ width: "auto", paddingInline: 8, gap: 5, flexShrink: 0 }}
          data-state={settled || archived ? "resolved" : "open"}
          aria-label={`${resolveLabel} thread`}
          disabled={!props.canChange}
          onClick={props.onToggleResolved}
        >
          {settled || archived ? <RotateCcwIcon aria-hidden /> : <CheckCircle2Icon aria-hidden />}
          <span className="sws-thread-resolve-label">{resolveLabel}</span>
        </button>
      </Tip>
      <Tip label="Thread actions">
        <button
          ref={menuButton}
          type="button"
          className="sws-icon-button"
          aria-label="Thread actions"
          aria-haspopup="menu"
          onClick={() => {
            const rect = menuButton.current?.getBoundingClientRect();
            if (rect) {
              openMenu(
                { x: rect.left, y: rect.bottom + 4 },
                foldedHeaderControls(toolsSlot.current),
              );
            }
          }}
        >
          <EllipsisIcon aria-hidden />
        </button>
      </Tip>
      <Tip label={props.expanded ? "Restore panel" : "Expand panel"}>
        <button
          type="button"
          className="sws-icon-button"
          aria-label={props.expanded ? "Restore panel" : "Expand panel"}
          aria-pressed={props.expanded}
          onClick={props.onToggleExpanded}
        >
          {props.expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
        </button>
      </Tip>
      <Tip label="Close">
        <button
          type="button"
          className="sws-icon-button"
          aria-label="Close thread pane"
          onClick={props.onClose}
        >
          <XIcon aria-hidden />
        </button>
      </Tip>
    </div>
  );
}
