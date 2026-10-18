import { Fragment, useState, type ReactNode } from "react";
import type {
  NativeConnection,
  NativeConnectionApplyInput,
  NativeConnectionsSnapshot,
  NativeOtherTool,
  NativeOtherToolInventory,
  NativeTool,
} from "@specweave-studio/contracts";
import { Button } from "../ui/button";
import "./connections.css";

const providers = ["codex", "claude"] as const;
type Provider = (typeof providers)[number];
/** The name Codex gives its own computer-use helper entry. */
const COMPUTER_USE_CONNECTION = "computer-use";
const sourceNames: Record<string, string> = {
  "codex-user": "Codex user config.toml",
  "codex-project": "Project .codex/config.toml",
  "codex-plugins": "Codex plugins",
  "claude-user": "Claude user .claude.json",
  "claude-local": "Private project entry in .claude.json",
  "claude-all-projects": "Private project entries in .claude.json",
  "claude-project": "Project .mcp.json",
  "claude-plugins": "Claude Code plugins",
  "claude-user-settings": "Claude user settings.json",
  "claude-project-settings": "Project .claude/settings.json",
  "claude-local-settings": "Project .claude/settings.local.json",
};
const otherToolNames: Record<NativeOtherTool, string> = {
  "claude-desktop": "Claude Desktop",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  windsurf: "Windsurf",
};
const otherToolFiles: Record<NativeOtherTool, string> = {
  "claude-desktop": "claude_desktop_config.json",
  gemini: "~/.gemini/settings.json",
  copilot: "~/.copilot/mcp-config.json",
  cursor: "~/.cursor/mcp.json",
  opencode: "opencode.json",
  windsurf: "mcp_config.json",
};
export const toolLabels: Record<NativeTool, string> = {
  codex: "Codex",
  claude: "Claude Code",
  ...otherToolNames,
};
const toolName = (provider: Provider) => (provider === "codex" ? "Codex" : "Claude Code");
const sourceName = (id: string) => sourceNames[id] ?? "Native configuration";
const stateName = {
  configured: "Configured",
  disabled: "Disabled",
  invalid: "Invalid declaration",
};
/** Declared in a file the user edits, as opposed to a plugin or another project. */
const own = (c: NativeConnection) => c.plugin === undefined && c.project === undefined;
const groups = [
  { id: "own", title: "Your connections" },
  { id: "plugin", title: "From plugins" },
  { id: "project", title: "Private projects only" },
] as const;
type Group = (typeof groups)[number]["id"];

/** Configuration evidence only: no cell claims native authentication, trust, or admission. */
export function ConnectionMatrix({
  snapshot,
  project = false,
  onApply,
  pendingId = null,
  computerUseNote,
  manage = true,
}: {
  /** The machine supports the full edit set; an older one only enables and copies. */
  manage?: boolean;
  snapshot: NativeConnectionsSnapshot;
  project?: boolean;
  /**
   * Shown under a `computer-use` row: agents use SpecWithCode's own computer
   * use whatever Codex or Claude Code declare, so the note says what it needs.
   */
  computerUseNote?: ReactNode;
  /** Absent when this connection may not edit native configuration on the machine. */
  onApply?: (input: NativeConnectionApplyInput) => void;
  pendingId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A tool gets a column once its configuration exists on this machine.
  const others = (snapshot.otherTools ?? []).filter((t) => t.status !== "missing");
  const names = [
    ...new Set([
      ...snapshot.connections.map((c) => c.name),
      ...others.flatMap((t) => t.connections.map((c) => c.name)),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const groupOf = (name: string): Group => {
    const entries = snapshot.connections.filter((c) => c.name === name);
    if (entries.length === 0 || entries.some(own)) return "own";
    return entries.some((c) => c.plugin !== undefined) ? "plugin" : "project";
  };
  const rows = groups
    .map((group) => ({ ...group, names: names.filter((name) => groupOf(name) === group.id) }))
    .filter((group) => group.names.length > 0);
  const selected = snapshot.connections.find((c) => c.id === selectedId);
  const selectedOther = others
    .flatMap((t) => t.connections.map((c) => ({ ...c, tool: t.tool })))
    .find((c) => c.id === selectedId);
  const issues = snapshot.sources.filter((s) => s.status !== "read" && s.status !== "missing");
  const otherIssues = others.filter((t) => t.status !== "read");
  const counts = [
    ...providers.map((provider) => ({
      label: toolName(provider),
      count: new Set(snapshot.connections.filter((c) => c.provider === provider).map((c) => c.name))
        .size,
    })),
    ...others.map((t) => ({ label: otherToolNames[t.tool], count: t.connections.length })),
  ];
  /** The declaration the tool uses: its own file first, then a plugin, then a project. */
  function resolve(name: string, provider: Provider) {
    const entries = snapshot.connections.filter((c) => c.name === name && c.provider === provider);
    return {
      entries,
      found:
        entries.find((c) => own(c) && !c.shadowed) ??
        entries.find((c) => c.plugin !== undefined) ??
        entries.find((c) => c.project !== undefined),
    };
  }
  function meta(connection: NativeConnection, entries: ReadonlyArray<NativeConnection>) {
    if (connection.plugin !== undefined)
      return `Plugin ${connection.plugin} · ${connection.transport}`;
    if (connection.project !== undefined) {
      const more = entries.filter((c) => c.project !== undefined).length - 1;
      return `Private project ${connection.project}${more > 0 ? ` +${more}` : ""} · ${connection.transport}`;
    }
    const scope =
      connection.scope === "local"
        ? "Private project"
        : connection.scope === "project"
          ? "Project"
          : "User";
    return `${scope} · ${connection.transport}`;
  }
  function cell(name: string, provider: Provider) {
    const { entries, found } = resolve(name, provider);
    const incomplete = issues.some((s) => s.provider === provider) || snapshot.truncated;
    if (!found) {
      const other = incomplete
        ? undefined
        : snapshot.connections.find(
            (c) =>
              c.name === name &&
              c.provider !== provider &&
              c.scope === "user" &&
              own(c) &&
              !c.shadowed,
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
    const isSelected = selected?.id === found.id;
    return (
      <div className="connection-cell" data-tone={found.state}>
        <button
          type="button"
          className="connection-status connection-status-button"
          aria-label={`${name} ${toolName(provider)} details`}
          aria-pressed={isSelected}
          onClick={() => setSelectedId(isSelected ? null : found.id)}
        >
          <span aria-hidden className="connection-dot" />
          {stateName[found.state]}
          {incomplete ? " · incomplete scan" : ""}
        </button>
        <div className="connection-meta">{meta(found, entries)}</div>
        {found.state === "disabled" ? enableAction(found) : null}
      </div>
    );
  }
  function otherCell(name: string, inventory: NativeOtherToolInventory) {
    const found = inventory.connections.find((c) => c.name === name);
    if (!found) {
      const unknown = inventory.status !== "read" || snapshot.truncated;
      return (
        <div className="connection-cell" data-tone={unknown ? "unknown" : "none"}>
          <span className="connection-status">
            <span aria-hidden className="connection-dot" />
            {unknown ? "Unknown" : "Not found"}
          </span>
        </div>
      );
    }
    const isSelected = selectedId === found.id;
    return (
      <div className="connection-cell" data-tone={found.state}>
        <button
          type="button"
          className="connection-status connection-status-button"
          aria-label={`${name} ${otherToolNames[inventory.tool]} details`}
          aria-pressed={isSelected}
          onClick={() => setSelectedId(isSelected ? null : found.id)}
        >
          <span aria-hidden className="connection-dot" />
          {stateName[found.state]}
        </button>
        <div className="connection-meta">
          {found.parked ? "Kept aside by SpecWithCode" : "User"} · {found.transport}
        </div>
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
    if (connection.plugin !== undefined)
      return (
        <p className="text-xs text-muted-foreground">
          The {connection.plugin} plugin ships it turned off.
        </p>
      );
    if (connection.pluginProvided)
      return (
        <p className="text-xs text-muted-foreground">
          Codex runs this through its {connection.name} plugin, so this older entry can stay off.
        </p>
      );
    if (connection.parked)
      return actionButton(connection, { action: "enable", connectionId: connection.id }, "Turn on");
    if (connection.provider === "claude")
      return <p className="text-xs text-muted-foreground">Turn it on with /mcp in Claude Code.</p>;
    if (connection.scope !== "user")
      return <p className="text-xs text-muted-foreground">Turn it on in the project config.</p>;
    return actionButton(connection, { action: "enable", connectionId: connection.id }, "Enable");
  }
  function addAction(source: NativeConnection, provider: Provider) {
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
  /** Edits for one declaration in a user file: off or on, remove, copy to every tool. */
  function manageActions(entry: {
    readonly id: string;
    readonly name: string;
    readonly state: NativeConnection["state"];
    readonly parked?: boolean;
    readonly portable?: boolean;
    readonly native: boolean;
  }) {
    if (!onApply || !manage) return null;
    const button = (input: NativeConnectionApplyInput, label: string) => (
      <Button
        key={label}
        variant="outline"
        size="xs"
        disabled={pendingId !== null}
        aria-label={`${label}: ${entry.name}`}
        onClick={() => onApply(input)}
      >
        {pendingId === entry.id ? "Checking…" : label}
      </Button>
    );
    const id = entry.id;
    return (
      <div className="flex flex-wrap gap-2" data-testid="connection-actions">
        {entry.state === "configured"
          ? button({ action: "disable", connectionId: id }, "Turn off")
          : entry.state === "disabled" && (entry.parked || entry.native)
            ? button({ action: "enable", connectionId: id }, "Turn on")
            : null}
        {entry.state === "configured" && entry.portable
          ? button({ action: "copyAll", connectionId: id }, "Add to all tools")
          : null}
        {button({ action: "remove", connectionId: id }, "Remove")}
      </div>
    );
  }
  const plugins = snapshot.plugins ?? [];
  const selectedPlugin =
    selected?.plugin !== undefined
      ? plugins.find((p) => p.provider === selected.provider && p.label === selected.plugin)
      : undefined;
  function pluginButton(plugin: (typeof plugins)[number]) {
    if (!onApply || !manage) return null;
    if (plugin.overridden)
      return <span className="text-xs text-muted-foreground">Set by this project's settings</span>;
    const label = plugin.enabled ? "Turn off plugin" : "Turn on plugin";
    return (
      <Button
        variant="outline"
        size="xs"
        disabled={pendingId !== null}
        aria-label={`${label}: ${plugin.label}`}
        onClick={() =>
          onApply({
            action: "plugin",
            provider: plugin.provider,
            pluginKey: plugin.key,
            enabled: !plugin.enabled,
          })
        }
      >
        {pendingId === plugin.key ? "Checking…" : label}
      </Button>
    );
  }
  const alternatives = selected
    ? snapshot.connections.filter(
        (c) => c.name === selected.name && c.provider === selected.provider && c.id !== selected.id,
      )
    : [];
  const detailSource = (c: NativeConnection) =>
    c.plugin !== undefined
      ? `${toolName(c.provider)} plugin ${c.plugin}`
      : c.project !== undefined
        ? `Private project ${c.project} in .claude.json`
        : sourceName(c.sourceId);
  const columns = 1 + providers.length + others.length;
  return (
    <div className="space-y-4" data-testid="connection-matrix">
      <p className="text-sm text-muted-foreground">
        {project
          ? "Project configuration includes user declarations and project overrides."
          : "User configurations, plugins and private project entries on this execution machine."}{" "}
        Authentication and session availability are unverified.
      </p>
      {names.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="connection-counts">
          {counts.map((c) => `${c.label} ${c.count}`).join(" · ")}
        </p>
      )}
      {(issues.length > 0 || otherIssues.length > 0) && (
        <div role="status" className="text-sm text-warning-foreground">
          Some sources could not be inspected:{" "}
          {[
            ...issues.map((s) => `${sourceName(s.id)} (${s.status.replaceAll("_", " ")})`),
            ...otherIssues.map(
              (t) => `${otherToolNames[t.tool]} (${t.status.replaceAll("_", " ")})`,
            ),
          ].join(", ")}
          . Results are incomplete.
        </div>
      )}
      {snapshot.truncated && (
        <p role="status" className="text-sm text-warning-foreground">
          Connection limit reached. Results are incomplete.
        </p>
      )}
      {names.length === 0 ? (
        <p role="status">
          {issues.length || otherIssues.length || snapshot.truncated
            ? "No declarations could be confirmed."
            : "No MCP declarations found in the inspected configuration files."}
        </p>
      ) : (
        <div className="connection-table-wrap">
          <table
            className="connection-table"
            style={{ minWidth: `${Math.max(520, 180 + (columns - 1) * 150)}px` }}
          >
            <caption className="sr-only">Configured MCP connections by AI tool</caption>
            <colgroup>
              <col className={columns > 3 ? "w-[24%]" : "w-[38%]"} />
              {Array.from({ length: columns - 1 }, (_, index) => (
                <col key={index} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Connection</th>
                {providers.map((provider) => (
                  <th key={provider} scope="col">
                    {toolName(provider)}
                  </th>
                ))}
                {others.map((t) => (
                  <th key={t.tool} scope="col">
                    {otherToolNames[t.tool]}
                  </th>
                ))}
              </tr>
            </thead>
            {rows.map((group) => (
              <tbody key={group.id} data-group={group.id}>
                {rows.length > 1 && (
                  <tr className="connection-group">
                    <th scope="colgroup" colSpan={columns}>
                      {group.title} · {group.names.length}
                    </th>
                  </tr>
                )}
                {group.names.map((name) => (
                  <Fragment key={name}>
                    <tr data-selected={selected?.name === name || undefined}>
                      <th scope="row">
                        <span className="connection-name" title={name}>
                          {name}
                        </span>
                      </th>
                      {providers.map((provider) => (
                        <td key={provider}>{cell(name, provider)}</td>
                      ))}
                      {others.map((t) => (
                        <td key={t.tool}>{otherCell(name, t)}</td>
                      ))}
                    </tr>
                    {name === COMPUTER_USE_CONNECTION && computerUseNote ? (
                      <tr data-testid="computer-use-connection-note">
                        <td colSpan={columns}>{computerUseNote}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {selected && (
        <div aria-live="polite" className="space-y-2 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">
              {selected.name} · {toolName(selected.provider)}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
              Close details
            </Button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Source</dt>
            <dd>{detailSource(selected)}</dd>
            <dt className="text-muted-foreground">Access owner</dt>
            <dd>{toolName(selected.provider)} manages native access</dd>
            <dt className="text-muted-foreground">Session</dt>
            <dd>Not checked</dd>
            {alternatives.length > 0 && (
              <>
                <dt className="text-muted-foreground">Other declarations</dt>
                <dd>
                  {alternatives
                    .map((c) => `${detailSource(c)}${c.shadowed ? " (overridden)" : ""}`)
                    .join(", ")}
                </dd>
              </>
            )}
          </dl>
          {own(selected) && selected.scope === "user"
            ? manageActions({ ...selected, native: selected.provider === "codex" })
            : selectedPlugin
              ? pluginButton(selectedPlugin)
              : null}
          <p className="text-xs text-muted-foreground">
            Project trust, account permissions and runtime policy may prevent use. SpecWithCode
            project grants apply only to SpecWithCode-managed calls.
          </p>
        </div>
      )}
      {selectedOther && !selected && (
        <div aria-live="polite" className="space-y-2 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">
              {selectedOther.name} · {otherToolNames[selectedOther.tool]}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
              Close details
            </Button>
          </div>
          <p className="text-sm">
            {selectedOther.parked
              ? `Turned off: SpecWithCode keeps the entry until you turn it on again.`
              : `Declared in ${otherToolFiles[selectedOther.tool]}.`}
          </p>
          {manageActions({ ...selectedOther, native: selectedOther.tool === "opencode" })}
        </div>
      )}
      {plugins.length > 0 && (
        <details className="text-sm" data-testid="connection-plugins">
          <summary className="cursor-pointer">Plugins · {plugins.length}</summary>
          <ul className="mt-2 space-y-2">
            {plugins.map((plugin) => (
              <li
                key={`${plugin.provider}:${plugin.key}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-medium">{plugin.label}</span>
                <span className="text-xs text-muted-foreground">
                  {toolName(plugin.provider)} · {plugin.enabled ? "On" : "Off"}
                </span>
                {pluginButton(plugin)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Inspected sources and limits</summary>
        <ul className="mt-2 space-y-1">
          {snapshot.sources.map((s) => (
            <li key={s.id}>
              {sourceName(s.id)} · {s.status.replaceAll("_", " ")}
            </li>
          ))}
          {(snapshot.otherTools ?? []).map((t) => (
            <li key={t.tool}>
              {otherToolNames[t.tool]} {otherToolFiles[t.tool]} · {t.status.replaceAll("_", " ")}
            </li>
          ))}
        </ul>
        <p className="mt-2">
          {project
            ? "Only the registered project root is inspected. "
            : "Select a project to inspect its project files and overrides. "}
          Plugins count only when enabled. Changes go to user files only, each previewed first and
          backed up so it can be undone. claude.ai connectors and other account connectors live in
          your account rather than in files, so they are not listed. Managed settings, ancestor
          configurations and alternate client profiles are not inventoried. Matching names do not
          prove matching servers or accounts.
        </p>
      </details>
      <p className="text-xs text-muted-foreground">
        Scanned {new Date(snapshot.observedAt).toLocaleString()} · Tools pick up changes when they
        next start
      </p>
    </div>
  );
}
