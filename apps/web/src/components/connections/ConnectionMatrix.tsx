import { Fragment, useId, useState, type ReactNode } from "react";
import type {
  NativeConnection,
  NativeConnectionApplyInput,
  NativeConnectionsSnapshot,
  NativeOtherTool,
  NativeOtherToolInventory,
  NativeTool,
} from "@specweave-studio/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  InfoIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
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
const statusFilters: ReadonlyArray<{ id: StatusFilter; label: string; tip: string }> = [
  { id: "all", label: "All", tip: "Every server in the shown tools." },
  { id: "enabled", label: "Enabled", tip: "Turned on in at least one shown tool." },
  { id: "disabled", label: "Disabled", tip: "Turned off in at least one shown tool." },
  {
    id: "missing",
    label: "Partly set up",
    tip: "Set up in at least one shown tool and missing from another.",
  },
  { id: "invalid", label: "Invalid", tip: "A broken entry in at least one shown tool." },
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
    <Tip content={text}>
      <span className="connection-hint" aria-label={text} role="note" tabIndex={0}>
        <InfoIcon aria-hidden className="size-3.5" />
      </span>
    </Tip>
  );
}

/** A cell's mark: its tone, or "add" for a missing server another tool's entry can fill. */
type Glyph = CellTone | "add";
const glyphLabel: Record<Glyph, string> = {
  configured: "Enabled",
  disabled: "Disabled",
  invalid: "Invalid",
  unknown: "Unknown",
  none: "Not set up",
  add: "Can add",
};
const legend: ReadonlyArray<{ glyph: Glyph; tip: string }> = [
  {
    glyph: "configured",
    tip: "Declared and turned on in that tool's config file. Sign-in is not checked.",
  },
  { glyph: "disabled", tip: "Declared in that tool's config file but turned off." },
  {
    glyph: "add",
    tip: "Not set up in that tool, but another tool's entry can be copied there. Select + to add it.",
  },
  { glyph: "none", tip: "That tool's config has no entry for this server." },
  { glyph: "invalid", tip: "The entry is malformed or has no supported transport." },
  { glyph: "unknown", tip: "A config file could not be read, so that tool's list is incomplete." },
];
/** A quick action a cell offers, or the note that says why there is none. */
type Offer =
  | { readonly hint: string }
  | {
      readonly connection: NativeConnection;
      readonly input: NativeConnectionApplyInput;
      readonly label: string;
    }
  | null;
interface CellView {
  readonly glyph: Glyph;
  /** "Enabled in Codex": the tooltip's first line. */
  readonly title: string;
  /** The status label the detailed view prints beside the mark. */
  readonly text: string;
  /** Scope and transport of a declaration, or how an add works. */
  readonly where?: string;
  readonly offer: Offer;
  /** The declaration the mark opens. */
  readonly selectId?: string;
}
const unknownView = (tool: string): CellView => ({
  glyph: "unknown",
  title: `Unknown in ${tool}`,
  text: glyphLabel.unknown,
  offer: { hint: "A config file could not be read, so this tool's list is incomplete." },
});

/** The state mark shared by every cell and the legend. */
function StatusGlyph({ tone }: { tone: Glyph }) {
  return (
    <span aria-hidden className="connection-glyph" data-glyph={tone}>
      {tone === "configured" ? (
        <CheckIcon strokeWidth={3.5} />
      ) : tone === "disabled" ? (
        <MinusIcon strokeWidth={3.5} />
      ) : tone === "add" ? (
        <PlusIcon strokeWidth={3} />
      ) : tone === "invalid" ? (
        "!"
      ) : tone === "unknown" ? (
        "?"
      ) : null}
    </span>
  );
}

/** A hover and focus tooltip around inline content; the content keeps its own handlers. */
function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="connection-tip-trigger" />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup>{content}</TooltipPopup>
    </Tooltip>
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
  const uid = useId();
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
  const offer = (
    connection: NativeConnection,
    input: NativeConnectionApplyInput,
    label: string,
  ): Offer => (onApply ? { connection, input, label } : null);
  /** Why a disabled entry is off, or the switch that turns it on from here. */
  function enableOffer(connection: NativeConnection): Offer {
    if (connection.plugin !== undefined)
      return { hint: `The ${connection.plugin} plugin ships it turned off.` };
    if (connection.pluginProvided)
      return {
        hint: `Codex runs this through its ${connection.name} plugin, so this older entry can stay off.`,
      };
    if (connection.parked)
      return offer(connection, { action: "enable", connectionId: connection.id }, "Turn on");
    if (connection.provider === "claude") return { hint: "Turn it on with /mcp in Claude Code." };
    if (connection.scope !== "user") return { hint: "Turn it on in the project config." };
    return offer(connection, { action: "enable", connectionId: connection.id }, "Enable");
  }
  /** Why a tool lacks a server another tool runs, or the copy that adds it. */
  function addOffer(source: NativeConnection, provider: Provider): Offer {
    if (source.state === "invalid") return null;
    if (!source.portable)
      return {
        hint: source.pluginProvided
          ? `A ${toolName(source.provider)} feature; ${toolName(provider)} has no equivalent entry.`
          : `This ${toolName(source.provider)} declaration cannot run in ${toolName(provider)}.`,
      };
    // Copy what runs today; a disabled entry is enabled first, where it is declared.
    if (source.state !== "configured") return null;
    return offer(
      source,
      { action: "copy", connectionId: source.id },
      `Add to ${toolName(provider)}`,
    );
  }
  function providerView(name: string, provider: Provider): CellView {
    const { entries, found } = resolve(name, provider);
    const incomplete = issues.some((s) => s.provider === provider) || snapshot.truncated;
    const tool = toolName(provider);
    if (!found) {
      if (incomplete) return unknownView(tool);
      const other = snapshot.connections.find(
        (c) =>
          c.name === name && c.provider !== provider && c.scope === "user" && own(c) && !c.shadowed,
      );
      const add = other ? addOffer(other, provider) : null;
      return {
        glyph: add && "input" in add ? "add" : "none",
        title: `Not set up in ${tool}`,
        text: glyphLabel.none,
        offer: add,
        ...(other && add && "input" in add
          ? {
              where: `Select + to copy the ${toolName(other.provider)} entry. You review the change before it is saved.`,
            }
          : {}),
      };
    }
    return {
      glyph: found.state,
      title: `${stateName[found.state]} in ${tool}`,
      text: glyphLabel[found.state],
      where: `${meta(found, entries)}${incomplete ? " · incomplete scan" : ""}`,
      offer: found.state === "disabled" ? enableOffer(found) : null,
      selectId: found.id,
    };
  }
  function otherView(name: string, inventory: NativeOtherToolInventory): CellView {
    const tool = otherToolNames[inventory.tool];
    const found = inventory.connections.find((c) => c.name === name);
    if (!found) {
      if (inventory.status !== "read" || snapshot.truncated) return unknownView(tool);
      return { glyph: "none", title: `Not set up in ${tool}`, text: glyphLabel.none, offer: null };
    }
    return {
      glyph: found.state,
      title: `${stateName[found.state]} in ${tool}`,
      text: glyphLabel[found.state],
      where: `${found.parked ? "Kept aside by SpecWithCode" : "User"} · ${found.transport}`,
      offer: null,
      selectId: found.id,
    };
  }
  /**
   * One cell: a single status mark with a tooltip in the compact view; the mark,
   * its label, scope, notes and quick action in the detailed one.
   */
  function renderCell(view: CellView, name: string, toolLabel: string, descId: string) {
    const action = view.offer && "input" in view.offer ? view.offer : null;
    const hint = view.offer && "hint" in view.offer ? view.offer.hint : null;
    const lines = [
      view.where,
      hint,
      view.selectId ? "Select for details and actions." : null,
    ].filter((line): line is string => Boolean(line));
    const tip = (
      <div className="connection-tip">
        <p className="font-medium">{view.title}</p>
        {lines.map((line) => (
          <p key={line} className="text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    );
    const description = (
      <span id={descId} className="sr-only">
        {/* The detailed view prints the status beside the mark, so it is not read twice. */}
        {[detailed ? null : `${view.title}.`, ...lines].filter(Boolean).join(" ")}
      </span>
    );
    const label = detailed ? <span className="connection-status-text">{view.text}</span> : null;
    const pending = action !== null && pendingId === action.connection.id;
    const mark = view.selectId ? (
      <button
        type="button"
        className="connection-status connection-status-button"
        aria-label={`${name} ${toolLabel} details`}
        aria-describedby={descId}
        aria-pressed={selectedId === view.selectId}
        onClick={() => select(view.selectId!, name)}
      >
        <StatusGlyph tone={view.glyph} />
        {label}
        {description}
      </button>
    ) : action && !detailed ? (
      <button
        type="button"
        className="connection-status connection-status-button"
        aria-label={`${action.label}: ${action.connection.name}`}
        aria-describedby={descId}
        data-pending={pending || undefined}
        aria-busy={pending || undefined}
        disabled={pendingId !== null}
        onClick={() => onApply?.(action.input)}
      >
        <StatusGlyph tone="add" />
        {description}
      </button>
    ) : (
      <span className="connection-status">
        <StatusGlyph tone={view.glyph} />
        {label}
        {description}
      </span>
    );
    return (
      <div className="connection-cell" data-tone={view.glyph}>
        <div className="connection-cell-line">
          <Tip content={tip}>{mark}</Tip>
        </div>
        {detailed && view.selectId && view.where ? (
          <div className="connection-meta">{view.where}</div>
        ) : null}
        {detailed && hint ? <div className="connection-meta">{hint}</div> : null}
        {detailed && action ? (
          <div className="connection-cell-action">
            <Button
              variant="outline"
              size="xs"
              disabled={pendingId !== null}
              aria-label={`${action.label}: ${action.connection.name}`}
              title={action.label}
              onClick={() => onApply?.(action.input)}
            >
              {pending ? (
                "Saving…"
              ) : view.glyph === "add" ? (
                <>
                  <PlusIcon aria-hidden />
                  Add
                </>
              ) : (
                action.label
              )}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  /** An older machine has no Turn on in the details, so its quick enable sits there. */
  function enableButton(found: Offer) {
    if (!found || !("input" in found)) return null;
    return (
      <Button
        variant="outline"
        size="xs"
        disabled={pendingId !== null}
        aria-label={`${found.label}: ${found.connection.name}`}
        onClick={() => onApply?.(found.input)}
      >
        {pendingId === found.connection.id ? "Saving…" : found.label}
      </Button>
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
          {selected && !manage && selected.state === "disabled"
            ? enableButton(enableOffer(selected))
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
    count: number | null,
    onClick: () => void,
    tip: string,
    aria = label,
    enabledCount = false,
  ) => (
    <Tip key={aria} content={tip}>
      <button
        type="button"
        className="connection-chip"
        aria-pressed={pressed}
        aria-label={count === null ? aria : `${aria} (${count})`}
        onClick={onClick}
      >
        {label}
        {count === null ? null : (
          <span className="connection-chip-count" data-enabled={enabledCount || undefined}>
            {count}
          </span>
        )}
      </button>
    </Tip>
  );
  const shownTones = new Set(allRows.flatMap((row) => row.tones));
  const legendShown = legend.filter((item) =>
    item.glyph === "add"
      ? onApply !== undefined
      : item.glyph === "invalid" || item.glyph === "unknown"
        ? shownTones.has(item.glyph)
        : true,
  );
  const nameWidth = detailed ? 200 : 176;
  const toolWidth = detailed ? 164 : 104;
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
              <span className="connection-chips-label">Show tools</span>
              {chip(
                chosenTools === null,
                "All",
                null,
                () => setChosenTools(null),
                "Show a column for every tool.",
                "All tools",
              )}
              {allColumns.map((column) =>
                chip(
                  chosenTools?.includes(column.id) ?? false,
                  column.label,
                  enabledIn(column),
                  () => setChosenTools((current) => toggleTool(current, column.id)),
                  `${enabledIn(column)} ${enabledIn(column) === 1 ? "server" : "servers"} enabled in ${column.label}. ${
                    chosenTools === null
                      ? "Select to show only this tool."
                      : "Select to add or remove this column."
                  }`,
                  `${column.label} enabled`,
                  true,
                ),
              )}
            </div>
            <div className="connection-chips" role="group" aria-label="Filter by status">
              <span className="connection-chips-label">Show servers</span>
              {statusFilters
                .filter((f) => f.id !== "invalid" || counts.invalid > 0 || status === "invalid")
                .map((f) =>
                  chip(status === f.id, f.label, counts[f.id], () => setStatus(f.id), f.tip),
                )}
            </div>
            <div className="connection-chips connection-density" role="group" aria-label="Density">
              {(["compact", "detailed"] as const).map((d) => (
                <Tip
                  key={d}
                  content={
                    d === "compact"
                      ? "One mark per cell. Hover a mark for what it means."
                      : "Status, scope, transport and notes in every cell."
                  }
                >
                  <button
                    type="button"
                    className="connection-chip"
                    aria-pressed={density === d}
                    onClick={() => setDensity(d)}
                  >
                    {d === "compact" ? "Compact" : "Detailed"}
                  </button>
                </Tip>
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
            <TooltipProvider delay={250}>
              <ul className="connection-legend" aria-label="Status legend">
                {legendShown.map((item) => (
                  <li key={item.glyph}>
                    <Tip content={item.tip}>
                      <span className="connection-legend-item">
                        <StatusGlyph tone={item.glyph} />
                        {glyphLabel[item.glyph]}
                      </span>
                    </Tip>
                  </li>
                ))}
              </ul>
              <div className="connection-table-wrap">
                <table
                  className="connection-table"
                  data-density={density}
                  style={{
                    minWidth: `${Math.max(480, nameWidth + (columns - 1) * toolWidth)}px`,
                  }}
                >
                  <caption className="sr-only">Configured MCP connections by AI tool</caption>
                  <colgroup>
                    {columns > 3 ? (
                      <col style={{ width: nameWidth }} />
                    ) : (
                      <col className="w-[38%]" />
                    )}
                    {Array.from({ length: columns - 1 }, (_, index) => (
                      <col key={index} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Server</th>
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
                          : group.rows.map(({ name }, rowIndex) => (
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
                                  {columnsShown.map((column, columnIndex) => (
                                    <td key={column.id}>
                                      {renderCell(
                                        column.inventory
                                          ? otherView(name, column.inventory)
                                          : providerView(name, column.id as Provider),
                                        name,
                                        column.label,
                                        `${uid}-${group.id}-${rowIndex}-${columnIndex}`,
                                      )}
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
            </TooltipProvider>
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
