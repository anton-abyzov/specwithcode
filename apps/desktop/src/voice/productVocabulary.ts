import type { VocabularyTerm } from "./vocabulary.ts";

/**
 * Words this product itself uses, known on every install so a new user's first
 * phrase already spells them right. They lead the recognizer's hint list and
 * run in the correction pass; the person's own list can override any of them.
 *
 * A plain term fixes casing and split forms ("spec weave"). A `hintOnly` term is
 * also an ordinary word (cursor, fable), so it is offered to the recognizer but
 * never rewritten. A `heard => written` pair fixes a known mishearing, and only
 * one that is not ordinary English itself: "cloud code" is real, so it is not here.
 */
export const PRODUCT_VOCABULARY: readonly VocabularyTerm[] = [
  { phrase: "SpecWithCode" },
  { phrase: "SpecWeave" },
  { phrase: "work tree", replacement: "worktree" },
  { phrase: "work trees", replacement: "worktrees" },
  { phrase: "increment", hintOnly: true },
  { phrase: "coordinator", hintOnly: true },
  { phrase: "v skill", replacement: "vskill" },
  { phrase: "Claude Code" },
  { phrase: "Claude" },
  { phrase: "Codex" },
  { phrase: "Devin" },
  { phrase: "Fable", hintOnly: true },
  { phrase: "Opus", hintOnly: true },
  { phrase: "Sonnet", hintOnly: true },
  { phrase: "ultra code", replacement: "Ultracode" },
  { phrase: "MCP" },
  { phrase: "GitHub" },
  { phrase: "pull request", hintOnly: true },
  { phrase: "handoff", hintOnly: true },
  { phrase: "spec wave", replacement: "SpecWeave" },
];
