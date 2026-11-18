import { SearchIcon } from "lucide-react";
import { useState } from "react";
import type { NativeTool } from "@specweave-studio/contracts";

import { useTx } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toolLabels } from "./ConnectionMatrix";
import {
  filterServerRows,
  SERVER_LIST_SEARCH_ABOVE,
  serverRowSteps,
  type ServerKind,
  type ServerListRow,
  type ServerRowAction,
} from "./serverRows";
import "./connections.css";

const KIND_LABEL: Record<ServerKind, string> = {
  http: "Web address",
  stdio: "Program on this machine",
  sse: "Web address (SSE)",
  unknown: "Unknown kind",
};

const ACTIONS: ReadonlyArray<{ readonly id: ServerRowAction; readonly label: string }> = [
  { id: "disable", label: "Turn off" },
  { id: "enable", label: "Turn on" },
  { id: "remove", label: "Remove" },
];

const toolLabel = (tool: NativeTool) => toolLabels[tool];

/** Where the entries SpecWithCode does not edit come from, one line per source. */
function originLines(row: ServerListRow, tx: ReturnType<typeof useTx>): ReadonlyArray<string> {
  const lines = new Set<string>();
  for (const entry of row.entries) {
    if (entry.origin.kind === "plugin")
      lines.add(
        tx("{tool}: from the {plugin} plugin", {
          tool: toolLabel(entry.tool),
          plugin: entry.origin.plugin,
        }),
      );
    else if (entry.origin.kind === "folder")
      lines.add(
        tx("{tool}: only in the folder {folder}", {
          tool: toolLabel(entry.tool),
          folder: entry.origin.folder,
        }),
      );
    else if (entry.origin.kind === "project")
      lines.add(tx("{tool}: from this project's folder", { tool: toolLabel(entry.tool) }));
  }
  return [...lines];
}

/**
 * One row per server on the machine: its kind, the tools that have it and the
 * edits that reach every one of those tools at once.
 */
export function ServerList({
  rows,
  machine,
  busy,
  added,
  emptyHint,
  onAct,
}: {
  readonly rows: ReadonlyArray<ServerListRow>;
  readonly machine: string;
  readonly busy: boolean;
  /** The server just added from this page. It says "Added": sign-in state is never known. */
  readonly added?: string | null | undefined;
  /** Where to add one from, when this sign-in may. */
  readonly emptyHint?: string | null | undefined;
  /** Absent when this sign-in may not change the machine's files. */
  readonly onAct?: ((row: ServerListRow, action: ServerRowAction) => void) | undefined;
}) {
  const tx = useTx();
  const [query, setQuery] = useState("");
  if (rows.length === 0)
    return (
      <div
        className="rounded-lg border border-dashed border-border px-4 py-5 text-center"
        data-testid="server-list-empty"
      >
        <p className="text-sm font-medium">{tx("No MCP servers on {machine} yet", { machine })}</p>
        {emptyHint ? <p className="text-xs text-muted-foreground">{emptyHint}</p> : null}
      </div>
    );
  const shown = filterServerRows(rows, query, toolLabel);
  return (
    <div className="space-y-2" data-testid="server-list">
      {rows.length > SERVER_LIST_SEARCH_ABOVE ? (
        <label className="connection-search">
          <SearchIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <input
            type="search"
            value={query}
            placeholder={tx("Search servers")}
            aria-label={tx("Search servers")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      {shown.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {tx("No server matches the search.")}
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
          {shown.map((row) => {
            const origins = originLines(row, tx);
            const actions = onAct
              ? ACTIONS.filter((action) => serverRowSteps(row, action.id).length > 0)
              : [];
            return (
              <li
                key={row.name}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
                data-testid="server-row"
              >
                <div className="min-w-44 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium [overflow-wrap:anywhere]">{row.name}</span>
                    {row.name === added ? <Badge variant="success">{tx("Added")}</Badge> : null}
                    {row.off ? <Badge variant="outline">{tx("Off")}</Badge> : null}
                    {row.thisProject ? <Badge variant="info">{tx("This project")}</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{tx(KIND_LABEL[row.kind])}</p>
                  <ul className="flex flex-wrap gap-1" aria-label={tx("AI tools that have it")}>
                    {row.entries.map((entry) => (
                      <li key={entry.tool}>
                        <Badge variant="outline">
                          {entry.state === "disabled" && !row.off
                            ? tx("{tool}, off", { tool: toolLabel(entry.tool) })
                            : entry.state === "invalid"
                              ? tx("{tool}, broken entry", { tool: toolLabel(entry.tool) })
                              : toolLabel(entry.tool)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  {origins.map((line) => (
                    <p key={line} className="text-xs text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </div>
                {actions.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {actions.map((action) => (
                      <Button
                        key={action.id}
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-label={`${tx(action.label)}: ${row.name}`}
                        onClick={() => onAct?.(row, action.id)}
                      >
                        {tx(action.label)}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
