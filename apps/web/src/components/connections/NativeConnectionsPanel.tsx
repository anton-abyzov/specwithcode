import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
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
import { AddServerFlow } from "./AddServerFlow";
import { BuiltInToolsBlock } from "./BuiltInToolsBlock";
import { ServerList } from "./ServerList";
import {
  serverListRows,
  serverRowSteps,
  snapshotIncomplete,
  type ServerListRow,
  type ServerRowAction,
  type ServerRowStep,
} from "./serverRows";

/** What one tool's part of a list action came to, with the id that undoes it. */
interface RowResult {
  readonly tool: NativeTool;
  readonly action: ServerRowAction;
  readonly changeId: string | null;
  readonly state: "done" | "failed" | "undone";
}
const RESULT_TEXT: Record<ServerRowAction, string> = {
  disable: "Turned off",
  enable: "Turned on",
  remove: "Removed",
};

export function NativeConnectionsPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId | undefined;
}) {
  const tx = useTx();
  const permitted = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  // Both hooks run every render: inside `&&` the second was skipped while write
  // access was missing, and the hook count change crashed Settings > Machines.
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
  /** The by-hand form is open in place of the paste box and the catalog. */
  const [adding, setAdding] = useState(false);
  /** The server the guided add last put on this machine: its row says "Added". */
  const [addedName, setAddedName] = useState<string | null>(null);
  /** The plain list is the default; the matrix compares the same servers tool by tool. */
  const [view, setView] = useState<"list" | "compare">("list");
  /** A list action on a server several tools have: one review for all of its files. */
  const [batch, setBatch] = useState<{
    readonly name: string;
    readonly action: ServerRowAction;
    readonly steps: ReadonlyArray<ServerRowStep & { readonly change: NativeConnectionChange }>;
  } | null>(null);
  const [results, setResults] = useState<{
    readonly name: string;
    readonly rows: ReadonlyArray<RowResult>;
  } | null>(null);
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
    setResults(null);
    setBatch(null);
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
  /** Turn off, turn on or remove a server in every tool that has it. */
  async function act(row: ServerListRow, action: ServerRowAction) {
    if (pendingId !== null) return;
    const steps = serverRowSteps(row, action);
    if (steps.length === 0) return;
    setPendingId(`row:${row.name}`);
    setSaved(null);
    setResults(null);
    setProposal(null);
    const previewed: Array<ServerRowStep & { readonly change: NativeConnectionChange }> = [];
    for (const step of steps) {
      const result = await run({ ...step.input, preview: true });
      // Nothing was written yet, so one refused preview drops the whole action.
      if (!result?.change) {
        setPendingId(null);
        return;
      }
      previewed.push({ ...step, change: result.change });
    }
    setPendingId(null);
    setBatch({ name: row.name, action, steps: previewed });
  }
  async function confirmBatch() {
    if (!batch || pendingId !== null) return;
    setPendingId("confirm");
    const rows: RowResult[] = [];
    for (const step of batch.steps) {
      const result = await run(step.input);
      rows.push({
        tool: step.tool,
        action: batch.action,
        changeId: result?.change?.id ?? null,
        state: result ? "done" : "failed",
      });
    }
    setPendingId(null);
    setBatch(null);
    setResults({ name: batch.name, rows });
    query.refresh();
  }
  async function undoResult(index: number) {
    const row = results?.rows[index];
    if (!results || !row?.changeId || row.state !== "done" || pendingId !== null) return;
    setPendingId(`undo:${index}`);
    const result = await run({ action: "undo", changeId: row.changeId });
    setPendingId(null);
    // The row shows what the last apply did, so a used Undo reads "Undone" from then on.
    if (result)
      setResults({
        name: results.name,
        rows: results.rows.map((value, position) =>
          position === index ? { ...value, state: "undone" } : value,
        ),
      });
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
        {renderRich(tx("{value}Connect this machine to inspect its MCP configurations."), {
          value: environment
            ? `${machineStatus(environment.connection).text.replace(/…$/, "")}. `
            : "",
        })}
      </p>
    );
  if (!permitted)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {tx("Filesystem read access is required to inspect configurations on this machine.")}
      </p>
    );
  const machine = environment?.label ?? "";
  const rows = query.data ? serverListRows(query.data) : [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {tx(
          "MCP servers give your agents extra tools, like Higgsfield for video or Linear for issues.",
        )}
      </p>
      {projectId ? null : <BuiltInToolsBlock environmentId={environmentId} />}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium" data-testid="server-list-title">
            {tx("Your servers on {machine}", { machine })}
          </h3>
          <div className="flex flex-wrap gap-2">
            {query.data ? (
              <Button
                variant="outline"
                size="xs"
                aria-pressed={view === "compare"}
                onClick={() => setView(view === "compare" ? "list" : "compare")}
              >
                {tx("Compare by AI tool")}
              </Button>
            ) : null}
            <Button variant="outline" size="xs" disabled={query.isPending} onClick={query.refresh}>
              {query.isPending ? tx("Scanning…") : tx("Refresh configurations")}
            </Button>
          </div>
        </div>
        {query.error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {renderRich(tx("Could not inspect connections. {error}"), { error: query.error })}
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
                  {pendingId === "undo" ? tx("Undoing…") : tx("Undo")}
                </Button>
              </div>
            ) : null}
            {results ? (
              <div
                role="status"
                className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-sm"
                data-testid="server-row-results"
              >
                <p className="font-medium">{results.name}</p>
                <ul className="space-y-1.5">
                  {results.rows.map((row, index) => (
                    <li key={row.tool} className="flex flex-wrap items-center gap-2">
                      <span>
                        {toolLabels[row.tool]}:{" "}
                        {row.state === "failed"
                          ? tx("Not changed")
                          : row.state === "undone"
                            ? tx("Undone")
                            : tx(RESULT_TEXT[row.action])}
                      </span>
                      {row.state === "done" && row.changeId ? (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={pendingId !== null}
                          aria-label={`${tx("Undo")}: ${toolLabels[row.tool]}`}
                          onClick={() => void undoResult(index)}
                        >
                          {pendingId === `undo:${index}` ? tx("Undoing…") : tx("Undo")}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {batch ? (
              <ChangePreview
                change={{ preview: true, files: batch.steps.flatMap((step) => step.change.files) }}
                pending={pendingId === "confirm"}
                onConfirm={() => void confirmBatch()}
                onCancel={() => setBatch(null)}
              />
            ) : proposal && !adding ? (
              <ChangePreview
                change={proposal.change}
                pending={pendingId === "confirm"}
                onConfirm={() => void confirm()}
                onCancel={() => setProposal(null)}
              />
            ) : null}
            {view === "compare" ? (
              <ConnectionMatrix
                snapshot={query.data}
                project={Boolean(projectId)}
                pendingId={pendingId}
                manage={!legacy}
                {...(canEdit ? { onApply: (input) => void propose(input) } : {})}
                computerUseNote={<ComputerUseConnectionNote environmentId={environmentId} />}
              />
            ) : (
              <>
                {snapshotIncomplete(query.data) ? (
                  <p role="status" className="text-sm text-warning-foreground">
                    {tx(
                      "Some configuration files could not be read, so this list may be incomplete. “Compare by AI tool” shows which.",
                    )}
                  </p>
                ) : null}
                <ServerList
                  rows={rows}
                  machine={machine}
                  busy={pendingId !== null}
                  added={addedName}
                  emptyHint={
                    canEdit && !legacy
                      ? tx("Pick one below, or paste what the server's setup page gives you.")
                      : null
                  }
                  onAct={canEdit && !legacy ? (row, action) => void act(row, action) : undefined}
                />
              </>
            )}
            {canEdit ? (
              <section
                aria-labelledby="add-server-title"
                className="space-y-3"
                data-testid="add-server-section"
              >
                <h3 id="add-server-title" className="text-sm font-medium">
                  {tx("Add a server")}
                </h3>
                {legacy ? (
                  <div className="rounded-lg border border-border/60 px-3 py-2.5 text-sm">
                    <p className="font-medium">
                      {tx("Update SpecWithCode on {machine} to add servers from here.", {
                        machine,
                      })}
                    </p>
                    <p className="text-muted-foreground">
                      {tx(
                        "{machine} runs a version that cannot show you a change before it is written. After the update, this page shows the add box.",
                        { machine },
                      )}
                    </p>
                  </div>
                ) : adding && proposal ? (
                  <ChangePreview
                    change={proposal.change}
                    pending={pendingId === "confirm"}
                    onConfirm={() => void confirm()}
                    onCancel={() => setProposal(null)}
                  />
                ) : adding ? (
                  <ConnectionEditor
                    tools={addTools(query.data)}
                    pending={pendingId !== null}
                    onSubmit={(input) => void propose(input)}
                    onCancel={() => setAdding(false)}
                  />
                ) : (
                  <AddServerFlow
                    // A new machine starts a new add: nothing ticked carries over.
                    key={environmentId}
                    environmentId={environmentId}
                    machine={machine}
                    snapshot={query.data}
                    project={Boolean(projectId)}
                    onByHand={() => setAdding(true)}
                    onChanged={query.refresh}
                    onAdded={setAddedName}
                  />
                )}
              </section>
            ) : null}
            <details className="text-xs text-muted-foreground" data-testid="server-list-about">
              <summary className="cursor-pointer text-sm text-foreground">
                {tx("About this list: sources and limits")}
              </summary>
              <div className="space-y-1 pt-2">
                <p>
                  {tx(
                    "SpecWithCode reads each tool's own configuration files on {machine}. It cannot tell whether a server is signed in or running.",
                    { machine },
                  )}
                </p>
                {rows.length === 0 ? (
                  <p>{tx("No MCP declarations found in the inspected configuration files.")}</p>
                ) : null}
                <p>
                  {tx("Scanned {when}.", {
                    when: new Date(query.data.observedAt).toLocaleString(undefined, {
                      dateStyle: "long",
                      timeStyle: "short",
                    }),
                  })}
                </p>
              </div>
            </details>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {tx("Reading native configurations…")}
          </p>
        )}
      </div>
    </div>
  );
}
