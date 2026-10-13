import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import ChatView from "../ChatView";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../../studio/projectMessageRouting";

/** Native approvals, questions, plans and retry controls, inside the project's main pane. */
export function ProjectCoordinatorDetails({
  environmentId,
  threadId,
  routing,
  error,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  routing: ProjectMessageRouting;
  error?: string | null;
  onClose: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  const [tools, setTools] = useState<HTMLSpanElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement;
    back.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label="Coordinator review"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
        <button ref={back} type="button" className="project-control" onClick={onClose}>
          Back to coordinator
        </button>
        <span className="text-muted-foreground text-xs">Coordinator details</span>
        <span ref={setTools} className="flex items-center gap-1" />
      </div>
      {error ? (
        <p className="project-notice" role="alert">
          {error}
        </p>
      ) : null}
      <ProjectMessageRoutingContext value={routing}>
        <div className="project-native-thread min-h-0 flex-1">
          <ChatView
            environmentId={environmentId}
            threadId={threadId}
            routeKind="server"
            layoutMode="embedded"
            embeddedHeaderToolsTarget={tools}
            reserveTitleBarControlInset={false}
          />
        </div>
      </ProjectMessageRoutingContext>
    </section>
  );
}
