import { isListableSkillPath } from "@specweave-studio/contracts";
import type {
  ProjectSkillPresence,
  ProjectSkillRow,
  ProjectSkillsSnapshot,
  ServerProviderSkill,
} from "@specweave-studio/contracts";
import { claudeSkillInvocation } from "@specweave-studio/shared/toolActivity";

import type { TimelineEntry } from "../../session-logic";
import { paginate, type Page } from "~/lib/pagination";
import { normalizeSearchText } from "~/lib/utils";
import {
  projectSkillLevel,
  projectSkillLevelLabel,
  projectSkillSourceLinks,
} from "../settings/ProjectSkillsSettings.logic";

/** Above this many skills the popover offers a search box. */
export const COMPOSER_SKILLS_SEARCH_THRESHOLD = 12;
/** Rows per page of the popover; search runs over every skill first. */
export const COMPOSER_SKILLS_PAGE_SIZE = 20;

/** A skill the agent advertises as a command, with no file path of its own. */
export function isAdvertisedSkillPath(path: string): boolean {
  return /^acp:\/\/(?:command|skill)\//.test(path);
}

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

export type ComposerSkillGroupId =
  | "used"
  | "project"
  | "user"
  | "plugin"
  | "system"
  | "bundled"
  | "several"
  | "unknown"
  | "other";

const GROUP_ORDER: ReadonlyArray<ComposerSkillGroupId> = [
  "used",
  "project",
  "user",
  "plugin",
  "system",
  "bundled",
  "several",
  "unknown",
  "other",
];

const GROUP_LABELS: Readonly<Record<ComposerSkillGroupId, string>> = {
  used: "Used in this session",
  project: "Project",
  user: "User",
  plugin: "Plugin",
  system: "System",
  bundled: "Bundled",
  several: "Several matching files",
  unknown: "Location unknown",
  other: "Other",
};

export interface ComposerSkillVersion {
  /** The version text, or null when nothing records one. */
  readonly value: string | null;
  readonly source: "lockfile" | "plugin" | "file" | null;
  readonly note?: string;
}

/** A file on this machine that an advertised skill's name matches. */
export interface ComposerSkillFile {
  readonly path: string;
  /** Level from {@link projectSkillLevel}. */
  readonly level: string;
  readonly levelLabel: string;
  /** Null when the file states none; undefined when the file was not read. */
  readonly version: string | null | undefined;
  /** The source of a lock of the file's own scope that lists it, else null. */
  readonly lockSource: string | null;
  /** The row has a lock, but it is another copy's. */
  readonly otherLock: boolean;
  /** The name Settings lists the file under; it can differ from the advertised name in case. */
  readonly rowName: string;
}

/**
 * Where a skill's file is, and how the popover knows:
 * `reported` the agent reported the file's path itself;
 * `matched` the agent advertised only a name, and the app found exactly one file under that name
 *   in the folders it scanned for this agent (a match by name, not the agent's own word);
 * `several` more than one such file, so none is picked;
 * `unknown` the agent lists it and no scanned folder holds a file by that name;
 * `pending` the folder inventory has not answered yet;
 * `unread` the inventory is not available, so nothing is claimed.
 */
export type ComposerSkillLocation =
  | { readonly kind: "reported" }
  | { readonly kind: "matched"; readonly file: ComposerSkillFile }
  | { readonly kind: "several"; readonly files: ReadonlyArray<ComposerSkillFile> }
  | { readonly kind: "unknown" }
  | { readonly kind: "pending" }
  | { readonly kind: "unread" };

export interface ComposerSkillItem {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly searchText?: string;
  readonly path: string | null;
  readonly enabled: boolean;
  /** Level from {@link projectSkillLevel}, or `several`, `unknown`, `pending`, `unread`. */
  readonly level: string;
  readonly levelLabel: string;
  readonly location: ComposerSkillLocation;
  /** Null until the versions snapshot answers. */
  readonly version: ComposerSkillVersion | null;
  /** The second line of the row: version, lock and how the file was found. */
  readonly detail: string;
  /** False when Settings has no row to open for it. */
  readonly inSettings: boolean;
  /** The row to open in Settings, when its name is not the listed name. */
  readonly settingsName?: string;
  readonly used: SessionSkillUse["via"] | null;
  /** Used by name in this session, but this agent lists no skill by that name here. */
  readonly missing: boolean;
}

export interface ComposerSkillGroup {
  readonly id: ComposerSkillGroupId;
  readonly label: string;
  readonly items: ReadonlyArray<ComposerSkillItem>;
  /** How many skills the whole group holds, when `items` is one page of it. */
  readonly total?: number;
}

function rowMatches(row: ProjectSkillRow, name: string): boolean {
  return (
    row.name === name ||
    (row.aliases?.includes(name) ?? false) ||
    row.providers.some((presence) => presence.name === name)
  );
}

/** Read the exact copy the agent lists. A merged lock is only a verified fallback. */
/**
 * Whether the row's lock is this copy's lock: the copy's own level, and, when
 * the lock names its folder, a copy inside that folder.
 */
function lockCovers(row: ProjectSkillRow, level: string, path: string): boolean {
  if (!row.lock || row.lock.lockScope !== level) return false;
  return row.lock.lockedPaths === undefined || row.lock.lockedPaths.includes(path);
}

/** The row has a lock and it does not cover this copy. */
function lockOfAnotherCopy(row: ProjectSkillRow, level: string, path: string): boolean {
  return row.lock !== null && !lockCovers(row, level, path);
}

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
  const matchingLock = lockCovers(row, level, presence.path) ? row.lock : null;
  const observed = presence.pluginVersion
    ? { value: presence.pluginVersion, source: "plugin" as const }
    : presence.fileVersion
      ? { value: presence.fileVersion, source: "file" as const }
      : null;
  const note = row.divergent
    ? "copies differ"
    : // Drift is measured against the lock: it says nothing of a copy the lock does not cover.
      // Drift is one answer for the row, so with several copies it names no single file.
      row.drift === "drift" && matchingLock && row.copies === 1
      ? "modified"
      : matchingLock?.version && observed && matchingLock.version !== observed.value
        ? `locked v${matchingLock.version}`
        : undefined;
  if (observed) return { ...observed, ...(note ? { note } : {}) };
  if (matchingLock?.version && row.drift === "match" && !row.divergent && row.copies === 1)
    return { value: matchingLock.version, source: "lockfile" };
  return { value: null, source: null, ...(note ? { note } : {}) };
}

/**
 * The agent's skills, each once. Copies of one file the agent reported by path
 * form one entry, as in Settings. A skill the agent only advertises by name is
 * keyed by that exact name: a name is not proof that two commands are one file.
 */
export function composerSkillCatalog(
  skills: ReadonlyArray<ServerProviderSkill>,
  instanceId: string | null,
  snapshot: Pick<ProjectSkillsSnapshot, "rows"> | null,
): ReadonlyArray<ServerProviderSkill> {
  const catalog = new Map<string, ServerProviderSkill>();
  for (const skill of skills) {
    const advertised = isAdvertisedSkillPath(skill.path);
    if (!advertised && !isListableSkillPath(skill.path)) continue;
    const row = advertised
      ? undefined
      : snapshot?.rows.find((candidate) =>
          candidate.providers.some(
            (presence) => presence.instanceId === instanceId && presence.path === skill.path,
          ),
        );
    const key = row ? `row:${row.name}` : `name:${skill.name}`;
    const previous = catalog.get(key);
    // Preserve the first enabled native invocation and its path, not a cross-agent display name.
    if (!previous || (!previous.enabled && skill.enabled)) catalog.set(key, skill);
  }
  return [...catalog.values()];
}

/**
 * Files the app found for this agent instance under exactly `name`: the copy
 * the scan lists first, then same-named files in lower-priority folders. Names
 * that differ only in case count too, so a collision is shown instead of
 * resolved. Another agent's files and other names of the same row never match.
 */
export function composerSkillFilesNamed(
  snapshot: Pick<ProjectSkillsSnapshot, "rows">,
  instanceId: string | null,
  name: string,
): ReadonlyArray<ComposerSkillFile> {
  const wanted = name.toLowerCase();
  const files = new Map<string, ComposerSkillFile>();
  const add = (
    row: ProjectSkillRow,
    path: string,
    scope: string | null,
    version: string | null | undefined,
  ) => {
    if (isAdvertisedSkillPath(path) || files.has(path)) return;
    const level = projectSkillLevel(scope, path);
    files.set(path, {
      path,
      level,
      levelLabel: projectSkillLevelLabel(level),
      version,
      lockSource: lockCovers(row, level, path)
        ? (projectSkillSourceLinks(row)?.label ?? row.lock?.source ?? "vskill")
        : null,
      otherLock: lockOfAnotherCopy(row, level, path),
      rowName: row.name,
    });
  };
  for (const row of snapshot.rows)
    for (const presence of row.providers) {
      if (presence.instanceId !== instanceId) continue;
      if ((presence.name ?? row.name).toLowerCase() !== wanted) continue;
      add(
        row,
        presence.path,
        presence.scope,
        presence.pluginVersion ?? presence.fileVersion ?? null,
      );
      // Lower-priority copies were found but not read, so their version is not known.
      for (const copy of presence.otherCopies ?? []) add(row, copy.path, copy.scope, undefined);
    }
  return [...files.values()];
}

const LOCKABLE_LEVELS = new Set(["project", "user"]);

/** "v1.2.0", "no version", or nothing when the file was not read. */
function versionWords(version: string | null | undefined): string | null {
  if (version === undefined) return null;
  return version ? `v${version.replace(/^v/i, "")}` : "no version";
}

/**
 * `otherLock`: the row's one lock is another copy's (another level or folder).
 * A row keeps a single lock, so whether this copy has an entry of its own in
 * some other lock file is not in this read.
 */
function lockWords(level: string, lockSource: string | null, otherLock = false): string | null {
  if (!LOCKABLE_LEVELS.has(level)) return null;
  return lockSource ? `lock: ${lockSource}` : otherLock ? "lock status unknown" : "no lock entry";
}

function groupOfLevel(level: string): ComposerSkillGroupId {
  return level === "project" ||
    level === "user" ||
    level === "plugin" ||
    level === "system" ||
    level === "bundled" ||
    level === "several" ||
    level === "unknown"
    ? level
    : "other";
}

function matchesQuery(item: ComposerSkillItem, query: string): boolean {
  if (query === "") return true;
  const haystack = normalizeSearchText(
    [
      item.name,
      item.displayName,
      item.description ?? "",
      item.searchText ?? "",
      item.levelLabel,
      item.detail,
    ].join(" "),
  );
  return query.split(/\s+/).every((token) => haystack.includes(token));
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
  readonly snapshot:
    | (Pick<ProjectSkillsSnapshot, "rows"> & Partial<Pick<ProjectSkillsSnapshot, "providers">>)
    | null;
  /**
   * False once the folder inventory is known to be unavailable (it failed, or
   * there is no project). Then a missing snapshot is "not read", not "checking".
   */
  readonly snapshotPending?: boolean;
  readonly uses: ReadonlyArray<SessionSkillUse>;
  readonly query?: string;
}): ReadonlyArray<ComposerSkillGroup> {
  const query = normalizeSearchText(input.query ?? "").trim();
  const usedBy = new Map(input.uses.map((use) => [use.name, use.via] as const));
  const pending = input.snapshotPending !== false;
  const located = (
    skill: ServerProviderSkill,
  ): Pick<ComposerSkillItem, "level" | "levelLabel" | "location" | "version" | "detail"> => {
    const snapshot = input.snapshot;
    if (!isAdvertisedSkillPath(skill.path)) {
      // The agent reported this file itself.
      const level = projectSkillLevel(skill.scope ?? null, skill.path);
      const version = snapshot ? composerSkillVersion(snapshot, input.instanceId, skill) : null;
      const row = snapshot?.rows.find((candidate) =>
        candidate.providers.some(
          (presence) => presence.instanceId === input.instanceId && presence.path === skill.path,
        ),
      );
      const lockSource =
        row?.lock && lockCovers(row, level, skill.path)
          ? (projectSkillSourceLinks(row)?.label ?? row.lock.source ?? "vskill")
          : null;
      const words = version
        ? [
            version.value ? `v${version.value.replace(/^v/i, "")}` : "no version",
            ...(version.note && version.note !== "copies differ" ? [version.note] : []),
            ...(row
              ? [
                  lockWords(level, lockSource, lockOfAnotherCopy(row, level, skill.path)) ?? [],
                ].flat()
              : []),
          ]
        : pending
          ? ["Checking…"]
          : [];
      return {
        level,
        levelLabel: projectSkillLevelLabel(level),
        location: { kind: "reported" },
        version,
        detail: words.join(" · "),
      };
    }
    // The agent advertised a name only: nothing here is the agent's own word about a file.
    if (!snapshot)
      return pending
        ? {
            level: "pending",
            levelLabel: "Checking…",
            location: { kind: "pending" },
            version: null,
            detail: "Listed by the agent. Looking for its file…",
          }
        : {
            level: "unread",
            levelLabel: "Not checked",
            location: { kind: "unread" },
            version: null,
            detail:
              "Listed by the agent. Skill folders were not read, so its location is not known.",
          };
    const files = composerSkillFilesNamed(snapshot, input.instanceId, skill.name);
    // A scan that could not open every folder proves neither absence nor a single copy.
    const partial =
      snapshot.providers?.find((provider) => provider.instanceId === input.instanceId)
        ?.incomplete === true;
    if (files.length === 0)
      return {
        level: "unknown",
        levelLabel: "Location unknown",
        location: { kind: "unknown" },
        version: { value: null, source: null },
        detail: partial
          ? "Listed by the agent. No file found, but some skill folders could not be opened."
          : "Listed by the agent. No file found under this name.",
      };
    if (files.length === 1 && partial) {
      const found = files[0]!;
      return {
        level: "several",
        levelLabel: "1 file found",
        location: { kind: "several", files },
        version: { value: null, source: null },
        detail: `Found at ${[found.levelLabel, versionWords(found.version)]
          .filter(Boolean)
          .join(" ")}. Some skill folders could not be opened, so another copy may exist.`,
      };
    }
    if (files.length > 1)
      return {
        level: "several",
        levelLabel: `${files.length} matching files`,
        location: { kind: "several", files },
        version: { value: null, source: null },
        detail: `Found at ${files
          .map((file) => [file.levelLabel, versionWords(file.version)].filter(Boolean).join(" "))
          .join(", ")}. The agent does not report which it uses.`,
      };
    const file = files[0]!;
    const row = snapshot.rows.find((candidate) =>
      candidate.providers.some(
        (presence) => presence.instanceId === input.instanceId && presence.path === file.path,
      ),
    );
    // The same reading as a file the agent reported: the file's version, else a
    // clean lock's, with "locked vX" when the two disagree.
    const version = row
      ? composerSkillVersion(snapshot, input.instanceId, { name: row.name, path: file.path })
      : { value: file.version ?? null, source: file.version ? ("file" as const) : null };
    const note = version.note;
    return {
      level: file.level,
      levelLabel: file.levelLabel,
      location: { kind: "matched", file },
      version,
      detail: [
        "Matching file",
        version.source === "lockfile"
          ? `${versionWords(version.value)} from lock`
          : versionWords(version.value),
        ...(note && note !== "copies differ" ? [note] : []),
        lockWords(file.level, file.lockSource, file.otherLock),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  };
  const toItem = (skill: ServerProviderSkill): ComposerSkillItem => {
    const where = located(skill);
    const settingsName =
      where.location.kind === "matched"
        ? where.location.file.rowName
        : where.location.kind === "several"
          ? where.location.files[0]?.rowName
          : undefined;
    return {
      name: skill.name,
      displayName: skill.displayName ?? skill.name,
      description: skill.shortDescription ?? skill.description ?? null,
      searchText: [skill.name, skill.description, skill.shortDescription].filter(Boolean).join(" "),
      path: skill.path,
      enabled: skill.enabled,
      ...where,
      // A skill with no file has no row in Settings to open.
      inSettings:
        where.location.kind === "reported" ||
        where.location.kind === "matched" ||
        where.location.kind === "several",
      ...(settingsName && settingsName !== skill.name ? { settingsName } : {}),
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
      levelLabel: "Not in this list",
      location: { kind: "unread" } as const,
      version: input.snapshot ? { value: null, source: null } : null,
      detail: "Used in this session. It is not in the list read just now.",
      inSettings: false,
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

/** One page of the popover's groups, cut after search, with each group's own total kept. */
export interface ComposerSkillPage {
  readonly groups: ReadonlyArray<ComposerSkillGroup>;
  readonly page: Omit<Page<ComposerSkillItem>, "items">;
}

/**
 * Pages groups that were already filtered and sorted. Rows keep their order
 * across pages; a group that continues from the previous page shows again with
 * its heading, and every heading carries the whole group's count.
 */
export function pageComposerSkillGroups(
  groups: ReadonlyArray<ComposerSkillGroup>,
  page: number,
  pageSize: number = COMPOSER_SKILLS_PAGE_SIZE,
): ComposerSkillPage {
  const flat = groups.flatMap((group) => group.items.map((item) => ({ group, item })));
  const { items, ...rest } = paginate(flat, page, pageSize);
  const paged: Array<{ group: ComposerSkillGroup; items: Array<ComposerSkillItem> }> = [];
  for (const { group, item } of items) {
    const last = paged.at(-1);
    if (last?.group === group) last.items.push(item);
    else paged.push({ group, items: [item] });
  }
  return {
    groups: paged.map(({ group, items: shown }) => ({
      id: group.id,
      label: group.label,
      items: shown,
      total: group.items.length,
    })),
    page: rest,
  };
}

/**
 * One line under the heading: whose list this is and how far it can be trusted.
 * `machine`: the agent keeps one list for the whole machine (it advertises its
 * skills as commands), so the list is not a reading of this folder.
 */
export function composerSkillsSourceLine(input: {
  readonly agent: string;
  readonly machine: string | null;
  readonly listScope: "machine" | "folder";
}): string {
  if (input.listScope === "machine")
    return `${input.agent}'s own list for ${input.machine ?? "this machine"}, not checked for this folder. Files, versions and locks come from the app's scan of its skill folders.`;
  return `${input.agent}'s own list for this folder.`;
}

/** `machine` when the agent's list is one per machine, not one per folder. */
export function composerSkillsListScope(input: {
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "path">>;
  readonly workspaceDiscovery: "machine" | null | undefined;
}): "machine" | "folder" {
  return input.workspaceDiscovery === "machine" ||
    input.skills.some((skill) => isAdvertisedSkillPath(skill.path))
    ? "machine"
    : "folder";
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
