import { sha256 } from "../nodeCrypto.ts";
import {
  PROJECT_CONTEXT_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
} from "@specweave-studio/contracts";
import { isKnowledgeDocumentSection } from "./knowledge/knowledgeSections.ts";
import { projectContextLineDiff } from "./ProjectContextLineDiff.ts";

export type ProjectContextSection = {
  readonly name: string;
  readonly value: string;
  readonly revision: string;
};
export type ProjectContextSnapshot = ReadonlyArray<ProjectContextSection>;
export const contextDigest = (value: string) => sha256([value], "hex");

/** UTF-16 bounds never split a Unicode surrogate pair. */
export function boundProjectContext(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, Math.max(0, limit));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** MEMORY.md keeps at least this much of the context budget, even with long goal and instructions. */
export const MEMORY_INDEX_FLOOR = 2_048;

/**
 * Sections keep their priority order, but a later section may reserve a floor
 * (up to its own length) so long earlier sections cannot starve it completely.
 */
export function projectContextSnapshot(
  /**
   * Name, content and, optionally, extra revision input: state the text does
   * not show (such as files beyond a bounded list) that must still mark the
   * section changed.
   */
  sections: ReadonlyArray<readonly [string, string] | readonly [string, string, string]>,
  floors: Readonly<Record<string, number>> = { memory_index: MEMORY_INDEX_FLOOR },
): ProjectContextSnapshot {
  let remaining = PROJECT_CONTEXT_CHARACTER_LIMIT - 1500;
  return sections.map(([name, content, revisionInput], index) => {
    const suffix =
      "\n[Project context truncated. Read project memory details with studio_project_memory_read.]";
    const reserved = sections
      .slice(index + 1)
      .reduce((sum, [later, text]) => sum + Math.min(text.length, floors[later] ?? 0), 0);
    const budget = Math.max(0, remaining - reserved);
    const value =
      content.length <= budget
        ? content
        : boundProjectContext(content, Math.max(0, budget - suffix.length)) + suffix;
    remaining = Math.max(0, remaining - value.length);
    return {
      name,
      value,
      revision:
        revisionInput === undefined
          ? contextDigest(value)
          : contextDigest(`${value}\u0000${revisionInput}`),
    };
  });
}

/** Long sections whose edits usually touch a few lines; a delta sends those lines. */
const LINE_DIFF_SECTIONS = new Set(["memory_index", "memory_inventory"]);
/** A diff is used only when it is at most this share of the section's full text. */
const LINE_DIFF_MAX_SHARE = 0.6;

/** A changed section's text in a delta: a line diff when one is much shorter. */
function changedSectionText(
  section: ProjectContextSection,
  previous: ProjectContextSection | undefined,
): string {
  if (!section.value) return previous?.value ? "(empty; previous content removed)" : "(empty)";
  if (previous?.value && LINE_DIFF_SECTIONS.has(section.name)) {
    const diff = projectContextLineDiff(previous.value, section.value);
    if (diff === "")
      return section.name === "memory_inventory"
        ? "(list unchanged; a memory file beyond this list changed: studio_project_memory_list shows every revision)"
        : section.value;
    if (diff.length <= section.value.length * LINE_DIFF_MAX_SHARE)
      return `(line changes to the previous [${section.name}]; every other line is unchanged)\n${diff}`;
  }
  return section.value;
}

/**
 * A delta carries the shared sections (bounded by PROJECT_CONTEXT_CHARACTER_LIMIT)
 * plus inline project knowledge, which has its own allowance, and their headers.
 */
const PROJECT_CONTEXT_DELTA_CHARACTER_LIMIT =
  PROJECT_CONTEXT_CHARACTER_LIMIT + PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT + 4_000;
/** Above this many, removed knowledge documents are announced in one line. */
const REMOVED_KNOWLEDGE_LISTED = 8;

/** Changed and removed sections explicitly supersede previously delivered values. */
export function projectContextDelta(
  projectId: string,
  next: ProjectContextSnapshot,
  previous: ProjectContextSnapshot | null,
): string {
  const before = new Map(previous?.map((s) => [s.name, s]) ?? []);
  const changes = next.filter((s) => before.get(s.name)?.revision !== s.revision);
  const removed = (previous ?? []).filter((s) => !next.some((n) => n.name === s.name));
  if (changes.length === 0 && removed.length === 0) return "";
  // Many removed documents, as when switching to search mode, take one line
  // instead of one each; any that remain are sent again so the line can say
  // the earlier ones are all replaced. Inline documents fit their allowance.
  const removedKnowledge = removed.filter((s) => isKnowledgeDocumentSection(s.name));
  const collapse = removedKnowledge.length > REMOVED_KNOWLEDGE_LISTED;
  const remaining = next.filter((s) => isKnowledgeDocumentSection(s.name));
  const sent = collapse
    ? next.filter(
        (s) => isKnowledgeDocumentSection(s.name) || before.get(s.name)?.revision !== s.revision,
      )
    : changes;
  const removedLines = (
    collapse ? removed.filter((s) => !isKnowledgeDocumentSection(s.name)) : removed
  ).map((s) => `[${s.name}]\n(empty; previous content removed)`);
  const heading = `Project context (${projectId}) — ${previous === null ? "current snapshot" : "changed sections"}. These sections replace earlier values with the same name. Current user and higher-priority instructions remain authoritative.`;
  return boundProjectContext(
    [
      heading,
      // An empty section says content was removed only when it had some before;
      // a never-set goal in a first snapshot is just empty.
      ...sent.map((s) => `[${s.name}]\n${changedSectionText(s, before.get(s.name))}`),
      ...removedLines,
      ...(collapse
        ? [
            remaining.length === 0
              ? `[knowledge:*]\n(empty; all ${removedKnowledge.length} earlier knowledge document sections are removed)`
              : `[knowledge:*]\n(every earlier knowledge document section is replaced by the ${remaining.length} in this message)`,
          ]
        : []),
    ].join("\n\n"),
    PROJECT_CONTEXT_DELTA_CHARACTER_LIMIT,
  );
}
