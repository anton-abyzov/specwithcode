import type { ProjectSkillPresence, ProjectSkillRow } from "@specweave-studio/contracts";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import { Badge } from "../ui/badge";
import { builtInSkillSource, emptySkillAgents } from "./skillsPage.logic";

/**
 * "Built into the agent": skills that come with an agent or its account
 * (claude.ai sync, Codex system skills). Listed so the page matches what the
 * agent loads; never installed, switched or edited from here.
 */
export function SkillsBuiltInBlock({
  rows,
  onOpen,
  renderAgent,
}: {
  rows: ReadonlyArray<ProjectSkillRow>;
  onOpen: (name: string) => void;
  renderAgent: (presence: ProjectSkillPresence) => ReactNode;
}) {
  const tx = useTx();
  if (rows.length === 0) return null;
  return (
    <section
      className="space-y-2 px-3 pb-3 sm:px-4"
      aria-label={tx("Built into the agent")}
      data-testid="skills-built-in"
    >
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {tx("Built into the agent")}{" "}
          <span className="font-normal text-muted-foreground">{rows.length}</span>
        </h3>
        <p className="text-xs text-muted-foreground">
          {tx(
            "These come with the agent or its account. They are listed so you can see what it loads, and cannot be installed, switched off or edited here.",
          )}
        </p>
      </div>
      <ul className="divide-y rounded-lg border">
        {rows.map((row) => (
          <li
            key={row.name}
            data-skill={row.name}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1 basis-56">
              <button
                type="button"
                className="block max-w-full truncate text-left font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
                onClick={() => onOpen(row.name)}
              >
                {row.name}
              </button>
              {row.description ? (
                <div className="truncate text-xs text-muted-foreground">{row.description}</div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {row.providers.map((presence) => (
                <Badge key={`${presence.instanceId}:${presence.path}`} size="sm" variant="outline">
                  {renderAgent(presence)}
                  {presence.label}
                </Badge>
              ))}
            </div>
            <span className="text-xs text-muted-foreground" data-testid="skill-built-in-source">
              {tx("Source")}: {builtInSkillSource(row)}
            </span>
            <Badge size="sm" variant="secondary">
              {tx("Read only")}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Footer lines for agents this machine has that report no skills at all. */
export function SkillsEmptyAgents({
  snapshot,
  machine,
}: {
  snapshot: Parameters<typeof emptySkillAgents>[0];
  machine: string;
}) {
  const tx = useTx();
  const agents = emptySkillAgents(snapshot);
  if (agents.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="skills-empty-agents">
      {agents.map((agent) => (
        <p key={agent}>{tx("{agent}: no skills installed on {machine}", { agent, machine })}</p>
      ))}
    </div>
  );
}
