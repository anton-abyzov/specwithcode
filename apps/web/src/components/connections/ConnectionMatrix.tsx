import { Fragment, useState, type ReactNode } from "react";
import type {
  NativeConnection,
  NativeConnectionApplyInput,
  NativeConnectionsSnapshot,
  NativeOtherTool,
  NativeOtherToolInventory,
  NativeTool,
} from "@specweave-studio/contracts";
import { CheckIcon, ChevronDownIcon, CopyIcon, InfoIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  filterRows,
  statusCounts,
  toggleTool,
  type CellTone,
  type StatusFilter,
} from "./connectionFilters";
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
  "claude-local": "This folder's entry in ~/.claude.json",
  "claude-all-projects": "Folder-only entries in ~/.claude.json",
  "claude-project": "Project .mcp.json",
  "claude-plugins": "Claude Code plugins",
  "claude-user-settings": "Claude user settings.json",
  "claude-project-settings": "Project .claude/settings.json",
  "claude-local-settings": "Project .claude/settings.local.json",
};
/** Where a declaration lives, for Copy location: the file and the key inside it. */
const sourceFiles: Record<string, string> = {
  "codex-user": "~/.codex/config.toml",
  "codex-project": ".codex/config.toml",
  "claude-user": "~/.claude.json",
  "claude-local": "~/.claude.json",
  "claude-all-projects": "~/.claude.json",
  "claude-project": ".mcp.json",
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
  configured: "Enabled",
  disabled: "Disabled",
  invalid: "Invalid declaration",
};
const statusFilters: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  { id: "missing", label: "Missing somewhere" },
  { id: "invalid", label: "Invalid" },
];
/** Declared in a file the user edits, as opposed to a plugin or one folder's local entry. */
const own = (c: NativeConnection) => c.plugin === undefined && c.project === undefined;
const groups = [
  { id: "own", title: "Your connections" },
  { id: "plugin", title: "From plugins" },
  { id: "project", title: "Only in one folder (Claude Code)" },
] as const;
type Group = (typeof groups)[number]["id"];
/** Claude Code local scope: `projects.<folder>.mcpServers` in the user's own file. */
export const FOLDER_ONLY_NOTE =
  "Claude Code loads these only when it runs in that folder. Other folders, projects and providers do not get them. They are stored in your ~/.claude.json.";
/** The one-line answer to "why is this server missing in Codex?". */
export const PER_TOOL_NOTE =
  "Each AI tool keeps its own MCP list, so a server enabled in Claude Code is not available in Codex until it is added there too.";
/** "Claude Code, only in <folder>", naming how many other folders declare the same server. */
const folderOnly = (folder: string, more: number) =>
  `Claude Code, only in ${folder}${more > 0 ? ` and ${more} more ${more === 1 ? "folder" : "folders"}` : ""}`;

interface Column {
  readonly id: NativeTool;
  readonly label: string;
  /** Present for the read-only columns of tools other than Codex and Claude Code. */
  readonly inventory?: NativeOtherToolInventory;
}
type Density = "compact" | "detailed";

/** A muted note: inline in the detailed view, an info mark with a tooltip in the compact one. */
function Hint({ text, inline }: { text: string; inline: boolean }) {
  if (inline) return <p className="text-xs text-muted-foreground">{text}</p>;
  return (
    <span className="connection-hint" title={text} aria-label={text} role="note" tabIndex={0}>
      <InfoIcon aria-hidden className="size-3.5" />
    </span>
  );
}

/** Configuration evidence only: no cell claims native authentication, trust, or admission. */
export function ConnectionMatrix({
  snapshot,
  project = false,
  onApply,
  pendingId = null,
  computerUseNote,
  manage = true,
  initialDensity = "compact",
}: {
  /** The machine supports the full edit set; an older one only enables and copies. */
  manage?: boolean;
  snapshot: NativeConnectionsSnapshot;
  project?: boolean;
  /**
   * Shown in a `computer-use` row's details: agents use SpecWithCode's own computer
   * use whatever Codex or Claude Code declare, so the note says what it needs.
   */
  computerUseNote?: ReactNode;
  /** Absent when this connection may not edit native configuration on the machine. */
  onApply?: (input: NativeConnectionApplyInput) => void;
  pendingId?: string | null;
  initialDensity?: Density;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** A row opened from its name: its details without one tool's declaration chosen. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [chosenTools, setChosenTools] = useState<ReadonlyArray<NativeTool> | null>(null);
  const [density, setDensity] = useState<Density>(initialDensity);
  const [collapsed, setCollapsed] = useState<ReadonlyArray<Group>>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const detailed = density === "detailed";
  // A tool gets a column once its configuration exists on this machine.
  const others = (snapshot.otherTools ?? []).filter((t) => t.status !== "missing");
  const allColumns: ReadonlyArray<Column> = [
    ...providers.map((provider) => ({ id: provider, label: toolName(provider) })),
    ...others.map((t) => ({ id: t.tool, label: otherToolNames[t.tool], inventory: t })),
  ];
  const visibleTools = chosenTools?.filter((id) => allColumns.some((c) => c.id === id));
  const columnsShown =
    visibleTools && visibleTools.length > 0
      ? allColumns.filter((c) => visibleTools.includes(c.id))
      : allColumns;
  const names = [
    ...new Set([
      ...snapshot.connections.map((c) => c.name),
      ...others.flatMap((t) => t.connections.map((c) => c.name)),
    ]),
  ];
  const groupOf = (name: string): Group => {
    const entries = snapshot.connections.filter((c) => c.name === name);
    if (entries.length === 0 || entries.some(own)) return "own";
    return entries.some((c) => c.plugin !== undefined) ? "plugin" : "project";
  };
  const selected = snapshot.connections.find((c) => c.id === selectedId);
  const selectedOther = others
    .flatMap((t) => t.connections.map((c) => ({ ...c, tool: t.tool })))
    .find((c) => c.id === selectedId);
  const issues = snapshot.sources.filter((s) => s.status !== "read" && s.status !== "missing");
  const otherIssues = others.filter((t) => t.status !== "read");
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
  function tone(name: string, column: Column): CellTone {
    if (column.inventory) {
      const found = column.inventory.connections.find((c) => c.name === name);
      if (found) return found.state;
      return column.inventory.status !== "read" || snapshot.truncated ? "unknown" : "none";
    }
    const provider = column.id as Provider;
    const { found } = resolve(name, provider);
    if (found) return found.state;
    const incomplete = issues.some((s) => s.provider === provider) || snapshot.truncated;
    return incomplete ? "unknown" : "none";
  }
  const allRows = names.map((name) => ({
    name,
    group: groupOf(name),
    aliases: snapshot.connections
      .filter((c) => c.name === name)
      .flatMap((c) => [c.plugin, c.project].filter((x): x is string => x !== undefined)),
    tones: columnsShown.map((column) => tone(name, column)),
  }));
  const counts = statusCounts(allRows, query);
  const shownRows = filterRows(allRows, query, status);
  const rows = groups
    .map((group) => ({ ...group, rows: shownRows.filter((row) => row.group === group.id) }))
    .filter((group) => group.rows.length > 0);
  const enabledIn = (column: Column) =>
    names.filter((name) => tone(name, column) === "configured").length;
  const filtered = query.trim() !== "" || status !== "all" || chosenTools !== null;
  function clearFilters() {
    setQuery("");
    setStatus("all");
    setChosenTools(null);
  }
  function meta(connection: NativeConnection, entries: ReadonlyArray<NativeConnection>) {
    if (connection.plugin !== undefined)
      return `Plugin ${connection.plugin} · ${connection.transport}`;
    if (connection.project !== undefined) {
      const more = entries.filter((c) => c.project !== undefined).length - 1;
      return `${folderOnly(connection.project, more)} · ${connection.transport}`;
    }
    const scope =
      connection.scope === "local"
        ? "Only in this folder"
        : connection.scope === "project"
          ? "Project"
          : "User";
    return `${scope} · ${connection.transport}`;
  }
  function select(id: string, name: string) {
    const closing = selectedId === id;
    setSelectedId(closing ? null : id);
    setOpenRow(closing ? null : name);
  }
  function statusButton(id: string, name: string, label: string, text: string, title: string) {
    const isSelected = selectedId === id;
    return (
      <button
        type="button"
        className="connection-status connection-status-button"
        aria-label={`${name} ${label} details`}
        aria-pressed={isSelected}
        title={title}
        onClick={() => select(id, name)}
      >
        <span aria-hidden className="connection-dot" />
        {text}
      </button>
    );
  }
  function emptyCell(tone: "none" | "unknown", action: ReactNode = null) {
    const text = tone === "unknown" ? "Unknown" : "Not found";
    return (
      <div className="connection-cell" data-tone={tone}>
        <span className="connection-status" title={text}>
          <span aria-hidden className="connection-dot" />
          {detailed || tone === "unknown" ? text : <span className="sr-only">{text}</span>}
        </span>
        {action}
      </div>
    );
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
      return emptyCell(incomplete ? "unknown" : "none", other ? addAction(other, provider) : null);
    }
    const where = meta(found, entries);
    return (
      <div className="connection-cell" data-tone={found.state}>
        <div className="connection-cell-line">
          {statusButton(
            found.id,
            name,
            toolName(provider),
            `${stateName[found.state]}${incomplete ? " · incomplete scan" : ""}`,
            where,
          )}
          {found.state === "disabled" ? enableAction(found) : null}
        </div>
        {detailed ? <div className="connection-meta">{where}</div> : null}
      </div>
    );
  }
  function otherCell(name: string, inventory: NativeOtherToolInventory) {
    const found = inventory.connections.find((c) => c.name === name);
    if (!found)
      return emptyCell(inventory.status !== "read" || snapshot.truncated ? "unknown" : "none");
    const where = `${found.parked ? "Kept aside by SpecWithCode" : "User"} · ${found.transport}`;
    return (
      <div className="connection-cell" data-tone={found.state}>
        {statusButton(
          found.id,
          name,
          otherToolNames[inventory.tool],
          stateName[found.state],
          where,
        )}
        {detailed ? <div className="connection-meta">{where}</div> : null}
      </div>
    );
  }

  function actionButton(
    connection: NativeConnection,
    input: NativeConnectionApplyInput,
    label: string,
    short = label,
  ) {
    if (!onApply) return null;
    return (
      <Button
        variant="outline"
        size="xs"
        disabled={pendingId !== null}
        aria-label={`${label}: ${connection.name}`}
        title={label}
        onClick={() => onApply(input)}
      >
        {pendingId === connection.id ? "Saving…" : detailed ? label : short}
      </Button>
    );
  }
  function enableAction(connection: NativeConnection) {
    if (connection.plugin !== undefined)
      return (
        <Hint inline={detailed} text={`The ${connection.plugin} plugin ships it turned off.`} />
      );
    if (connection.pluginProvided)
      return (
        <Hint
          inline={detailed}
          text={`Codex runs this through its ${connection.name} plugin, so this older entry can stay off.`}
        />
      );
    if (connection.parked)
      return actionButton(connection, { action: "enable", connectionId: connection.id }, "Turn on");
    if (connection.provider === "claude")
      return <Hint inline={detailed} text="Turn it on with /mcp in Claude Code." />;
    if (connection.scope !== "user")
      return <Hint inline={detailed} text="Turn it on in the project config." />;
    return actionButton(connection, { action: "enable", connectionId: connection.id }, "Enable");
  }
  function addAction(source: NativeConnection, provider: Provider) {
    if (source.state === "invalid") return null;
    if (!source.portable)
      return (
        <Hint
          inline={detailed}
          text={
            source.pluginProvided
              ? `A ${toolName(source.provider)} feature; ${toolName(provider)} has no equivalent entry.`
              : `This ${toolName(source.provider)} declaration cannot run in ${toolName(provider)}.`
          }
        />
      );
    // Copy what runs today; a disabled entry is enabled first, where it is declared.
    if (source.state !== "configured") return null;
    return actionButton(
      source,
      { action: "copy", connectionId: source.id },
      `Add to ${toolName(provider)}`,
      "+ Add",
    );
  }
  /** Copies where a declaration lives (file and key), never its command, URL or secrets. */
  function copyLocation(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(id),
      () => setCopied(null),
    );
  }
  function copyButton(id: string, location: string | null) {
    if (!location) return null;
    return (
      <Button
        variant="outline"
        size="xs"
        aria-label={`Copy location: ${location}`}
        title={location}
        onClick={() => copyLocation(id, location)}
      >
        {copied === id ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        {copied === id ? "Copied" : "Copy location"}
      </Button>
    );
  }
  const locationOf = (c: NativeConnection) => {
    const file = sourceFiles[c.sourceId];
    // A kept-aside entry lives in SpecWithCode's own state, not in the tool's file.
    if (!file || c.plugin !== undefined || c.parked) return null;
    if (c.provider === "codex") return `${file} [mcp_servers.${c.name}]`;
    if (c.project !== undefined) return `${file} projects.<${c.project}>.mcpServers.${c.name}`;
    if (c.sourceId === "claude-local") return `${file} projects.<this folder>.mcpServers.${c.name}`;
    return `${file} mcpServers.${c.name}`;
  };
  const otherLocation = (tool: NativeOtherTool, name: string) =>
    `${otherToolFiles[tool]} ${tool === "opencode" ? "mcp" : "mcpServers"}.${name}`;
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
      <>
        {entry.state === "configured"
          ? button({ action: "disable", connectionId: id }, "Turn off")
          : entry.state === "disabled" && (entry.parked || entry.native)
            ? button({ action: "enable", connectionId: id }, "Turn on")
            : null}
        {entry.state === "configured" && entry.portable
          ? button({ action: "copyAll", connectionId: id }, "Add to all tools")
          : null}
        {button({ action: "remove", connectionId: id }, "Remove")}
      </>
    );
  }
  const plugins = snapshot.plugins ?? [];
  const selectedPlugin =
    selected?.plugin !== undefined
      ? plugins.find((p) => p.provider === selected.provider && p.label === selected.plugin)
      : undefined;
  /** An account plugin's switch reaches only its skills, so its state names them. */
  const pluginState = (plugin: (typeof plugins)[number]) =>
    plugin.account && plugin.switchable !== false
      ? `Skills ${plugin.enabled ? "on" : "off"}`
      : plugin.enabled
        ? "On"
        : "Off";
  function pluginButton(plugin: (typeof plugins)[number]) {
    if (!onApply || !manage) return null;
    if (plugin.overridden)
      return <span className="text-xs text-muted-foreground">Set by this project's settings</span>;
    if (plugin.switchable === false)
      return <span className="text-xs text-muted-foreground">Managed in your ChatGPT account</span>;
    // Codex loads an account plugin's apps whatever config.toml says; only its skills switch.
    const what = plugin.account ? "skills" : "plugin";
    const label = plugin.enabled ? `Turn off ${what}` : `Turn on ${what}`;
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
        ? `${folderOnly(c.project, 0)} (~/.claude.json)`
        : sourceName(c.sourceId);
  const closeDetails = () => {
    setSelectedId(null);
    setOpenRow(null);
  };
  /** The row's expanded panel: one declaration's provenance and edits, plus the row's notes. */
  function details(name: string) {
    const declaredIn = allColumns.filter((c) => {
      const t = tone(name, c);
      return t === "configured" || t === "disabled" || t === "invalid";
    });
    const title = selected
      ? `${selected.name} · ${toolName(selected.provider)}`
      : selectedOther
        ? `${selectedOther.name} · ${otherToolNames[selectedOther.tool]}`
        : name;
    return (
      <div aria-live="polite" className="connection-details" data-testid="connection-details">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{title}</h3>
          <Button variant="ghost" size="sm" onClick={closeDetails}>
            <XIcon aria-hidden />
            Close details
          </Button>
        </div>
        {selected ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Source</dt>
            <dd>{detailSource(selected)}</dd>
            <dt className="text-muted-foreground">Transport</dt>
            <dd>{selected.transport}</dd>
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
        ) : selectedOther ? (
          <p className="text-sm">
            {selectedOther.parked
              ? `Turned off: SpecWithCode keeps the entry until you turn it on again.`
              : `Declared in ${otherToolFiles[selectedOther.tool]}.`}
          </p>
        ) : (
          <p className="text-sm">
            {declaredIn.length > 0
              ? `Declared for ${declaredIn.map((c) => c.label).join(", ")}. Select a status to manage one tool's entry.`
              : "Not declared in any tool shown."}
          </p>
        )}
        <div className="flex flex-wrap gap-2" data-testid="connection-actions">
          {selected
            ? own(selected) && selected.scope === "user"
              ? manageActions({ ...selected, native: selected.provider === "codex" })
              : selectedPlugin
                ? pluginButton(selectedPlugin)
                : null
            : selectedOther
              ? manageActions({ ...selectedOther, native: selectedOther.tool === "opencode" })
              : null}
          {selected
            ? copyButton(selected.id, locationOf(selected))
            : selectedOther
              ? copyButton(
                  selectedOther.id,
                  selectedOther.parked
                    ? null
                    : otherLocation(selectedOther.tool, selectedOther.name),
                )
              : null}
        </div>
        {name === COMPUTER_USE_CONNECTION && computerUseNote ? (
          <div data-testid="computer-use-connection-note">{computerUseNote}</div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Project trust, account permissions and runtime policy may prevent use. SpecWithCode
          project grants apply only to SpecWithCode-managed calls.
        </p>
      </div>
    );
  }
  // The open row follows the selection; a refresh that drops the server closes it.
  const detailsRow =
    selected?.name ?? selectedOther?.name ?? (openRow && names.includes(openRow) ? openRow : null);
  const columns = 1 + columnsShown.length;
  const chip = (
    pressed: boolean,
    label: string,
    count: number,
    onClick: () => void,
    aria = label,
  ) => (
    <button
      key={aria}
      type="button"
      className="connection-chip"
      aria-pressed={pressed}
      aria-label={`${aria} (${count})`}
      onClick={onClick}
    >
      {label}
      <span className="connection-chip-count">{count}</span>
    </button>
  );
  return (
    <div className="space-y-3" data-testid="connection-matrix">
      <p className="text-sm text-muted-foreground">{PER_TOOL_NOTE}</p>
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
        <>
          <div className="connection-toolbar" data-testid="connection-filters">
            <label className="connection-search">
              <SearchIcon aria-hidden className="size-3.5 text-muted-foreground" />
              <input
                type="search"
                value={query}
                placeholder="Search servers, plugins, folders"
                aria-label="Search connections"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="connection-chips" role="group" aria-label="Filter by AI tool">
              <span className="connection-chips-label">Tools</span>
              {chip(
                chosenTools === null,
                "All",
                allColumns.length,
                () => setChosenTools(null),
                "All tools",
              )}
              {allColumns.map((column) =>
                chip(
                  chosenTools?.includes(column.id) ?? false,
                  column.label,
                  enabledIn(column),
                  () => setChosenTools((current) => toggleTool(current, column.id)),
                  `${column.label} enabled`,
                ),
              )}
            </div>
            <div className="connection-chips" role="group" aria-label="Filter by status">
              <span className="connection-chips-label">Status</span>
              {statusFilters
                .filter((f) => f.id !== "invalid" || counts.invalid > 0 || status === "invalid")
                .map((f) => chip(status === f.id, f.label, counts[f.id], () => setStatus(f.id)))}
            </div>
            <div className="connection-chips connection-density" role="group" aria-label="Density">
              {(["compact", "detailed"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="connection-chip"
                  aria-pressed={density === d}
                  onClick={() => setDensity(d)}
                >
                  {d === "compact" ? "Compact" : "Detailed"}
                </button>
              ))}
            </div>
          </div>
          {shownRows.length === 0 ? (
            <div role="status" className="connection-empty">
              No connections match these filters.
              <Button variant="outline" size="xs" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="connection-table-wrap">
              <table
                className="connection-table"
                data-density={density}
                style={{
                  minWidth: `${Math.max(480, (detailed ? 180 : 150) + (columns - 1) * (detailed ? 150 : 92))}px`,
                }}
              >
                <caption className="sr-only">Configured MCP connections by AI tool</caption>
                <colgroup>
                  {columns > 3 ? (
                    <col style={{ width: detailed ? 180 : 150 }} />
                  ) : (
                    <col className="w-[38%]" />
                  )}
                  {Array.from({ length: columns - 1 }, (_, index) => (
                    <col key={index} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Connection</th>
                    {columnsShown.map((column) => (
                      <th key={column.id} scope="col">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                {rows.map((group) => {
                  const isCollapsed = collapsed.includes(group.id);
                  return (
                    <tbody key={group.id} data-group={group.id}>
                      {(rows.length > 1 || group.id !== "own") && (
                        <tr className="connection-group">
                          <th scope="colgroup" colSpan={columns}>
                            <span className="connection-group-head">
                              <button
                                type="button"
                                className="connection-group-toggle"
                                aria-expanded={!isCollapsed}
                                onClick={() =>
                                  setCollapsed((current) =>
                                    isCollapsed
                                      ? current.filter((g) => g !== group.id)
                                      : [...current, group.id],
                                  )
                                }
                              >
                                <ChevronDownIcon aria-hidden className="size-3.5" />
                                {group.title} · {group.rows.length}
                              </button>
                              {group.id === "project" ? (
                                <span data-testid="folder-only-note">
                                  <Hint inline={false} text={FOLDER_ONLY_NOTE} />
                                </span>
                              ) : null}
                            </span>
                          </th>
                        </tr>
                      )}
                      {isCollapsed
                        ? null
                        : group.rows.map(({ name }) => (
                            <Fragment key={name}>
                              <tr data-selected={detailsRow === name || undefined}>
                                <th scope="row">
                                  <button
                                    type="button"
                                    className="connection-name"
                                    title={name}
                                    aria-expanded={detailsRow === name}
                                    aria-label={`${name} row details`}
                                    onClick={() => {
                                      const open = detailsRow === name;
                                      setSelectedId(null);
                                      setOpenRow(open ? null : name);
                                    }}
                                  >
                                    {name}
                                  </button>
                                  {name === COMPUTER_USE_CONNECTION && computerUseNote ? (
                                    <Hint
                                      inline={false}
                                      text="Agents in SpecWithCode use the app's own computer use. Open for the permissions it needs."
                                    />
                                  ) : null}
                                </th>
                                {columnsShown.map((column) => (
                                  <td key={column.id}>
                                    {column.inventory
                                      ? otherCell(name, column.inventory)
                                      : cell(name, column.id as Provider)}
                                  </td>
                                ))}
                              </tr>
                              {detailsRow === name ? (
                                <tr className="connection-details-row">
                                  <td colSpan={columns}>{details(name)}</td>
                                </tr>
                              ) : null}
                            </Fragment>
                          ))}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )}
          {filtered && shownRows.length > 0 ? (
            <p className="text-xs text-muted-foreground" role="status">
              Showing {shownRows.length} of {names.length} servers.{" "}
              <button type="button" className="underline" onClick={clearFilters}>
                Clear filters
              </button>
            </p>
          ) : null}
        </>
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
                  {toolName(plugin.provider)} · {pluginState(plugin)}
                  {plugin.account ? " · From your ChatGPT account" : ""}
                </span>
                {pluginButton(plugin)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="text-xs text-muted-foreground" data-testid="connection-about">
        <summary className="cursor-pointer">About this list: sources and limits</summary>
        <p className="mt-2">
          {project
            ? "Project configuration includes user declarations and project overrides."
            : "User configurations, plugins and folder-only Claude Code entries on this machine."}{" "}
          Enabled means the entry is turned on in its file; sign-in and session availability are not
          checked.
        </p>
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
          backed up so it can be undone. Copy location copies the file and key, never the command,
          URL or secrets. claude.ai connectors and other account connectors live in your account
          rather than in files, so they are not listed. Managed settings, ancestor configurations
          and alternate client profiles are not inventoried. Matching names do not prove matching
          servers or accounts.
        </p>
      </details>
      <p className="text-xs text-muted-foreground">
        Scanned {new Date(snapshot.observedAt).toLocaleString()} · Tools pick up changes when they
        next start
      </p>
    </div>
  );
}
