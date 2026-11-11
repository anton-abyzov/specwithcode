import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { cleanPastedPath, completeTypedPath, type PathMachine } from "./pathField.logic";

const NO_NAMES: readonly string[] = [];
const STARTS_A_PATH = /^(~|\/|\\\\|[A-Za-z]:[\\/]|\.{1,2}[\\/])/;

/**
 * Address-bar behaviour for a text field that holds a folder path: the name
 * being typed is completed from `names` as a selection, and a paste is cleaned
 * up first. The field stays controlled by its owner; `typed` is the text
 * without the completion, which is what a list beside the field should filter by.
 */
export function usePathCompletion(input: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Folder names in the directory being typed in. */
  readonly names: readonly string[];
  readonly machine: PathMachine;
}) {
  type From = {
    readonly element?: HTMLInputElement | null;
    readonly composing?: boolean;
    /** Names known only at the time of the change; replaces `names`. */
    readonly names?: readonly string[];
  };
  const element = useRef<HTMLInputElement | null>(null);
  const [completion, setCompletion] = useState<{ typed: string; value: string } | null>(null);
  const live = completion !== null && completion.value === input.value ? completion : null;
  const typed = live?.typed ?? input.value;

  // Select the added part once the completed text is in the field.
  useLayoutEffect(() => {
    const field = element.current;
    if (completion === null || field === null || field.value !== completion.value) return;
    field.setSelectionRange(completion.typed.length, completion.value.length);
  }, [completion]);

  const change = (next: string, from?: From) => {
    if (from?.element) element.current = from.element;
    const field = element.current;
    const caretAtEnd =
      field === null || field.selectionStart === null || field.selectionStart >= next.length;
    const completed =
      from?.composing === true || !caretAtEnd
        ? null
        : completeTypedPath({
            typed: next,
            previous: typed,
            names: from?.names ?? input.names,
            machine: input.machine,
          });
    setCompletion(completed === null ? null : { typed: next, value: completed.value });
    input.onChange(completed?.value ?? next);
  };

  const paste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (text.length === 0) return;
    event.preventDefault();
    const field = event.currentTarget;
    element.current = field;
    const cleaned = cleanPastedPath(text, input.machine);
    const start = field.selectionStart ?? input.value.length;
    const end = field.selectionEnd ?? start;
    // A whole path replaces what was there; a fragment goes in at the caret.
    const next = STARTS_A_PATH.test(cleaned)
      ? cleaned
      : input.value.slice(0, start) + cleaned + input.value.slice(end);
    setCompletion(null);
    input.onChange(next);
  };

  return {
    typed,
    /** True while the end of the field is a completion the person did not type. */
    completed: live !== null,
    change,
    paste,
    /** Remember the field, so a completion can be selected in it. */
    bind: (field: HTMLInputElement | null) => {
      if (field) element.current = field;
    },
  };
}

/** A folder path as text: completion, paste clean-up, Enter to confirm, Escape to leave. */
export function PathField({
  value,
  onChange,
  names,
  machine,
  onSubmit,
  onCancel,
  className,
  ...props
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Folder names to complete from, or how to find them for the text just typed. */
  readonly names: readonly string[] | ((typed: string) => readonly string[]);
  readonly machine: PathMachine;
  readonly onSubmit: (path: string) => void;
  readonly onCancel?: () => void;
} & Omit<React.ComponentProps<"input">, "value" | "onChange" | "onPaste" | "onSubmit">) {
  const completion = usePathCompletion({
    value,
    onChange,
    names: typeof names === "function" ? NO_NAMES : names,
    machine,
  });
  return (
    <input
      type="text"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      {...props}
      data-slot="path-field"
      className={cn(
        "min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      value={value}
      onChange={(event) =>
        completion.change(event.target.value, {
          element: event.target,
          composing: (event.nativeEvent as InputEvent).isComposing,
          ...(typeof names === "function" ? { names: names(event.target.value) } : {}),
        })
      }
      onPaste={completion.paste}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        } else if (event.key === "Escape" && onCancel) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}
