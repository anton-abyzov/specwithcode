import { useState } from "react";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type NativeConnectionApplyInput,
  type ProjectId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironment } from "../../state/environments";
import { machineStatus } from "../../lib/machineStatus";
import { Button } from "../ui/button";
import { ConnectionMatrix } from "./ConnectionMatrix";
import { ComputerUseConnectionNote } from "../computerUse/ComputerUsePermissions";

export function NativeConnectionsPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId | undefined;
}) {
  const permitted = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  // Both hooks run every render: inside `&&` the second was skipped while write
  // access was missing, and the hook count change crashed Settings > Connections.
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canEdit = canWrite && canOperate;
  const apply = useAtomCommand(projectWorkspace.nativeConnectionApply);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    permitted && connected
      ? projectWorkspace.nativeConnections({ environmentId, input: projectId ? { projectId } : {} })
      : null,
  );
  async function applyChange(input: NativeConnectionApplyInput) {
    if (pendingId !== null) return;
    setPendingId(input.connectionId);
    setApplyError(null);
    try {
      const result = await apply({ environmentId, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setApplyError(
          cause instanceof Error ? cause.message : "The machine did not confirm the change.",
        );
      }
    } catch {
      setApplyError("The machine did not confirm the change. Refresh configurations to check.");
    } finally {
      setPendingId(null);
      query.refresh();
    }
  }
  if (!connected)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {environment ? `${machineStatus(environment.connection).text.replace(/…$/, "")}. ` : ""}
        Connect this machine to inspect its MCP configurations.
      </p>
    );
  if (!permitted)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Filesystem read access is required to inspect configurations on this machine.
      </p>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Connections library</h3>
        <Button variant="outline" size="xs" disabled={query.isPending} onClick={query.refresh}>
          {query.isPending ? "Scanning…" : "Refresh configurations"}
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          Could not inspect connections. {query.error}
        </p>
      ) : query.data ? (
        <>
          {applyError ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {applyError}
            </p>
          ) : null}
          <ConnectionMatrix
            snapshot={query.data}
            project={Boolean(projectId)}
            pendingId={pendingId}
            {...(canEdit ? { onApply: (input) => void applyChange(input) } : {})}
            computerUseNote={<ComputerUseConnectionNote environmentId={environmentId} />}
          />
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Reading native configurations…
        </p>
      )}
    </div>
  );
}
