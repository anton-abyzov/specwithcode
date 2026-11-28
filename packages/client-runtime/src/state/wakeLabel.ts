/** A wake notice's text split so a long quoted title can truncate while its outcome stays visible. */
export interface WakeLabelParts {
  /** Everything up to and including the quoted title, such as `Delegated task "X"`. */
  readonly head: string;
  /** The outcome words after the title, such as ` finished`; empty when there are none. */
  readonly tail: string;
}

/**
 * Splits `Delegated task "X" finished` into `Delegated task "X"` and ` finished`,
 * at the last closing quote. A label without a quoted title, or with nothing
 * after it, stays whole in `head`.
 */
export function splitWakeLabel(label: string): WakeLabelParts {
  const close = label.lastIndexOf('"');
  if (close <= 0 || label.indexOf('"') === close) return { head: label, tail: "" };
  const tail = label.slice(close + 1);
  if (tail.trim() === "") return { head: label, tail: "" };
  return { head: label.slice(0, close + 1), tail };
}
