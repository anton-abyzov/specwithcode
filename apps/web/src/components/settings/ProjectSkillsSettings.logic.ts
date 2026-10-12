import type {
  ProjectSkillPresence,
  ProjectSkillRow,
  ProjectSkillStatus,
} from "@specweave-studio/contracts";
import { normalizeSearchText } from "~/lib/utils";

export interface ProjectSkillsFilter {
  readonly query: string;
  readonly problemsOnly: boolean;
}

/** Rows matching the search box (name, description, provider, source, path) and the problems toggle. */
export function filterProjectSkillRows(
  rows: ReadonlyArray<ProjectSkillRow>,
  filter: ProjectSkillsFilter,
): ReadonlyArray<ProjectSkillRow> {
  const tokens = normalizeSearchText(filter.query).split(" ").filter(Boolean);
  return rows.filter((row) => {
    if (filter.problemsOnly && !row.attention) return false;
    if (tokens.length === 0) return true;
    const haystack = normalizeSearchText(
      [
        row.name,
        row.description ?? "",
        row.status,
        row.lock?.source ?? "",
        row.lock?.tier ?? "",
        row.path ?? "",
        ...row.scopes,
        ...row.providers.map((presence) => presence.label),
      ].join(" "),
    );
    return tokens.every((token) => haystack.includes(token));
  });
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
