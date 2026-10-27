import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@specweave-studio/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

/**
 * The text that runs a skill in any thread: the `$name` mention a composer pick
 * inserts and every provider adapter dispatches. It uses the provider's own id
 * (`sw:do`, `review`), never the display name, which may hold spaces.
 */
export function providerSkillInvocation(skill: Pick<ServerProviderSkill, "name">): string {
  return `$${skill.name}`;
}

/**
 * The provider's display name when it says more than the id (Codex
 * `interface.display_name`), else null: a title-cased id adds nothing beside
 * the invocation.
 */
export function providerSkillDistinctDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string | null {
  const displayName = skill.displayName?.trim();
  if (!displayName) return null;
  const folded = displayName.toLowerCase();
  return folded === skill.name.trim().toLowerCase() ||
    folded === titleCaseWords(skill.name).toLowerCase()
    ? null
    : displayName;
}

const LEADING_SLASH_TOKEN = /^(\s*)\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/;

/**
 * A message that opens with `/name`, where name is exactly (case included) one of the
 * provider's runnable skills, goes out as the `$name` mention a pick inserts,
 * so `/sw:do 0042` runs the skill on providers whose turns do not expand slash
 * text (the Codex app server, ACP agents). A provider or app command of that
 * name keeps the text as typed, as does any name that is not a known skill.
 */
export function leadingSlashAsSkillMention(
  text: string,
  skills: ReadonlyArray<ServerProviderSkill>,
  reservedCommands: ReadonlyArray<string>,
): string {
  const match = LEADING_SLASH_TOKEN.exec(text);
  if (!match) return text;
  const typed = match[2]!;
  // Reserved names match in any case, so `/Continue` never becomes a mention;
  // a skill id must match exactly.
  const reserved = reservedCommands.some(
    (command) => command.replace(/^\/+/, "").trim().toLowerCase() === typed.toLowerCase(),
  );
  if (reserved) return text;
  const skill = skills.find(
    (candidate) => isProviderSkillUserInvocable(candidate) && candidate.name.trim() === typed,
  );
  if (!skill) return text;
  return `${match[1]}${providerSkillInvocation(skill)}${text.slice(match[0].length)}`;
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Whether a composer pick can start this skill. A skill switched off in the
 * provider's settings will not run, and one the provider reserves for the
 * agent (Claude Code's `user-invocable: false`) rejects a user invocation.
 * Everything else, including skills the agent may not start on its own, is
 * fair game: the server dispatches the pick in the provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    // Claude Code plugin skills (`<plugin>:<skill>`), which may load from a
    // local marketplace folder outside any plugins cache path.
    case "plugin":
      return "app";
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function hasCompleteProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(snapshot && !snapshot.slashCommandsPending);
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}
