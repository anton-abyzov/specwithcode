import { normalizeSearchText } from "~/lib/utils";

/**
 * One search model for every settings surface: app Settings, Project settings
 * and the command palette. A section is the root of its rows, so a query that
 * names a section returns that section first with its rows grouped under it.
 */
export interface SearchableSettingsSection<Section extends string> {
  readonly section: Section;
  readonly label: string;
  readonly searchTerms?: ReadonlyArray<string>;
}

export interface SearchableSettingsRow {
  readonly id: string;
  readonly title: string;
  readonly searchTerms?: ReadonlyArray<string>;
  /** Sorts after every other match in its group. */
  readonly secondary?: boolean;
}

export type GroupedSettingsSearchResult<Section extends string, Row> =
  | {
      readonly kind: "section";
      readonly id: string;
      readonly section: Section;
      readonly label: string;
      /** The query names this section, not only some of its rows. */
      readonly matched: boolean;
    }
  | { readonly kind: "row"; readonly id: string; readonly section: Section; readonly row: Row };

export function settingsSectionResultId(section: string) {
  return `section:${section}`;
}

function rankTitle(title: string, query: string, tokens: readonly string[], phrase: boolean) {
  if (title === query) return 5;
  if (title.startsWith(query)) return 4;
  if (title.includes(query)) return 3;
  if (tokens.every((token) => title.includes(token))) return 2;
  return phrase ? 1 : 0;
}

export function searchSettingsGrouped<Section extends string, Row extends SearchableSettingsRow>(
  query: string,
  sections: ReadonlyArray<SearchableSettingsSection<Section>>,
  rows: ReadonlyArray<Row>,
  sectionOf: (row: Row) => Section,
): GroupedSettingsSearchResult<Section, Row>[] {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const tokens = normalizedQuery.split(" ");
  const matches = (fields: readonly string[]) =>
    tokens.every((token) => fields.some((field) => field.includes(token)));

  const sectionOrder = new Map(sections.map((entry, index) => [entry.section, index]));
  const groups = new Map<
    Section,
    {
      label: string;
      sectionRank: number | null;
      rows: { row: Row; rank: number; index: number }[];
    }
  >();
  for (const entry of sections) {
    const label = normalizeSearchText(entry.label);
    const fields = [label, ...(entry.searchTerms ?? []).map(normalizeSearchText)];
    groups.set(entry.section, {
      label: entry.label,
      sectionRank: matches(fields)
        ? rankTitle(
            label,
            normalizedQuery,
            tokens,
            fields.some((f) => f.includes(normalizedQuery)),
          )
        : null,
      rows: [],
    });
  }
  rows.forEach((row, index) => {
    const group = groups.get(sectionOf(row));
    if (!group) return;
    const title = normalizeSearchText(row.title);
    const fields = [
      title,
      normalizeSearchText(group.label),
      ...(row.searchTerms ?? []).map(normalizeSearchText),
    ];
    if (!matches(fields)) return;
    const phrase = fields.some((field) => field.includes(normalizedQuery));
    group.rows.push({ row, index, rank: rankTitle(title, normalizedQuery, tokens, phrase) });
  });

  const byRow = (
    left: { row: Row; rank: number; index: number },
    right: { row: Row; rank: number; index: number },
  ) =>
    Number(left.row.secondary ?? false) - Number(right.row.secondary ?? false) ||
    right.rank - left.rank ||
    left.index - right.index;
  const ordered = [...groups.entries()]
    .filter(([, group]) => group.sectionRank !== null || group.rows.length > 0)
    .map(([section, group]) => ({ section, ...group, rows: group.rows.toSorted(byRow) }))
    .toSorted((left, right) => {
      // Sections the query names lead, best name match first.
      if (left.sectionRank !== null || right.sectionRank !== null)
        return (
          (right.sectionRank ?? -1) - (left.sectionRank ?? -1) ||
          sectionOrder.get(left.section)! - sectionOrder.get(right.section)!
        );
      const a = left.rows[0]!;
      const b = right.rows[0]!;
      return byRow(a, b);
    });

  return ordered.flatMap((group) => [
    {
      kind: "section" as const,
      id: settingsSectionResultId(group.section),
      section: group.section,
      label: group.label,
      matched: group.sectionRank !== null,
    },
    ...group.rows.map(({ row }) => ({
      kind: "row" as const,
      id: row.id,
      section: group.section,
      row,
    })),
  ]);
}
