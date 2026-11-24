import { SHEET_FUNCTIONS } from "@specweave-studio/shared/officeSheet";
import {
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useTx } from "../../i18n";
import { type SheetEditStore, useSheetEditState } from "./sheetEditStore";
import {
  type SheetEditorKeyAction,
  type SheetPlatform,
  cycleAbsolute,
  functionPrefixAt,
  sheetEditorKeyAction,
} from "./sheetKeyboard";

const SUGGESTIONS = 8;

/** Function names that start with what is typed at the caret. */
export function functionSuggestions(text: string, caret: number): {
  readonly start: number;
  readonly names: ReadonlyArray<string>;
} | null {
  const found = functionPrefixAt(text, caret);
  if (!found) return null;
  const names = SHEET_FUNCTIONS.filter((name) => name.startsWith(found.prefix) && name !== found.prefix).slice(
    0,
    SUGGESTIONS,
  );
  return names.length > 0 ? { start: found.start, names } : null;
}

/** Shared by the cell editor and the formula bar: keys that commit, cancel or cycle `$`. */
export function handleSheetEditorKey(
  event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  store: SheetEditStore,
  platform: SheetPlatform,
  typing: boolean,
  onAction: (action: SheetEditorKeyAction) => void,
): void {
  const action = sheetEditorKeyAction(event, platform, typing);
  // Keys inside the editor never reach the viewer or the app's own shortcuts.
  event.stopPropagation();
  if (!action) return;
  event.preventDefault();
  const target = event.currentTarget;
  const caret = target.selectionStart ?? target.value.length;
  if (action.type === "newline") {
    const text = `${target.value.slice(0, caret)}\n${target.value.slice(target.selectionEnd ?? caret)}`;
    store.set({ text, caret: caret + 1, pointed: null });
    return;
  }
  if (action.type === "absolute") {
    const next = cycleAbsolute(target.value, caret);
    store.set({ text: next.text, caret: next.caret, pointed: null });
    return;
  }
  onAction(action);
}

/** Keep a field's text and caret in step with the store. */
export function useStoreField(
  ref: { readonly current: HTMLTextAreaElement | HTMLInputElement | null },
  store: SheetEditStore,
  active: boolean,
) {
  const state = useSheetEditState(store);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field || !active) return;
    if (field.value !== state.text) field.value = state.text;
    if (field === field.ownerDocument.activeElement && field.selectionStart !== state.caret) {
      field.setSelectionRange(state.caret, state.caret);
    }
  }, [active, ref, state]);
  const sync = (event: SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>, typed: boolean) => {
    const field = event.currentTarget;
    const current = store.get();
    const caret = field.selectionStart ?? field.value.length;
    if (current.text === field.value && current.caret === caret) return;
    store.set({ text: field.value, caret, pointed: typed ? null : current.pointed });
  };
  return { state, sync };
}

/** The text field over the cell being edited, with function name suggestions for formulas. */
export function SheetCellEditor(props: {
  readonly store: SheetEditStore;
  readonly platform: SheetPlatform;
  readonly typing: boolean;
  /** False while the formula bar has the caret; the cell only shows the text. */
  readonly focused: boolean;
  readonly onAction: (action: SheetEditorKeyAction) => void;
}): ReactNode {
  const tx = useTx();
  const ref = useRef<HTMLTextAreaElement>(null);
  const { state, sync } = useStoreField(ref, props.store, true);
  const [chosen, setChosen] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestions = props.focused ? functionSuggestions(state.text, state.caret) : null;
  const key = suggestions ? `${suggestions.start}:${state.text.slice(suggestions.start, state.caret)}` : null;
  const open = suggestions !== null && key !== dismissed;
  useEffect(() => setChosen(0), [key]);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field || !props.focused) return;
    field.focus();
    const caret = props.store.get().caret;
    field.setSelectionRange(caret, caret);
  }, [props.focused, props.store]);
  const lines = state.text.split("\n");
  const accept = (name: string) => {
    if (!suggestions) return;
    const text = `${state.text.slice(0, suggestions.start)}${name}(${state.text.slice(state.caret)}`;
    const caret = suggestions.start + name.length + 1;
    props.store.set({ text, caret, pointed: null });
  };
  return (
    <span className="office-cell-editor" data-sheet-editor>
      <textarea
        ref={ref}
        className="office-cell-editor-field"
        aria-label={tx("Cell contents")}
        defaultValue={state.text}
        spellCheck={false}
        rows={Math.min(8, lines.length)}
        cols={Math.max(4, ...lines.map((line) => line.length + 1))}
        tabIndex={props.focused ? 0 : -1}
        readOnly={!props.focused}
        data-sheet-editor-field
        onChange={(event) => sync(event, true)}
        onSelect={(event) => sync(event, false)}
        onKeyDown={(event) => {
          if (open && suggestions) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setChosen((current) => (current + delta + suggestions.names.length) % suggestions.names.length);
              return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.altKey)) {
              event.preventDefault();
              event.stopPropagation();
              accept(suggestions.names[chosen] ?? suggestions.names[0]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(key);
              return;
            }
          }
          handleSheetEditorKey(event, props.store, props.platform, props.typing, props.onAction);
        }}
      />
      {open && suggestions ? (
        <ul className="office-formula-suggestions" role="listbox" aria-label={tx("Functions")} data-sheet-suggestions>
          {suggestions.names.map((name, index) => (
            <li
              key={name}
              role="option"
              aria-selected={index === chosen}
              data-active={index === chosen}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
