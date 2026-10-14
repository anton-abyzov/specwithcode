import { useState } from "react";
import type { NativeConnectionsSnapshot } from "@specweave-studio/contracts";
import { Button } from "../ui/button";

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
}: {
  snapshot: NativeConnectionsSnapshot;
  project?: boolean;
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
    if (!current)
      return <span className="text-muted-foreground">{incomplete ? "Unknown" : "Not found"}</span>;
    return (
      <div className="space-y-1">
        <Button
          variant="ghost"
          size="sm-multiline"
          className="max-w-full"
          aria-label={`${name} ${provider === "codex" ? "Codex" : "Claude Code"} details`}
          aria-pressed={selected?.id === current.id}
          onClick={() => setSelectedId(current.id)}
        >
          {stateName[current.state]}
          {incomplete ? " · incomplete scan" : ""}
        </Button>
        <div className="text-xs text-muted-foreground">
          {current.scope === "local"
            ? "Private project"
            : current.scope === "project"
              ? "Project"
              : "User"}{" "}
          · {current.transport}
        </div>
      </div>
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
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-sm">
            <caption className="sr-only">Configured MCP connections by AI tool</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="w-1/3 px-2 py-3 font-medium">
                  Connection
                </th>
                <th scope="col" className="px-2 py-3 font-medium">
                  Codex
                </th>
                <th scope="col" className="px-2 py-3 font-medium">
                  Claude Code
                </th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => (
                <tr key={name} className="border-b border-border/60">
                  <th scope="row" className="break-words px-2 py-3 font-medium">
                    {name}
                  </th>
                  {providers.map((provider) => (
                    <td key={provider} className="px-2 py-3 align-top">
                      {cell(name, provider)}
                    </td>
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
            Project trust, account permissions and runtime policy may prevent use. Studio project
            grants apply only to Studio-managed calls.
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
