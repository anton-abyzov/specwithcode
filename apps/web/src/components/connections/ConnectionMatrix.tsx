import { useState } from "react";
import type {
  NativeConnection,
  NativeConnectionApplyInput,
  NativeConnectionsSnapshot,
} from "@specweave-studio/contracts";
import { Button } from "../ui/button";
import "./connections.css";

const providers = ["codex", "claude"] as const;
const sourceNames: Record<string, string> = {
  "codex-user": "Codex user config.toml",
  "codex-project": "Project .codex/config.toml",
  "claude-user": "Claude user .claude.json",
  "claude-local": "Private project entry in .claude.json",
  "claude-project": "Project .mcp.json",
  "claude-user-settings": "Claude user settings.json",
  "claude-project-settings": "Project .claude/settings.json",
  "claude-local-settings": "Project .claude/settings.local.json",
};
const toolName = (provider: "codex" | "claude") => (provider === "codex" ? "Codex" : "Claude Code");
const sourceName = (id: string) => sourceNames[id] ?? "Native configuration";
const stateName = {
  configured: "Configured",
  disabled: "Disabled",
  invalid: "Invalid declaration",
};

/** Configuration evidence only: no cell claims native authentication, trust, or admission. */
export function ConnectionMatrix({
  snapshot,
  project = false,
  onApply,
  pendingId = null,
}: {
  snapshot: NativeConnectionsSnapshot;
  project?: boolean;
  /** Absent when this connection may not edit native configuration on the machine. */
  onApply?: (input: NativeConnectionApplyInput) => void;
  pendingId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const names = [...new Set(snapshot.connections.map((c) => c.name))].sort((a, b) =>
    a.localeCompare(b),
  );
  const selected = snapshot.connections.find((c) => c.id === selectedId);
  const issues = snapshot.sources.filter((s) => s.status !== "read" && s.status !== "missing");
  function cell(name: string, provider: "codex" | "claude") {
    const entries = snapshot.connections.filter((c) => c.name === name && c.provider === provider);
    const current = entries.find((c) => !c.shadowed);
    const incomplete = issues.some((s) => s.provider === provider) || snapshot.truncated;
    if (!current) {
      const other = incomplete
        ? undefined
        : snapshot.connections.find(
            (c) => c.name === name && c.provider !== provider && c.scope === "user" && !c.shadowed,
          );
      return (
        <div className="connection-cell" data-tone={incomplete ? "unknown" : "none"}>
          <span className="connection-status">
            <span aria-hidden className="connection-dot" />
            {incomplete ? "Unknown" : "Not found"}
          </span>
          {other ? addAction(other, provider) : null}
        </div>
      );
    }
    const isSelected = selected?.id === current.id;
    return (
      <div className="connection-cell" data-tone={current.state}>
        <button
          type="button"
          className="connection-status connection-status-button"
          aria-label={`${name} ${provider === "codex" ? "Codex" : "Claude Code"} details`}
          aria-pressed={isSelected}
          onClick={() => setSelectedId(isSelected ? null : current.id)}
        >
          <span aria-hidden className="connection-dot" />
          {stateName[current.state]}
          {incomplete ? " · incomplete scan" : ""}
        </button>
        <div className="connection-meta">
          {current.scope === "local"
            ? "Private project"
            : current.scope === "project"
              ? "Project"
              : "User"}{" "}
          · {current.transport}
        </div>
        {current.state === "disabled" ? enableAction(current) : null}
      </div>
    );
  }

  function actionButton(
    connection: NativeConnection,
    input: NativeConnectionApplyInput,
    label: string,
  ) {
    if (!onApply) return null;
    return (
      <Button
        variant="outline"
        size="xs"
        disabled={pendingId !== null}
        aria-label={`${label}: ${connection.name}`}
        onClick={() => onApply(input)}
      >
        {pendingId === connection.id ? "Saving…" : label}
      </Button>
    );
  }
  function enableAction(connection: NativeConnection) {
    if (connection.pluginProvided)
      return (
        <p className="text-xs text-muted-foreground">
          Codex runs this through its {connection.name} plugin, so this older entry can stay off.
        </p>
      );
    if (connection.provider === "claude")
      return <p className="text-xs text-muted-foreground">Turn it on with /mcp in Claude Code.</p>;
    if (connection.scope !== "user")
      return <p className="text-xs text-muted-foreground">Turn it on in the project config.</p>;
    return actionButton(connection, { action: "enable", connectionId: connection.id }, "Enable");
  }
  function addAction(source: NativeConnection, provider: "codex" | "claude") {
    if (source.state === "invalid") return null;
    if (!source.portable)
      return (
        <p className="text-xs text-muted-foreground">
          {source.pluginProvided
            ? `A ${toolName(source.provider)} feature; ${toolName(provider)} has no equivalent entry.`
            : `This ${toolName(source.provider)} declaration cannot run in ${toolName(provider)}.`}
        </p>
      );
    // Copy what runs today; a disabled entry is enabled first, where it is declared.
    if (source.state !== "configured") return null;
    return actionButton(
      source,
      { action: "copy", connectionId: source.id },
      `Add to ${toolName(provider)}`,
    );
  }
  const alternatives = selected
    ? snapshot.connections.filter(
        (c) => c.name === selected.name && c.provider === selected.provider && c.id !== selected.id,
      )
    : [];
  return (
    <div className="space-y-4" data-testid="connection-matrix">
      <p className="text-sm text-muted-foreground">
        {project
          ? "Project configuration includes user declarations and project overrides."
          : "User configurations on this execution machine."}{" "}
        Authentication and session availability are unverified.
      </p>
      {issues.length > 0 && (
        <div role="status" className="text-sm text-warning-foreground">
          Some sources could not be inspected:{" "}
          {issues.map((s) => `${sourceName(s.id)} (${s.status.replaceAll("_", " ")})`).join(", ")}.
          Results are incomplete.
        </div>
      )}
      {snapshot.truncated && (
        <p role="status" className="text-sm text-warning-foreground">
          Connection limit reached. Results are incomplete.
        </p>
      )}
      {names.length === 0 ? (
        <p role="status">
          {issues.length || snapshot.truncated
            ? "No declarations could be confirmed."
            : "No MCP declarations found in the inspected configuration files."}
        </p>
      ) : (
        <div className="connection-table-wrap">
          <table className="connection-table">
            <caption className="sr-only">Configured MCP connections by AI tool</caption>
            <colgroup>
              <col className="w-[38%]" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Connection</th>
                <th scope="col">Codex</th>
                <th scope="col">Claude Code</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => (
                <tr key={name} data-selected={selected?.name === name || undefined}>
                  <th scope="row">
                    <span className="connection-name" title={name}>
                      {name}
                    </span>
                  </th>
                  {providers.map((provider) => (
                    <td key={provider}>{cell(name, provider)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <div aria-live="polite" className="space-y-2 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">
              {selected.name} · {selected.provider === "codex" ? "Codex" : "Claude Code"}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
              Close details
            </Button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Source</dt>
            <dd>{sourceName(selected.sourceId)}</dd>
            <dt className="text-muted-foreground">Access owner</dt>
            <dd>{selected.provider === "codex" ? "Codex" : "Claude Code"} manages native access</dd>
            <dt className="text-muted-foreground">Session</dt>
            <dd>Not checked</dd>
            {alternatives.length > 0 && (
              <>
                <dt className="text-muted-foreground">Other declarations</dt>
                <dd>
                  {alternatives
                    .map((c) => `${sourceName(c.sourceId)}${c.shadowed ? " (overridden)" : ""}`)
                    .join(", ")}
                </dd>
              </>
            )}
          </dl>
          <p className="text-xs text-muted-foreground">
            Project trust, account permissions and runtime policy may prevent use. SpecWithCode
            project grants apply only to SpecWithCode-managed calls.
          </p>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Inspected sources and limits</summary>
        <ul className="mt-2 space-y-1">
          {snapshot.sources.map((s) => (
            <li key={s.id}>
              {sourceName(s.id)} · {s.status.replaceAll("_", " ")}
            </li>
          ))}
        </ul>
        <p className="mt-2">
          {project
            ? "Only the registered project root is inspected. "
            : "Select a project to inspect project overrides. "}
          Plugins, managed settings, ancestor configurations and alternate client profiles are not
          inventoried. Matching names do not prove matching servers or accounts.
        </p>
      </details>
      <p className="text-xs text-muted-foreground">
        Scanned {new Date(snapshot.observedAt).toLocaleString()} · Read-only discovery
      </p>
    </div>
  );
}
