import type {
  ProjectSkillPresence,
  ProjectSkillRow,
  ProjectSkillsSnapshot,
  ServerProviderSkill,
} from "@specweave-studio/contracts";
import { claudeSkillInvocation } from "@specweave-studio/shared/toolActivity";

import type { TimelineEntry } from "../../session-logic";
import { normalizeSearchText } from "~/lib/utils";
import { projectSkillLevel, projectSkillLevelLabel } from "../settings/ProjectSkillsSettings.logic";

/** Above this many skills the popover offers a search box. */
export const COMPOSER_SKILLS_SEARCH_THRESHOLD = 12;

/**
 * A skill this session used: a Claude `Skill` tool call (`tool`) or a
 * `$name` token in a message the person sent (`token`).
 */
export interface SessionSkillUse {
  readonly name: string;
  readonly via: "tool" | "token";
}

// Same token rule as the timeline's skill chips (SkillInlineText.tsx).
const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/** `$name` tokens in a message, in order, without repeats. */
export function skillTokensInText(text: string): ReadonlyArray<string> {
  const names: string[] = [];
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Skills the loaded part of a thread used, first use first. A name used both
 * ways keeps the tool call, which shows the agent actually loaded it.
 */
export function collectSessionSkillUses(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<SessionSkillUse> {
  const byName = new Map<string, SessionSkillUse["via"]>();
  for (const entry of entries) {
    if (entry.kind === "work") {
      const payload = entry.entry.structuredPayload;
      if (payload?.type !== "dynamic_tool") continue;
      const skill = claudeSkillInvocation(payload.toolName, payload.input);
      if (skill) byName.set(skill.name, "tool");
    } else if (entry.kind === "message" && entry.message.role === "user") {
      for (const name of skillTokensInText(entry.message.text))
        if (!byName.has(name)) byName.set(name, "token");
    }
  }
  return [...byName].map(([name, via]) => ({ name, via }));
}

/** A stable key for {@link collectSessionSkillUses}, so callers can skip equal results. */
export function sessionSkillUsesKey(uses: ReadonlyArray<SessionSkillUse>): string {
  return uses.map((use) => `${use.via}:${use.name}`).join("\n");
}

export type ComposerSkillGroupId = "used" | "project" | "user" | "plugin" | "other";

const GROUP_ORDER: ReadonlyArray<ComposerSkillGroupId> = [
  "used",
  "project",
  "user",
  "plugin",
  "other",
];

const GROUP_LABELS: Readonly<Record<ComposerSkillGroupId, string>> = {
  used: "Used in this session",
  project: "Project",
  user: "User",
  plugin: "Plugin",
  other: "Other",
};

export interface ComposerSkillVersion {
  /** The version text, or null when nothing records one ("untracked"). */
  readonly value: string | null;
  readonly source: "lockfile" | "plugin" | "file" | null;
  readonly note?: string;
}

export interface ComposerSkillItem {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly path: string | null;
  readonly enabled: boolean;
  /** Level from {@link projectSkillLevel}: project, user, plugin, bundled, ... */
  readonly level: string;
  readonly levelLabel: string;
  /** Null until the versions snapshot answers. */
  readonly version: ComposerSkillVersion | null;
  readonly used: SessionSkillUse["via"] | null;
  /** Used by name in this session, but this agent lists no skill by that name here. */
  readonly missing: boolean;
}

export interface ComposerSkillGroup {
  readonly id: ComposerSkillGroupId;
  readonly label: string;
  readonly items: ReadonlyArray<ComposerSkillItem>;
}

function rowMatches(row: ProjectSkillRow, name: string): boolean {
  return (
    row.name === name ||
    (row.aliases?.includes(name) ?? false) ||
    row.providers.some((presence) => presence.name === name)
  );
}

/** Read the exact copy the agent lists. A merged lock is only a verified fallback. */
export function composerSkillVersion(
  snapshot: Pick<ProjectSkillsSnapshot, "rows">,
  instanceId: string | null,
  skill: Pick<ServerProviderSkill, "name" | "path">,
): ComposerSkillVersion {
  const rows = snapshot.rows.filter((row) => rowMatches(row, skill.name));
  const presenceOf = (row: ProjectSkillRow): ProjectSkillPresence | undefined =>
    row.providers.find(
      (presence) => presence.instanceId === instanceId && presence.path === skill.path,
    );
  const row = rows.find((candidate) => presenceOf(candidate) !== undefined);
  if (!row) return { value: null, source: null };
  const presence = presenceOf(row)!;
  const level = projectSkillLevel(presence.scope, presence.path);
  const matchingLock = row.lock?.lockScope === level ? row.lock : null;
  const observed = presence.pluginVersion
    ? { value: presence.pluginVersion, source: "plugin" as const }
    : presence.fileVersion
      ? { value: presence.fileVersion, source: "file" as const }
      : null;
  const note = row.divergent
    ? "copies differ"
    : row.drift === "drift"
      ? "modified"
      : matchingLock?.version && observed && matchingLock.version !== observed.value
        ? `locked v${matchingLock.version}`
        : undefined;
  if (observed) return { ...observed, ...(note ? { note } : {}) };
  if (matchingLock?.version && row.drift === "match" && !row.divergent && row.copies === 1)
    return { value: matchingLock.version, source: "lockfile" };
  return { value: null, source: null, ...(note ? { note } : {}) };
}

function groupOfLevel(level: string): ComposerSkillGroupId {
  return level === "project" || level === "user" || level === "plugin" ? level : "other";
}

function matchesQuery(item: ComposerSkillItem, query: string): boolean {
  if (query === "") return true;
  return [item.name, item.displayName, item.description ?? "", item.levelLabel].some((value) =>
    normalizeSearchText(value).includes(query),
  );
}

/**
 * The popover's groups: skills this session used first, then the agent's
 * skills by level. Each skill appears once; a used name this agent does not
 * list is kept only when a tool call loaded it, since a `$word` alone may not
 * be a skill. Empty groups are left out.
 */
export function buildComposerSkillGroups(input: {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly instanceId: string | null;
  readonly snapshot: Pick<ProjectSkillsSnapshot, "rows"> | null;
  readonly uses: ReadonlyArray<SessionSkillUse>;
  readonly query?: string;
}): ReadonlyArray<ComposerSkillGroup> {
  const query = normalizeSearchText(input.query ?? "").trim();
  const usedBy = new Map(input.uses.map((use) => [use.name, use.via] as const));
  const toItem = (skill: ServerProviderSkill): ComposerSkillItem => {
    const level = projectSkillLevel(skill.scope ?? null, skill.path);
    return {
      name: skill.name,
      displayName: skill.displayName ?? skill.name,
      description: skill.shortDescription ?? skill.description ?? null,
      path: skill.path,
      enabled: skill.enabled,
      level,
      levelLabel: projectSkillLevelLabel(level),
      version: input.snapshot
        ? composerSkillVersion(input.snapshot, input.instanceId, skill)
        : null,
      used: usedBy.get(skill.name) ?? null,
      missing: false,
    };
  };
  const items = input.skills.map(toItem);
  const listed = new Set(items.map((item) => item.name));
  const missing: ComposerSkillItem[] = input.uses
    .filter((use) => use.via === "tool" && !listed.has(use.name))
    .map((use) => ({
      name: use.name,
      displayName: use.name,
      description: null,
      path: null,
      enabled: true,
      level: "other",
      levelLabel: "Not listed",
      version: input.snapshot ? { value: null, source: null } : null,
      used: use.via,
      missing: true,
    }));

  const usedOrder = new Map(input.uses.map((use, index) => [use.name, index] as const));
  const byGroup = new Map<ComposerSkillGroupId, ComposerSkillItem[]>();
  for (const item of [...items, ...missing]) {
    if (!matchesQuery(item, query)) continue;
    const group = item.used ? "used" : groupOfLevel(item.level);
    const list = byGroup.get(group) ?? [];
    list.push(item);
    byGroup.set(group, list);
  }
  return GROUP_ORDER.flatMap((id) => {
    const list = byGroup.get(id);
    if (!list || list.length === 0) return [];
    const sorted =
      id === "used"
        ? list.toSorted((a, b) => (usedOrder.get(a.name) ?? 0) - (usedOrder.get(b.name) ?? 0))
        : list.toSorted(
            (a, b) =>
              Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName),
          );
    return [{ id, label: GROUP_LABELS[id], items: sorted }];
  });
}

/** "Claude on Anton's M4 · specweave-umb" */
export function composerSkillsHeading(input: {
  readonly agent: string;
  readonly machine: string | null;
  readonly cwd: string | null;
}): string {
  const folder = input.cwd ? folderBasename(input.cwd) : null;
  const where = input.machine ? `${input.agent} on ${input.machine}` : input.agent;
  return folder ? `${where} · ${folder}` : where;
}

export function folderBasename(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts.at(-1) || trimmed || cwd;
}

/**
 * Why this agent's skill list cannot be trusted, or null. A provider in an
 * error state, or a folder scan that failed or timed out, is a discovery
 * failure: the list may be empty because the scan failed, not because the
 * folder has no skills.
 */
export function composerSkillsDiscoveryError(input: {
  readonly providerStatus: string | null;
  readonly providerMessage: string | null;
  readonly instanceId: string | null;
  readonly snapshot: Pick<ProjectSkillsSnapshot, "providers"> | null;
}): string | null {
  if (input.providerStatus === "error")
    return input.providerMessage?.trim() || "This agent could not list its skills.";
  const state = input.snapshot?.providers.find(
    (provider) => provider.instanceId === input.instanceId,
  );
  if (state && (state.state === "error" || state.state === "timeout"))
    return state.message?.trim() || "The skill scan for this folder failed.";
  return null;
}

/**
 * How many skills this session used, counted as the "Used in this session"
 * group shows them: listed skills, plus tool-call uses of unlisted ones. A
 * `$HOME` typed in a message is not a skill and is not counted.
 */
export function countSessionSkillsUsed(
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name">>,
  uses: ReadonlyArray<SessionSkillUse>,
): number {
  const listed = new Set(skills.map((skill) => skill.name));
  return new Set(
    uses.filter((use) => use.via === "tool" || listed.has(use.name)).map((use) => use.name),
  ).size;
}

/** The reason code of a failed skills read, or null. */
export function composerSkillsFailureReason(failure: unknown): string | null {
  if (typeof failure !== "object" || failure === null || !("reason" in failure)) return null;
  return typeof failure.reason === "string" ? failure.reason : null;
}

/**
 * The footer line shown when versions could not be read. A folder the server
 * does not know yet, such as a new thread's worktree before it is recorded,
 * is normal, so it gets a neutral line instead of the server's refusal.
 */
export function composerSkillsVersionsNote(input: {
  readonly reason: string | null;
  readonly error: string;
}): string {
  return input.reason === "cwd_not_allowed"
    ? "Versions appear once this thread's folder is ready."
    : `Versions unavailable: ${input.error}`;
}

/**
 * What Rescan asks for. The server rescan scans every agent in the folder and
 * so refreshes the composer's list too, but only for a folder it accepts.
 * When it refuses the folder, or there is no project or answer yet, the
 * composer's own agent is asked for a fresh scan of its folder.
 */
export function composerSkillsRescanPlan(input: {
  readonly projectId: string | null;
  readonly failureReason: string | null;
  readonly hasSnapshot: boolean;
  readonly instanceId: string | null;
  readonly cwd: string | null;
}): { readonly server: boolean; readonly providers: boolean } {
  const server = input.projectId !== null && input.failureReason !== "cwd_not_allowed";
  const providers =
    input.instanceId !== null && input.cwd !== null && (!server || !input.hasSnapshot);
  return { server, providers };
}
