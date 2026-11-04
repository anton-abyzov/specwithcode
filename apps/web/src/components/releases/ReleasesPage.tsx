import { AuthOrchestrationReadScope, type EnvironmentId } from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ReleasesView } from "./ReleasesView";
import { useReleaseRuns } from "./useReleaseRuns";

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ReleaseRunsOf({ environmentId }: { environmentId: EnvironmentId }) {
  const { runs, skipped, loading, failed, refresh } = useReleaseRuns(environmentId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const now = useNow(1_000);
  return (
    <ReleasesView
      runs={runs}
      skipped={skipped}
      loading={loading}
      failed={failed}
      selectedRunId={selectedRunId}
      onSelectRun={setSelectedRunId}
      onRefresh={refresh}
      nowMs={now}
    />
  );
}

/** Releases: the stage graph of each release run on this machine and the machines it updated. */
export function ReleasesPage() {
  useEscapeToGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Releases breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Releases</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environmentId === null ? (
              <p className="text-muted-foreground text-sm">Connect to this Mac to see releases.</p>
            ) : !canRead ? (
              <p className="text-muted-foreground text-sm">
                This window may not read this machine's release runs.
              </p>
            ) : (
              <ReleaseRunsOf environmentId={environmentId} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
