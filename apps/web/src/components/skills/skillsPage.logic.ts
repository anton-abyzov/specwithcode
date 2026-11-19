import {
  CLAUDE_AI_SKILL_SCOPE,
  isBuiltInAgentSkill,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";

/** Every copy ships with the agent or its account: nothing a person installed. */
export function isBuiltInSkillRow(row: ProjectSkillRow): boolean {
  return (
    row.providers.length > 0 && row.providers.every((presence) => isBuiltInAgentSkill(presence))
  );
}

/** The "Built into the agent" block and the rows a person can manage. */
export function splitBuiltInSkillRows(rows: ReadonlyArray<ProjectSkillRow>): {
  readonly installed: ReadonlyArray<ProjectSkillRow>;
  readonly builtIn: ReadonlyArray<ProjectSkillRow>;
} {
  const installed: ProjectSkillRow[] = [];
  const builtIn: ProjectSkillRow[] = [];
  for (const row of rows) (isBuiltInSkillRow(row) ? builtIn : installed).push(row);
  return { installed, builtIn };
}

/** Where a built-in skill comes from: "claude.ai", or the agent that ships it. */
export function builtInSkillSource(row: ProjectSkillRow): string {
  if (row.providers.some((presence) => presence.scope === CLAUDE_AI_SKILL_SCOPE))
    return CLAUDE_AI_SKILL_SCOPE;
  return [...new Set(row.providers.map((presence) => presence.label))].join(", ");
}

/**
 * Agents this machine has whose scan answered with no skills at all. A scan
 * that failed, timed out or is unsupported did not report zero.
 */
export function emptySkillAgents(snapshot: ProjectSkillsSnapshot): ReadonlyArray<string> {
  return snapshot.providers
    .filter(
      (provider) =>
        (provider.state === "ok" || provider.state === "cached") && provider.skills === 0,
    )
    .map((provider) => provider.label);
}
