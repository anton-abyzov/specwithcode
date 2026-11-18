import { pendingQuestionPrompt } from "@specweave-studio/shared/attentionAsk";

/**
 * Cards with a node of their own: the app's ask_user cards and the cards a
 * service update reopens (`update-reopen:` and `update-reopen-approval:`).
 */
const OWN_NODE_CARD = /^(?:ask-user:|update-reopen)/u;

/**
 * The row words of a thread's open ask_user card, for the shell's pending
 * request summary. The card's questions live on its user_input_request turn
 * item; they count only when that item belongs to the pending request itself.
 * A malformed or foreign source gives no prompt, and the row says "Answer
 * needed" alone, as on older servers.
 */
export function pendingRequestPrompt(
  request: { readonly id: string; readonly kind: string } | null,
  source: unknown,
): { readonly prompt?: string } {
  // The same cards as the SQL shell read (see ProjectionStore).
  if (request === null || request.kind !== "user_input") return {};
  if (!OWN_NODE_CARD.test(request.id)) return {};
  if (typeof source !== "object" || source === null) return {};
  const { requestId, questions: asked } = source as Record<string, unknown>;
  if (requestId !== request.id || !Array.isArray(asked)) return {};
  const questions = asked.flatMap((question: unknown) => {
    if (typeof question !== "object" || question === null) return [];
    const { header, question: text, options } = question as Record<string, unknown>;
    if (typeof text !== "string") return [];
    return [
      {
        header: typeof header === "string" ? header : undefined,
        question: text,
        options: Array.isArray(options)
          ? options.flatMap((option: unknown) =>
              typeof option === "object" &&
              option !== null &&
              typeof (option as { label?: unknown }).label === "string"
                ? [{ label: (option as { label: string }).label }]
                : [],
            )
          : [],
      },
    ];
  });
  const prompt = pendingQuestionPrompt(questions);
  return prompt === null ? {} : { prompt };
}

/** The SQL shell row's `pending_question_json` column, parsed without failing the row. */
export function parsePendingQuestionSource(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
