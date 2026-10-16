import type {
  ProjectSkillPresence,
  ProjectSkillRow,
  ProjectSkillStatus,
} from "@specweave-studio/contracts";
import { normalizeSearchText } from "~/lib/utils";

export interface ProjectSkillsFilter {
  readonly query: string;
  readonly problemsOnly: boolean;
  /** Agent labels; a row matches when any of them loads it. Empty matches all. */
  readonly providers?: ReadonlyArray<string>;
  /** Levels from {@link projectSkillLevel}; empty matches all. */
  readonly levels?: ReadonlyArray<string>;
  /** Keys from {@link projectSkillTierKey}; empty matches all. */
  readonly tiers?: ReadonlyArray<string>;
}

/** Providers name the same level differently (Codex says `repo`); fold them together. */
export function projectSkillLevel(scope: string | null): string {
  const normalized = (scope ?? "").trim().toLowerCase();
  if (normalized === "") return "other";
  if (normalized === "repo" || normalized === "workspace" || normalized === "local")
    return "project";
  if (normalized === "global" || normalized === "personal") return "user";
  return normalized;
}

/** Every level the row is available at; a lock-only row counts at its lockfile's level. */
export function projectSkillLevels(row: ProjectSkillRow): ReadonlyArray<string> {
  const levels = new Set(row.providers.map((presence) => projectSkillLevel(presence.scope)));
  if (levels.size === 0 && row.lock) levels.add(row.lock.lockScope);
  return [...levels];
}

export const UNLOCKED_TIER = "unlocked";

/** `VERIFIED`, another vskill tier, `untiered` for a lock without one, or {@link UNLOCKED_TIER}. */
export function projectSkillTierKey(row: ProjectSkillRow): string {
  if (!row.lock) return UNLOCKED_TIER;
  return row.lock.tier?.trim().toUpperCase() || "untiered";
}

function rowMatchesAgentAndLevel(
  row: ProjectSkillRow,
  providers: ReadonlyArray<string>,
  levels: ReadonlyArray<string>,
): boolean {
  if (providers.length === 0 && levels.length === 0) return true;
  // Agent and level must hold for the same copy: "Claude at user level", not one of each.
  const matched = row.providers.some(
    (presence) =>
      (providers.length === 0 || providers.includes(presence.label)) &&
      (levels.length === 0 || levels.includes(projectSkillLevel(presence.scope))),
  );
  if (matched || row.providers.length > 0) return matched;
  return providers.length === 0 && row.lock !== null && levels.includes(row.lock.lockScope);
}

/** Rows matching the search box, the problems toggle and the agent, level and tier chips. */
export function filterProjectSkillRows(
  rows: ReadonlyArray<ProjectSkillRow>,
  filter: ProjectSkillsFilter,
): ReadonlyArray<ProjectSkillRow> {
  const tokens = normalizeSearchText(filter.query).split(" ").filter(Boolean);
  const providers = filter.providers ?? [];
  const levels = filter.levels ?? [];
  const tiers = filter.tiers ?? [];
  return rows.filter((row) => {
    if (filter.problemsOnly && !row.attention) return false;
    if (tiers.length > 0 && !tiers.includes(projectSkillTierKey(row))) return false;
    if (!rowMatchesAgentAndLevel(row, providers, levels)) return false;
    if (tokens.length === 0) return true;
    const haystack = normalizeSearchText(
      [
        row.name,
        row.description ?? "",
        row.status,
        row.lock?.source ?? "",
        row.lock?.tier ?? "",
        row.lock?.version ?? "",
        row.path ?? "",
        ...row.scopes,
        ...projectSkillLevels(row),
        ...row.issues,
        ...row.providers.map((presence) => presence.label),
      ].join(" "),
    );
    return tokens.every((token) => haystack.includes(token));
  });
}

export interface ProjectSkillFacetOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

const LEVEL_ORDER = ["project", "user", "plugin"];
const LEVEL_LABELS: Readonly<Record<string, string>> = {
  project: "Project",
  user: "User",
  plugin: "Plugin",
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function facet(
  rows: ReadonlyArray<ProjectSkillRow>,
  keysOf: (row: ProjectSkillRow) => Iterable<string>,
  labelOf: (value: string) => string,
  order: (a: string, b: string) => number,
): ReadonlyArray<ProjectSkillFacetOption> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of new Set(keysOf(row))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.keys()]
    .toSorted(order)
    .map((value) => ({ value, label: labelOf(value), count: counts.get(value)! }));
}

function rankOrder(ranked: ReadonlyArray<string>) {
  const rank = (value: string) => {
    const index = ranked.indexOf(value);
    return index === -1 ? ranked.length : index;
  };
  return (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
}

/** Chip options with how many skills each would show on its own. */
export function projectSkillFacets(rows: ReadonlyArray<ProjectSkillRow>): {
  providers: ReadonlyArray<ProjectSkillFacetOption>;
  levels: ReadonlyArray<ProjectSkillFacetOption>;
  tiers: ReadonlyArray<ProjectSkillFacetOption>;
} {
  return {
    providers: facet(
      rows,
      (row) => row.providers.map((presence) => presence.label),
      (value) => value,
      (a, b) => a.localeCompare(b),
    ),
    levels: facet(
      rows,
      projectSkillLevels,
      (value) => LEVEL_LABELS[value] ?? titleCase(value),
      rankOrder(LEVEL_ORDER),
    ),
    tiers: facet(
      rows,
      (row) => [projectSkillTierKey(row)],
      (value) =>
        value === UNLOCKED_TIER
          ? "Not from vskill"
          : value === "untiered"
            ? "No tier"
            : titleCase(value),
      rankOrder(["VERIFIED", "CERTIFIED", "untiered", UNLOCKED_TIER]),
    ),
  };
}

export interface ProjectSkillSourceLinks {
  /** `owner/repo`, plus `#plugin` when the source names one. */
  readonly label: string;
  readonly repoUrl: string | null;
  /** The skill's page on verified-skill.com; only for skills vskill installed with a tier. */
  readonly registryUrl: string | null;
}

const VERIFIED_SKILL_ORIGIN = "https://verified-skill.com";
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Links for a vskill lock source such as `github:owner/repo`,
 * `github:owner/repo#plugin:name` or `marketplace:owner/repo#plugin`.
 */
export function projectSkillSourceLinks(row: ProjectSkillRow): ProjectSkillSourceLinks | null {
  const source = row.lock?.source?.trim();
  if (!source) return null;
  const match = /^(github|marketplace):([^/#\s]+)\/([^#\s]+?)(?:\.git)?(?:#(.*))?$/.exec(source);
  if (!match || !REPO_SEGMENT.test(match[2]!) || !REPO_SEGMENT.test(match[3]!)) {
    const url = /^https:\/\/\S+$/.test(source) ? source : null;
    return { label: source, repoUrl: url, registryUrl: null };
  }
  const [, kind, owner, repo, fragment] = match;
  const pluginName = fragment?.replace(/^plugin:/, "").trim() || null;
  // A marketplace entry is listed under its plugin; a plugin skill `plugin:skill` under its own name.
  const slug =
    kind === "marketplace" && pluginName ? pluginName : (row.name.split(":").at(-1) ?? row.name);
  return {
    label: `${owner}/${repo}${pluginName ? ` #${pluginName}` : ""}`,
    repoUrl: `https://github.com/${owner}/${repo}`,
    registryUrl: row.lock?.tier
      ? `${VERIFIED_SKILL_ORIGIN}/skills/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/${encodeURIComponent(slug)}`
      : null,
  };
}

export type ProjectSkillBadgeVariant = "success" | "warning" | "error" | "secondary" | "info";

const STATUS_BADGES: Readonly<
  Record<ProjectSkillStatus, { label: string; variant: ProjectSkillBadgeVariant }>
> = {
  ok: { label: "ok", variant: "success" },
  drift: { label: "drift", variant: "warning" },
  duplicate: { label: "duplicate", variant: "error" },
  missing: { label: "missing", variant: "info" },
  disabled: { label: "disabled", variant: "secondary" },
};

/** Status cell: an `ok` row still flagged by `vskill doctor` reads "check". */
export function projectSkillStatusBadge(row: ProjectSkillRow): {
  label: string;
  variant: ProjectSkillBadgeVariant;
} {
  if (row.status === "ok" && row.attention) return { label: "check", variant: "warning" };
  return STATUS_BADGES[row.status];
}

/** One badge per provider, merging instances of the same agent that load the same file. */
export function projectSkillProviderBadges(
  row: ProjectSkillRow,
): ReadonlyArray<{ key: string; label: string; enabled: boolean; title: string }> {
  const byLabel = new Map<string, Array<ProjectSkillPresence>>();
  for (const presence of row.providers) {
    const list = byLabel.get(presence.label) ?? [];
    list.push(presence);
    byLabel.set(presence.label, list);
  }
  return [...byLabel.entries()].map(([label, presences]) => {
    const enabled = presences.some((presence) => presence.enabled);
    const details = presences.map(
      (presence) =>
        `${presence.scope ?? "unscoped"}: ${presence.path}${presence.enabled ? "" : " (off)"}`,
    );
    return {
      key: `${label}:${presences[0]!.instanceId}`,
      label,
      enabled,
      title: `${label}${enabled ? "" : " (switched off)"}\n${details.join("\n")}`,
    };
  });
}

export function projectSkillAttentionCount(rows: ReadonlyArray<ProjectSkillRow>): number {
  return rows.filter((row) => row.attention).length;
}
