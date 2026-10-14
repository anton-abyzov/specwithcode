/**
 * An opened thread's header, as in the Claude desktop app: one title row with
 * a "Threads ›" breadcrumb back, the title with model, pull request and
 * subagent chips, then a Resolve button, the thread's action menu, expand and
 * close. It takes the place of the panel's tab bar, in the same title row.
 */
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { resolveThreadCurrentPullRequestLink } from "@specweave-studio/shared/threadPullRequests";
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  EllipsisIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { isElectron } from "../../../env";

import { useThreadActionMenu } from "../../../hooks/useThreadActionMenu";
import { cn } from "../../../lib/utils";
import { threadEnvironment } from "../../../state/threads";
import { useOrchestrationCommand } from "../../../state/use-orchestration-command";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { toastManager } from "../../ui/toast";
import { ModelBadge } from "./ModelBadge";
import { Tip } from "./Tip";

export function ProjectThreadHeader(props: {
  thread: EnvironmentThreadShell;
  /** Subagents this thread started, for the chip beside the title. */
  subagentCount: number;
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
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: props.projectCwd,
    onStartRename: () => {
      if (props.canChange) setRenaming(thread.title);
    },
  });
  const menuButton = useRef<HTMLButtonElement>(null);
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
          <span aria-hidden>Threads</span>
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
          <h2 onDoubleClick={() => props.canChange && setRenaming(thread.title)}>
            {thread.title || "Untitled thread"}
          </h2>
        )}
        <span className="sws-thread-head-chips">
          <ModelBadge
            entry={props.providerEntry}
            instanceId={thread.modelSelection.instanceId}
            model={thread.modelSelection.model}
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
          {props.subagentCount > 0 ? (
            <span className="sws-chip">
              <BotIcon aria-hidden />
              {props.subagentCount}
              <span className="sr-only">
                {" "}
                {props.subagentCount === 1 ? "subagent" : "subagents"}
              </span>
            </span>
          ) : null}
        </span>
      </div>
      {settled || archived ? <span className="sws-chip" role="status">Resolved</span> : null}
      <span ref={props.toolsSlotRef} className="sws-thread-head-tools" />
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
          <span>{resolveLabel}</span>
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
            if (rect) openMenu({ x: rect.left, y: rect.bottom + 4 });
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
