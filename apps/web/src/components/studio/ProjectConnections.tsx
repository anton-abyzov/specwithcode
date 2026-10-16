import { NativeConnectionsPanel } from "../connections/NativeConnectionsPanel";
import { useEffect, useId, useRef, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProjectConnection,
  ProjectConnectionConfig,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { CharacterCount } from "../ui/character-count";

const empty: ProjectConnectionConfig = { name: "", command: "", args: [], envKeys: [] };
const configOf = (value: ProjectConnection): ProjectConnectionConfig => ({
  name: value.name,
  command: value.command,
  args: value.args,
  envKeys: value.envKeys,
});
const lines = (value: string) => value.split("\n").filter((line) => line.length > 0);
export function ProjectConnections({
  environmentId,
  projectId,
  disabled,
  admissionBlocked,
  onDirtyChange,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  disabled: boolean;
  admissionBlocked: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const countId = useId();
  const query = useEnvironmentQuery(
    projectWorkspace.connections({ environmentId, input: { projectId } }),
  );
  const save = useAtomCommand(projectWorkspace.connectionSave);
  const check = useAtomCommand(projectWorkspace.connectionCheck);
  const revoke = useAtomCommand(projectWorkspace.connectionRevoke);
  const [selected, setSelected] = useState<ProjectConnection | null>(null);
  const [config, setConfig] = useState<ProjectConnectionConfig>(empty);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [allowed, setAllowed] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const newId = useRef(randomUUID());
  const configDirty =
    JSON.stringify(config) !== JSON.stringify(selected ? configOf(selected) : empty);
  const dirty =
    configDirty || JSON.stringify(allowed) !== JSON.stringify(selected?.allowedTools ?? []);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const blocked = disabled || busy;
  const validEnvNames = config.envKeys.every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  function select(connection: ProjectConnection | null) {
    setSelected(connection);
    setConfig(connection ? configOf(connection) : empty);
    setArgsText(connection?.args.join("\n") ?? "");
    setEnvText(connection?.envKeys.join("\n") ?? "");
    setAllowed(connection?.allowedTools ?? []);
    setError(null);
    newId.current = randomUUID();
  }
  async function act(action: "save" | "check" | "revoke") {
    if (
      blocked ||
      inFlight.current ||
      (action === "check" && admissionBlocked) ||
      (action !== "save" && (!selected || dirty))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const target = {
        projectId,
        id: selected?.id ?? newId.current,
        expectedRevision: selected?.revision ?? null,
      };
      const result =
        action === "save"
          ? await save({
              environmentId,
              input: {
                ...target,
                config,
                allowedTools: configDirty || selected?.status === "revoked" ? [] : [...allowed],
              },
            })
          : await (action === "check" ? check : revoke)({
              environmentId,
              input: { ...target, expectedRevision: selected!.revision },
            });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error
            ? cause.message
            : "The host did not confirm this connection change. Your draft is preserved.",
        );
      } else {
        select(result.value);
        query.refresh();
      }
    } catch {
      setError(
        "Connection change not confirmed. Reload the saved status before retrying; your draft is preserved.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  const connections = query.data?.connections ?? [];
  return (
    <section className="project-settings-section project-environment-section">
      <NativeConnectionsPanel
        key={`${environmentId}:${projectId}`}
        environmentId={environmentId}
        projectId={projectId}
      />
      <h2>SpecWithCode-managed connections</h2>
      <p className="project-muted">
        Project-scoped tools run on this execution machine using its existing sign-in. Credentials
        and provider sessions are not copied between projects.
      </p>
      <p className="project-muted">
        The executable runs as the signed-in user on the selected machine. Tool grants are not an
        operating-system sandbox.
      </p>
      {admissionBlocked && (
        <p className="project-notice">
          Resume or restore this project before checking a connection. You can still edit or revoke
          it.
        </p>
      )}
      {query.error && <p role="alert">Connection status unavailable: {query.error}</p>}
      {error && (
        <p className="project-notice" role="alert">
          {error}
        </p>
      )}
      {connections.length === 0 && (
        <p className="project-muted">No external tools configured for this project.</p>
      )}
      <div className="project-actions">
        {connections.map((connection) => (
          <button
            className="project-control"
            key={connection.id}
            disabled={blocked || dirty}
            aria-pressed={selected?.id === connection.id}
            onClick={() => select(connection)}
          >
            {connection.name} ·{" "}
            {selected?.id === connection.id ? selected.status : connection.status}
          </button>
        ))}
        <button
          className="project-control"
          disabled={blocked || dirty}
          onClick={() => select(null)}
        >
          New connection
        </button>
      </div>
      <p className="project-muted">
        Configure a native MCP command, not a website URL. Saving does not launch it. Check starts
        the command on this machine to discover tools; it does not prove an external account is
        signed in.
      </p>
      <label>
        Connection name
        <input
          value={config.name}
          disabled={blocked}
          maxLength={240}
          aria-describedby={`${countId}-name`}
          onChange={(e) => setConfig({ ...config, name: e.target.value })}
        />
        <CharacterCount id={`${countId}-name`} value={config.name} max={240} />
      </label>
      <label>
        Executable command
        <input
          value={config.command}
          disabled={blocked}
          maxLength={1024}
          aria-describedby={`${countId}-command`}
          placeholder="/path/to/mcp-server"
          onChange={(e) => setConfig({ ...config, command: e.target.value })}
        />
        <CharacterCount id={`${countId}-command`} value={config.command} max={1024} />
      </label>
      <label>
        Arguments (one per line)
        <textarea
          rows={3}
          value={argsText}
          disabled={blocked}
          onChange={(e) => {
            setArgsText(e.target.value);
            setConfig({ ...config, args: lines(e.target.value) });
          }}
        />
      </label>
      <label>
        Host environment variable names (one per line)
        <textarea
          rows={2}
          value={envText}
          disabled={blocked}
          placeholder="VARIABLE_NAME"
          onChange={(e) => {
            setEnvText(e.target.value);
            setConfig({ ...config, envKeys: lines(e.target.value) });
          }}
        />
      </label>
      <p className="project-muted">
        Use names only. Do not paste passwords, tokens or environment values into this form.
        Arguments are passed literally; shell commands are not supported.
      </p>
      {!validEnvNames && (
        <p role="alert">Enter environment variable names only, without values or equals signs.</p>
      )}
      {selected && (
        <p role="status">
          Status: {selected.status}
          {selected.checkedAt
            ? ` · Checked ${new Date(selected.checkedAt).toLocaleString()}`
            : " · Not checked"}
        </p>
      )}
      {configDirty && selected && (
        <p className="project-notice">
          Changing the command clears its previous tool grants. Save, check, then choose tools
          again.
        </p>
      )}
      {selected?.tools.length ? (
        <fieldset disabled={blocked || configDirty || selected.status !== "ready"}>
          <legend>Allowed tools for this project</legend>
          <p className="project-muted">
            Only selected tools are available. Tool calls still require the normal SpecWithCode
            approval.
          </p>
          {selected.tools.map((tool) => (
            <label className="project-checkbox" key={tool.name}>
              <input
                type="checkbox"
                checked={allowed.includes(tool.name)}
                onChange={(e) =>
                  setAllowed(
                    e.target.checked
                      ? [...allowed, tool.name]
                      : allowed.filter((name) => name !== tool.name),
                  )
                }
              />
              <span>
                {tool.name}
                {tool.description && <small className="project-muted"> — {tool.description}</small>}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="project-actions">
        <button
          className="project-control project-primary"
          disabled={
            blocked ||
            (!dirty && selected?.status !== "revoked") ||
            !config.name.trim() ||
            !config.command.trim() ||
            !validEnvNames
          }
          onClick={() => void act("save")}
        >
          {selected?.status === "revoked" ? "Restore configuration" : "Save connection"}
        </button>
        <button
          className="project-control"
          disabled={
            blocked || admissionBlocked || !selected || dirty || selected.status === "revoked"
          }
          onClick={() => void act("check")}
        >
          Check and discover tools
        </button>
        <button
          className="project-control"
          disabled={blocked || !selected || dirty || selected.status === "revoked"}
          onClick={() => void act("revoke")}
        >
          Revoke connection
        </button>
        {dirty && (
          <button className="project-control" disabled={blocked} onClick={() => select(selected)}>
            Discard connection edits
          </button>
        )}
      </div>
    </section>
  );
}
