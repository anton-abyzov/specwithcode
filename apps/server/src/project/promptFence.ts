/**
 * Text written by agents or carried in a repository that goes into a
 * thread's project context. Project context is put in front of the user's
 * message, and every adapter scans that whole message for skill mentions
 * (any currency sigil after whitespace, SKILL_MENTION_PATTERN), so such text
 * must not dispatch a skill, close or open an app fence, or start a line
 * that reads as a section header.
 */
import { SKILL_MENTION_PATTERN } from "@specweave-studio/shared/composerInlineTokens";

/** Invisible, not whitespace and not a name character, so a sigil before it starts no mention. */
const WORD_JOINER = "\u2060";
/**
 * `$name` as Codex reads a mention: a `$` anywhere, whatever comes before it,
 * then name characters (letters, digits, `_`, `:` and `-`). A plain amount
 * such as `$5` or `$1.50` names no skill and is left alone.
 */
const CODEX_MENTION = /\$(?=[0-9]*[A-Za-z_:-])/g;
/** Codex's linked mentions, `[$name](…/SKILL.md)` and `[@name](plugin://…)`, select by link target. */
const LINKED_MENTION = /\[(?=[$@])/g;
/** Lines that would read as the runtime's own markers around the user's message. */
const RUNTIME_MARKER = /^([ \t]*)(?=current user message:|project context \()/gim;

/**
 * Text that reads the same to a model but names no skill an adapter or Codex
 * would run: a word joiner goes between each sigil and the name after it, and
 * between `[` and the sigil of a linked mention.
 */
function neutralizeSkillMentions(text: string): string {
  return text
    .replace(
      SKILL_MENTION_PATTERN,
      (match: string, _delimiter: string, name: string) =>
        `${match.slice(0, match.length - name.length)}${WORD_JOINER}${name}`,
    )
    .replace(CODEX_MENTION, `$$${WORD_JOINER}`)
    .replace(LINKED_MENTION, `[${WORD_JOINER}`);
}

/**
 * Body text inside an app fence such as `<project_memory>`: app tags are
 * escaped, a line that is only `[name]` or that starts like the runtime's
 * `Current user message:` or `Project context (` markers is escaped so it
 * cannot pose as a section or as the user's own words, and skill mentions
 * are neutralized.
 */
export function fenceText(text: string): string {
  return neutralizeSkillMentions(
    text
      .replace(/<(\/?)(project_[a-z_]*)/gi, "&lt;$1$2")
      .replace(/^(\[[^\]\r\n]*\][ \t]*)$/gm, "\\$1")
      .replace(RUNTIME_MARKER, "$1\\"),
  );
}

/** One line of repository text, such as a title or a location, inside a fence tag or a list. */
export function fenceLine(value: string, max = 300): string {
  const line = value.replace(/["<>\r\n\t\u2028\u2029]/g, " ");
  const end = line.length > max && /[\uD800-\uDBFF]/.test(line[max - 1] ?? "") ? max - 1 : max;
  return neutralizeSkillMentions(line.slice(0, end));
}
