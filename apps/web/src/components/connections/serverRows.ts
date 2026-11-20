import type {
  NativeConnection,
  NativeConnectionApplyInput,
  NativeConnectionsSnapshot,
  NativeTool,
} from "@specweave-studio/contracts";

/**
 * The MCP servers of one machine as a plain list, one row per server name. The
 * matrix ("Compare by AI tool") shows the same snapshot tool by tool; this is
 * the view a person reads first.
 */
export type ServerKind = "http" | "stdio" | "sse" | "unknown";

/** Where a tool's entry comes from. Only `own` entries are edited from the list. */
export type ServerOrigin =
  | { readonly kind: "own" }
  | { readonly kind: "plugin"; readonly plugin: string }
  /** Claude Code loads it only in that folder. */
  | { readonly kind: "folder"; readonly folder: string }
  /** Declared by the project whose page shows the list. */
  | { readonly kind: "project" };

export interface ServerListEntry {
  readonly tool: NativeTool;
  readonly id: string;
  readonly state: NativeConnection["state"];
  readonly origin: ServerOrigin;
  /** In a user file SpecWithCode edits. */
  readonly editable: boolean;
  /** A turned-off entry SpecWithCode can turn back on. */
  readonly canTurnOn: boolean;
}

export interface ServerListRow {
  readonly name: string;
  readonly kind: ServerKind;
  readonly entries: ReadonlyArray<ServerListEntry>;
  /** Turned off in every tool that has it. */
  readonly off: boolean;
  /** At least one entry comes from the project's own folder. */
  readonly thisProject: boolean;
}

export type ServerRowAction = "disable" | "enable" | "remove";

export interface ServerRowStep {
  readonly tool: NativeTool;
  readonly input: NativeConnectionApplyInput;
}

const providers = ["codex", "claude"] as const;
const own = (connection: NativeConnection) =>
  connection.plugin === undefined && connection.project === undefined;

function originOf(connection: NativeConnection): ServerOrigin {
  if (connection.plugin !== undefined) return { kind: "plugin", plugin: connection.plugin };
  if (connection.project !== undefined) return { kind: "folder", folder: connection.project };
  return connection.scope === "user" ? { kind: "own" } : { kind: "project" };
}

/** One row per server name, each with the entry every tool actually uses. */
export function serverListRows(snapshot: NativeConnectionsSnapshot): ReadonlyArray<ServerListRow> {
  const others = (snapshot.otherTools ?? []).filter((tool) => tool.status !== "missing");
  const names = [
    ...new Set([
      ...snapshot.connections.map((connection) => connection.name),
      ...others.flatMap((tool) => tool.connections.map((connection) => connection.name)),
    ]),
  ];
  return names
    .map((name): ServerListRow => {
      const entries: ServerListEntry[] = [];
      let kind: ServerKind | null = null;
      for (const provider of providers) {
        const declared = snapshot.connections.filter(
          (connection) => connection.name === name && connection.provider === provider,
        );
        // The declaration the tool uses: its own file first, then a plugin, then a folder.
        const found =
          declared.find((connection) => own(connection) && !connection.shadowed) ??
          declared.find((connection) => connection.plugin !== undefined) ??
          declared.find((connection) => connection.project !== undefined);
        if (!found) continue;
        kind ??= found.transport;
        const origin = originOf(found);
        entries.push({
          tool: provider,
          id: found.id,
          state: found.state,
          origin,
          editable: origin.kind === "own",
          canTurnOn: found.parked === true || provider === "codex",
        });
      }
      for (const tool of others) {
        const found = tool.connections.find((connection) => connection.name === name);
        if (!found) continue;
        kind ??= found.transport;
        entries.push({
          tool: tool.tool,
          id: found.id,
          state: found.state,
          origin: { kind: "own" },
          editable: true,
          canTurnOn: found.parked === true || tool.tool === "opencode",
        });
      }
      return {
        name,
        kind: kind ?? "unknown",
        entries,
        off: entries.length > 0 && entries.every((entry) => entry.state === "disabled"),
        thisProject: entries.some((entry) => entry.origin.kind === "project"),
      };
    })
    .filter((row) => row.entries.length > 0)
    .toSorted((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
}

/** The single-entry edits one row action stands for, one per tool it reaches. */
export function serverRowSteps(
  row: ServerListRow,
  action: ServerRowAction,
): ReadonlyArray<ServerRowStep> {
  return row.entries
    .filter(
      (entry) =>
        entry.editable &&
        (action === "remove" ||
          (action === "disable" && entry.state === "configured") ||
          (action === "enable" && entry.state === "disabled" && entry.canTurnOn)),
    )
    .map((entry) => ({ tool: entry.tool, input: { action, connectionId: entry.id } }));
}

/** Matches a name or the label of a tool that has the server. */
export function filterServerRows(
  rows: ReadonlyArray<ServerListRow>,
  query: string,
  toolLabel: (tool: NativeTool) => string,
): ReadonlyArray<ServerListRow> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      row.entries.some((entry) => toolLabel(entry.tool).toLowerCase().includes(needle)),
  );
}

/** A file could not be read or the scan was cut short, so servers may be missing. */
export function snapshotIncomplete(snapshot: NativeConnectionsSnapshot): boolean {
  return (
    snapshot.truncated ||
    snapshot.sources.some((source) => source.status !== "read" && source.status !== "missing") ||
    (snapshot.otherTools ?? []).some((tool) => tool.status !== "read" && tool.status !== "missing")
  );
}

/** The search field shows once the list is longer than this. */
export const SERVER_LIST_SEARCH_ABOVE = 8;
