/**
 * A subagent's transcript, read-only, sliding over its parent thread. It is not
 * a thread: there is no composer, no resolve and no list entry. Esc or the close
 * button returns to the parent.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { ArrowLeftIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { SelectedThreadShell } from "../../../state/selectedThreadShell";
import {
  subagentEntryLabel,
  subagentStatusTone,
  type SubagentEntry,
} from "../../../studio/threadSubagents";
import { AgentElapsed } from "../../chat/AgentElapsed";
import ChatView from "../../ChatView";
import { ModelBadge, useProviderEntriesByEnvironment } from "./ModelBadge";
import { RoutingDecisionChip } from "./RoutingDecisionChip";
import { Tip } from "./Tip";

export function SubagentPeek(props: {
  readonly thread: EnvironmentThreadShell;
  readonly entry: SubagentEntry | null;
  readonly parentTitle: string;
  readonly onClose: () => void;
}) {
  const { thread, entry, onClose } = props;
  const providerEntries = useProviderEntriesByEnvironment().get(thread.environmentId);
  const instanceId = entry?.providerInstanceId ?? thread.modelSelection.instanceId;
  const model = entry?.model ?? thread.modelSelection.model;
  const status = entry?.status ?? null;
  const tone = status ? subagentStatusTone(status) : "idle";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <section
      className="sws-subagent-peek"
      role="dialog"
      aria-modal="false"
      aria-label={`Subagent ${thread.title}`}
      data-subagent-peek={thread.id}
    >
      <header className="sws-subagent-peek-head">
        <Tip label={`Back to ${props.parentTitle}`}>
          <button
            type="button"
            className="sws-icon-button"
            aria-label={`Back to ${props.parentTitle}`}
            onClick={onClose}
          >
            <ArrowLeftIcon aria-hidden />
          </button>
        </Tip>
        <div className="sws-subagent-peek-text">
          <h3>{entry?.title ?? thread.title}</h3>
          <span className="sws-subagent-meta">
            <span className="sws-subagent-kind">
              {entry?.origin === "app_owned" ? "Delegated task" : "Subagent"} of {props.parentTitle}
            </span>
            {entry && status ? (
              <span className="sws-subagent-status" data-tone={tone}>
                <span className="sws-dot" data-tone={tone} aria-hidden />
                {subagentEntryLabel(entry)}
              </span>
            ) : null}
            <ModelBadge
              entry={providerEntries?.get(instanceId) ?? null}
              instanceId={instanceId}
              model={model}
            />
            <RoutingDecisionChip routing={thread.routing} entries={providerEntries} projectId={thread.projectId} environmentId={thread.environmentId} />
            {entry?.startedAt && status ? (
              <AgentElapsed
                agent={{ status, startedAt: entry.startedAt, completedAt: entry.completedAt }}
              />
            ) : null}
          </span>
        </div>
        <Tip label="Close">
          <button
            type="button"
            className="sws-icon-button"
            aria-label="Close subagent"
            onClick={onClose}
          >
            <XIcon aria-hidden />
          </button>
        </Tip>
      </header>
      <div className="sws-subagent-peek-body project-native-thread">
        <SelectedThreadShell value={thread}>
          <ChatView
            key={`${thread.environmentId}:${thread.id}`}
            environmentId={thread.environmentId}
            threadId={thread.id}
            routeKind="server"
            layoutMode="embedded"
            transcriptOnly
            suspendShortcuts
            embeddedHeaderToolsTarget={null}
            reserveTitleBarControlInset={false}
          />
        </SelectedThreadShell>
      </div>
      {/* Subagents answer to the thread that started them; people talk only to threads. */}
      <footer className="sws-subagent-peek-note" role="note">
        Read-only. To change this work, reply in{" "}
        <button type="button" onClick={onClose}>
          {props.parentTitle}
        </button>
        .
      </footer>
    </section>
  );
}
