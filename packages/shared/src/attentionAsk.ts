/**
 * What a Needs you row asks of the person, in plain words: the first sentence
 * of a report's Blockers part, or an open question card's header and options.
 * Both come from an agent's own words, so they are trimmed, never rewritten.
 */

/** Longest ask a row shows; the full text stays in the hover or the card. */
export const ATTENTION_ASK_MAX_LENGTH = 160;

const plain = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__|`)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const capitalize = (text: string): string =>
  text.length === 0 ? text : text[0]!.toLocaleUpperCase() + text.slice(1);

/** Cut at a word boundary and mark the cut, so a row never ends mid-word. */
export function capAsk(text: string, max = ATTENTION_ASK_MAX_LENGTH): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/u, "")}…`;
}

const SENTENCE = /^.*?[.?!](?=\s|$)/u;
const firstSentence = (text: string): string => SENTENCE.exec(text)?.[0] ?? text;

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/u;

/**
 * The ask in a Blockers part: its first line that is not a list item (or its
 * first item, when it is only a list), without markdown or a short lead-in
 * such as "Still yours from the last report:", cut to its first sentence.
 * Null when nothing readable is left.
 */
export function blockerAsk(blocker: string, max = ATTENTION_ASK_MAX_LENGTH): string | null {
  const lines = blocker
    .split(/\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const line = lines.find((entry) => !LIST_ITEM.test(entry)) ?? lines[0]?.replace(LIST_ITEM, "");
  let text = plain(line ?? "");
  const leadIn = /^[^?:]{1,60}:\s+(?=\S)/u.exec(text);
  if (leadIn) text = text.slice(leadIn[0].length);
  text = capitalize(firstSentence(text).trim());
  return text.length === 0 ? null : capAsk(text, max);
}

export interface AttentionQuestion {
  readonly header?: string | undefined;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string }>;
}

/** ask_user's header when the agent gave none: it names nothing. */
const DEFAULT_HEADER = "Question";

const questionName = (question: AttentionQuestion): string => {
  const header = plain(question.header ?? "");
  if (header.length > 0 && header !== DEFAULT_HEADER) return header;
  const text = plain(question.question);
  // The sentence that asks, when the question opens with context.
  const asks = text
    .match(/[^.?!]*\?/gu)
    ?.at(-1)
    ?.trim();
  return asks && asks.length > 0 ? asks : firstSentence(text);
};

const joinOr = (labels: readonly string[]): string =>
  labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;

/**
 * An open question card in a row's words: "MCP sign-in: Ship without it or I
 * will sign in once" for one question, "2 questions: CLI message, Card
 * plumbing" for several. Null when the card has no question.
 */
export function pendingQuestionPrompt(
  questions: ReadonlyArray<AttentionQuestion>,
  max = ATTENTION_ASK_MAX_LENGTH,
): string | null {
  const [only, ...rest] = questions;
  if (only === undefined) return null;
  if (rest.length > 0)
    return capAsk(`${questions.length} questions: ${questions.map(questionName).join(", ")}`, max);
  const name = questionName(only);
  const labels = only.options.map((option) => plain(option.label)).filter(Boolean);
  const text =
    labels.length === 0
      ? name
      : name.endsWith("?")
        ? `${name} ${joinOr(labels)}`
        : `${name.replace(/:$/u, "")}: ${joinOr(labels)}`;
  return text.length === 0 ? null : capAsk(text, max);
}
