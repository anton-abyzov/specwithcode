import { useState, type ChangeEvent } from "react";

/**
 * Text for an input bound to a live document value. It follows the value
 * (an agent edit, an undo) until the user focuses the field, then keeps what
 * they type until `end()`, so a live update never wipes a half-typed entry.
 */
export function useFieldDraft(value: string) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    inputProps: {
      value: draft ?? value,
      onFocus: () => setDraft((current) => current ?? value),
      onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.currentTarget.value),
    },
    /** Replaces the text while editing (arrow-key steps). */
    set: (text: string) => setDraft(text),
    /** Editing finished: follow the document value again. */
    end: () => setDraft(null),
  };
}
