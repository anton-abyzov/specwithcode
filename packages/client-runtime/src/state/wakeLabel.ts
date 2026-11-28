/** A wake notice's text split so a long quoted title can truncate while its outcome stays visible. */
export interface WakeLabelParts {
  /** Everything up to and including the quoted title, such as `Delegated task "X"`. */
  readonly head: string;
  /** The outcome words after the title, such as ` finished`; empty when there are none. */
  readonly tail: string;
}

/**
 * The longest outcome text the server writes after a quoted title, such as
 * ` was stopped (exit 130)` or ` reported new output` (Notification.ts).
 */
const MAX_OUTCOME_TAIL = 28;

/**
 * Splits `Delegated task "X" finished` into `Delegated task "X"` and ` finished`,
 * at the last closing quote. A label without a quoted title, with nothing after
 * it, or whose text after the last quote is not a short outcome (a list of task
 * names, for example) stays whole in `head`, so it truncates as one piece.
 */
export function splitWakeLabel(label: string): WakeLabelParts {
  const close = label.lastIndexOf('"');
  if (close <= 0 || label.indexOf('"') === close) return { head: label, tail: "" };
  const tail = label.slice(close + 1);
  if (tail.trim() === "" || tail.length > MAX_OUTCOME_TAIL || tail.includes(",")) {
    return { head: label, tail: "" };
  }
  return { head: label.slice(0, close + 1), tail };
}
