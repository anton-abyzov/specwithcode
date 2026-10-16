import {
  AuthOrchestrationReadScope,
  WS_METHODS,
  type EnvironmentId,
  type StatusSnapshot,
} from "@specweave-studio/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { desktopUpdaterComponent, withLocalComponents } from "./statusModel";
import { StatusView } from "./StatusView";

const commands = {
  snapshot: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "status-page:snapshot",
    tag: WS_METHODS.statusPageSnapshot,
  }),
  refresh: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "status-page:refresh",
    tag: WS_METHODS.statusPageRefresh,
  }),
};

/** Re-reads the host's latest result; the host checks on its own schedule. */
const READ_INTERVAL_MS = 30_000;

async function readStatus(
  environmentId: EnvironmentId,
  kind: keyof typeof commands,
): Promise<StatusSnapshot> {
  const result = await runAtomCommand(
    appAtomRegistry,
    commands[kind],
    { environmentId, input: {} },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

function useStatusSnapshot(environmentId: EnvironmentId | null, canRead: boolean) {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requested = useRef(false);

  const load = useCallback(
    async (kind: keyof typeof commands) => {
      if (environmentId === null || !canRead) return;
      if (kind === "refresh") setRefreshing(true);
      try {
        const next = await readStatus(environmentId, kind);
        setSnapshot(next);
        setError(null);
        // Opening the page before the first background check runs one now.
        if (kind === "snapshot" && next.checkedAt === null && !requested.current) {
          requested.current = true;
          void load("refresh");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not read the status.");
      } finally {
        if (kind === "refresh") setRefreshing(false);
      }
    },
    [environmentId, canRead],
  );

  useEffect(() => {
    void load("snapshot");
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load("snapshot");
    }, READ_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return { snapshot, error, refreshing, refresh: () => void load("refresh") };
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function StatusPage() {
  useEscapeToGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const { snapshot, error, refreshing, refresh } = useStatusSnapshot(environmentId, canRead);
  const desktopUpdate = useDesktopUpdateState();
  const now = useNow(30_000);
  const merged = useMemo(
    () =>
      snapshot === null
        ? null
        : withLocalComponents(snapshot, desktopUpdaterComponent(desktopUpdate)),
    [snapshot, desktopUpdate],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Status breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Status</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environmentId === null ? (
              <p className="text-muted-foreground text-sm">Connect to this Mac to see status.</p>
            ) : !canRead ? (
              <p className="text-muted-foreground text-sm">
                This window may not read the host's status.
              </p>
            ) : (
              <StatusView
                snapshot={merged}
                now={now}
                refreshing={refreshing}
                error={error}
                onRefresh={refresh}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
