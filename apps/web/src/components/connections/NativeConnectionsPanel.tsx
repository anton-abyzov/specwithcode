import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { ConnectionMatrix } from "./ConnectionMatrix";

export function NativeConnectionsPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId | undefined;
}) {
  const permitted = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    permitted && connected
      ? projectWorkspace.nativeConnections({ environmentId, input: projectId ? { projectId } : {} })
      : null,
  );
  if (!connected)
    return (
      <p role="status" className="text-sm text-muted-foreground">
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Connections library</h2>
        <Button variant="outline" size="sm" disabled={query.isPending} onClick={query.refresh}>
          {query.isPending ? "Scanning…" : "Refresh configurations"}
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          Could not inspect connections. {query.error}
        </p>
      ) : query.data ? (
        <ConnectionMatrix snapshot={query.data} project={Boolean(projectId)} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Reading native configurations…
        </p>
      )}
    </div>
  );
}
