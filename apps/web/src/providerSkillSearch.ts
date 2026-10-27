import type { ServerProvider, ServerProviderSkill } from "@specweave-studio/contracts";
import {
  dedupeProviderSkillsByName,
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  isProviderSkillUserInvocable,
  leadingSlashAsSkillMention,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@specweave-studio/client-runtime/providerSkills";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@specweave-studio/shared/searchRanking";

import { COMPOSER_APP_COMMANDS } from "./studio/composerAppCommands";

/** Names a leading `/name` keeps as typed: the composer's own commands and the app's. */
const COMPOSER_OWN_COMMANDS = [
  "model",
  "plan",
  "default",
  ...COMPOSER_APP_COMMANDS.map((entry) => entry.command),
];

/**
 * The message as the provider should get it: a leading `/name` that names one
 * of this provider's skills becomes its `$name` mention, unless the composer,
 * the app or the provider itself owns a command of that name. Claude Code also
 * lists every skill as a slash command, and there `/name` and `$name` run the
 * same skill, so its skill commands still become `$name`: the Claude adapter
 * sends that as the final `/name` block, which survives project context put
 * ahead of the message, where a typed leading `/name` does not.
 */
export function resolveLeadingSkillCommand(
  text: string,
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
): string {
  if (!provider) return text;
  const skills = resolveProviderSkillsForCwd(provider, cwd);
  const slashCommands = resolveProviderSlashCommandsForCwd(provider, cwd);
  const providerCommands =
    provider.driver === "claudeAgent"
      ? getProviderSlashCommandsForSlashMenu(
          slashCommands,
          skills.filter(isProviderSkillUserInvocable),
        )
      : slashCommands;
  return leadingSlashAsSkillMention(text, skills, [
    ...COMPOSER_OWN_COMMANDS,
    ...providerCommands.map((command) => command.name),
  ]);
}

export function scoreProviderSkill(skill: ServerProviderSkill, query: string): number | null {
  const normalizedName = skill.name.toLowerCase();
  const normalizedLabel = formatProviderSkillDisplayName(skill).toLowerCase();
  const normalizedShortDescription = skill.shortDescription?.toLowerCase() ?? "";
  const normalizedDescription = skill.description?.toLowerCase() ?? "";
  const normalizedScope = skill.scope?.toLowerCase() ?? "";

  const scores = [
    scoreQueryMatch({
      value: normalizedName,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: normalizedLabel,
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 5,
      includesBase: 7,
      fuzzyBase: 110,
    }),
    scoreQueryMatch({
      value: normalizedShortDescription,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
    scoreQueryMatch({
      value: normalizedDescription,
      query,
      exactBase: 30,
      prefixBase: 32,
      boundaryBase: 34,
      includesBase: 36,
    }),
    scoreQueryMatch({
      value: normalizedScope,
      query,
      exactBase: 40,
      prefixBase: 42,
      includesBase: 44,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchProviderSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): ServerProviderSkill[] {
  const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\p{Sc}+/u });

  if (!normalizedQuery) {
    return enabledSkills;
  }

  const ranked: Array<{
    item: ServerProviderSkill;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const skill of enabledSkills) {
    const score = scoreProviderSkill(skill, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item: skill,
        score,
        tieBreaker: `${formatProviderSkillDisplayName(skill).toLowerCase()}\u0000${skill.name}`,
      },
      limit,
    );
  }

  return ranked.map((entry) => entry.item);
}
