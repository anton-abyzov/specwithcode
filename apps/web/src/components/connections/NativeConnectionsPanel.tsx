import { useState } from "react";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type NativeConnectionApplyInput,
  type NativeConnectionChange,
  type NativeConnectionsSnapshot,
  type NativeTool,
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
import { ConnectionMatrix, toolLabels } from "./ConnectionMatrix";
import { ChangePreview, ConnectionEditor } from "./ConnectionEditor";
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
  const [proposal, setProposal] = useState<{
    readonly input: NativeConnectionApplyInput;
    readonly change: NativeConnectionChange;
  } | null>(null);
  const [saved, setSaved] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  async function run(input: NativeConnectionApplyInput): Promise<NativeConnectionsSnapshot | null> {
    setApplyError(null);
    try {
      const result = await apply({ environmentId, input });
      if (result._tag === "Success") return result.value;
      const cause = squashAtomCommandFailure(result);
      setApplyError(
        cause instanceof Error ? cause.message : "The machine did not confirm the change.",
      );
    } catch {
      setApplyError("The machine did not confirm the change. Refresh configurations to check.");
    }
    return null;
  }
  /** Every write is previewed first: the machine reports the files and masked entries. */
  async function propose(input: NativeConnectionApplyInput) {
    if (pendingId !== null) return;
    if (legacy) {
      // An older machine ignores `preview` and would write at once, so it keeps the old direct edit.
      setPendingId(input.connectionId ?? input.action);
      await run(input);
      setPendingId(null);
      query.refresh();
      return;
    }
    setPendingId(input.connectionId ?? input.pluginKey ?? input.action);
    setSaved(null);
    const result = await run({ ...input, preview: true });
    setPendingId(null);
    if (result?.change) setProposal({ input, change: result.change });
  }
  async function confirm() {
    if (!proposal || pendingId !== null) return;
    setPendingId("confirm");
    const result = await run(proposal.input);
    setPendingId(null);
    if (result) {
      setProposal(null);
      setAdding(false);
      const files = result.change?.files.length ?? 0;
      if (result.change?.id)
        setSaved({
          id: result.change.id,
          text: `Saved to ${files} ${files === 1 ? "file" : "files"}.`,
        });
    }
    query.refresh();
  }
  async function undo() {
    if (!saved || pendingId !== null) return;
    setPendingId("undo");
    const result = await run({ action: "undo", changeId: saved.id });
    setPendingId(null);
    if (result) setSaved(null);
    query.refresh();
  }
  // Machines that predate managing servers report no plugin list.
  const legacy =
    query.data !== null && query.data !== undefined && query.data.plugins === undefined;
  /** Tools the Add form offers: Codex, Claude Code, and the others installed here. */
  const addTools = (data: NativeConnectionsSnapshot) =>
    (["codex", "claude"] as ReadonlyArray<NativeTool>)
      .concat((data.otherTools ?? []).filter((t) => t.status !== "missing").map((t) => t.tool))
      .map((tool) => ({ tool, label: toolLabels[tool] }));
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
        <div className="flex gap-2">
          {canEdit && query.data && !legacy && !adding ? (
            <Button variant="outline" size="xs" onClick={() => setAdding(true)}>
              Add server
            </Button>
          ) : null}
          <Button variant="outline" size="xs" disabled={query.isPending} onClick={query.refresh}>
            {query.isPending ? "Scanning…" : "Refresh configurations"}
          </Button>
        </div>
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
          {saved ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
              {saved.text}
              <Button variant="outline" size="xs" disabled={pendingId !== null} onClick={undo}>
                {pendingId === "undo" ? "Undoing…" : "Undo"}
              </Button>
            </div>
          ) : null}
          {proposal ? (
            <ChangePreview
              change={proposal.change}
              pending={pendingId === "confirm"}
              onConfirm={() => void confirm()}
              onCancel={() => setProposal(null)}
            />
          ) : adding && canEdit ? (
            <ConnectionEditor
              tools={addTools(query.data)}
              pending={pendingId !== null}
              onSubmit={(input) => void propose(input)}
              onCancel={() => setAdding(false)}
            />
          ) : null}
          <ConnectionMatrix
            snapshot={query.data}
            project={Boolean(projectId)}
            pendingId={pendingId}
            manage={!legacy}
            {...(canEdit ? { onApply: (input) => void propose(input) } : {})}
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
