import type { UserInputAttachmentAnswerPayload } from "@specweave-studio/contracts";
import { getQuestionAnswerText } from "@specweave-studio/client-runtime/work-log/user-input";

interface QuestionOptionLike {
  readonly label: string;
  readonly description?: string | undefined;
  readonly value?: string | undefined;
  readonly recommended?: boolean | undefined;
}

interface QuestionLike {
  readonly id: string;
  readonly question: string;
  readonly options: ReadonlyArray<QuestionOptionLike>;
}

/** A, B, C … Z, then the 1-based number for anything past the alphabet. */
/**
 * A question's first paragraph is what is asked; any paragraphs after it are
 * supporting detail (consequences, the reason given), shown quieter below it.
 */
export function splitQuestionText(text: string): { headline: string; details: string | null } {
  const [headline = "", ...rest] = text.trim().split(/\n\s*\n/);
  const details = rest.join("\n\n").trim();
  return { headline: headline.trim(), details: details.length > 0 ? details : null };
}

export function questionOptionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** The option index a pressed letter selects, or -1. */
export function questionOptionIndexForKey(key: string, optionCount: number): number {
  if (key.length !== 1) return -1;
  const upper = key.toUpperCase();
  const letterIndex = upper.charCodeAt(0) - 65;
  if (letterIndex >= 0 && letterIndex < 26 && letterIndex < optionCount) return letterIndex;
  const digit = Number.parseInt(key, 10);
  if (Number.isInteger(digit) && digit >= 1 && digit <= 9 && digit <= optionCount) return digit - 1;
  return -1;
}

const RECOMMENDED_SUFFIX = /\s*[([]\s*recommended\s*[)\]]\s*$/i;

/**
 * Providers mark a recommended choice either with a flag or, as Claude's
 * AskUserQuestion convention does, with a "(Recommended)" label suffix.
 */
export function presentQuestionOption(option: QuestionOptionLike): {
  readonly label: string;
  readonly description: string | null;
  readonly recommended: boolean;
} {
  const suffixed = RECOMMENDED_SUFFIX.test(option.label);
  const label = suffixed
    ? option.label.replace(RECOMMENDED_SUFFIX, "") || option.label
    : option.label;
  const description = option.description?.trim() ?? "";
  return {
    label,
    description:
      description.length > 0 && description !== option.label && description !== label
        ? description
        : null,
    recommended: option.recommended === true || suffixed,
  };
}

const BARE_PATH = /(^|[\s(])((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]*)+)(?=$|[\s)])/g;

/**
 * Wraps bare absolute or home-relative file paths in inline code so the
 * markdown renderer turns them into links that open in the app. Text inside
 * existing code spans and markdown links is left alone.
 */
export function linkifyQuestionPaths(text: string): string {
  return text
    .split(/(`[^`]*`|\[[^\]]*\]\([^)]*\))/)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(BARE_PATH, (_match, lead: string, path: string) => {
            // Sentence punctuation after a path is not part of it.
            const trimmed = path.replace(/[.,;:!?]+$/, "");
            return `${lead}\`${trimmed}\`${path.slice(trimmed.length)}`;
          }),
    )
    .join("");
}

export interface DecisionChoice {
  /** The option's letter, or null for a typed answer. */
  readonly letter: string | null;
  readonly label: string;
}

export interface DecisionQuestion {
  readonly id: string;
  readonly question: string;
  readonly choices: ReadonlyArray<DecisionChoice>;
}

/** What the user chose for each question, matched back to the options' letters. */
export function deriveDecision(
  questions: ReadonlyArray<QuestionLike>,
  answer: UserInputAttachmentAnswerPayload,
): DecisionQuestion[] {
  const known = new Map(questions.map((question) => [question.id, question]));
  const ids = [
    ...questions.map((question) => question.id),
    ...Object.keys(answer.answers).filter((id) => !known.has(id)),
  ];
  return ids.flatMap((id) => {
    const question = known.get(id);
    const raw = answer.answers[id];
    const values = Array.isArray(raw) ? raw : [raw];
    const choices = values.flatMap((value): DecisionChoice[] => {
      const text = getQuestionAnswerText(value).trim();
      if (text.length === 0) return [];
      const index =
        question?.options.findIndex((option) => (option.value ?? option.label) === text) ?? -1;
      const option = index === -1 ? undefined : question?.options[index];
      return [
        option
          ? { letter: questionOptionLetter(index), label: presentQuestionOption(option).label }
          : { letter: null, label: text },
      ];
    });
    const text = question?.question ?? answer.questionTextById?.[id] ?? "";
    return choices.length === 0 && text.length === 0 ? [] : [{ id, question: text, choices }];
  });
}
