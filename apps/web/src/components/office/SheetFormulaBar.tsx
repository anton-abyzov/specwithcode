import { type ReactNode, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { handleSheetEditorKey, useStoreField } from "./SheetCellEditor";
import type { SheetEditStore } from "./sheetEditStore";
import type { SheetEditorKeyAction, SheetPlatform } from "./sheetKeyboard";

/**
 * The name box and the formula bar. The name box takes a cell or range to go
 * to; the bar edits the selected cell, in step with the editor in the cell.
 */
export function SheetFormulaBar(props: {
  readonly address: string;
  /** The selected cell's input when nothing is being edited. */
  readonly value: string;
  readonly editable: boolean;
  /** True while this bar has the caret. */
  readonly editing: boolean;
  /** True while the cell itself is being edited, so the bar shows the typed text. */
  readonly mirroring: boolean;
  readonly store: SheetEditStore;
  readonly platform: SheetPlatform;
  readonly onStartEdit: () => void;
  readonly onAction: (action: SheetEditorKeyAction) => void;
  readonly onGoTo: (text: string) => boolean;
}): ReactNode {
  const tx = useTx();
  const ref = useRef<HTMLInputElement>(null);
  const live = props.editing || props.mirroring;
  const { state, sync } = useStoreField(ref, props.store, live);
  const [goTo, setGoTo] = useState<string | null>(null);
  return (
    <>
      <input
        className="office-sheet-address"
        aria-label={tx("Name box")}
        value={goTo ?? props.address}
        spellCheck={false}
        data-sheet-address
        onFocus={(event) => {
          setGoTo(props.address);
          event.currentTarget.select();
        }}
        onChange={(event) => setGoTo(event.target.value)}
        onBlur={() => setGoTo(null)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            setGoTo(null);
            event.currentTarget.blur();
          }
          if (event.key === "Enter" && goTo !== null && props.onGoTo(goTo)) {
            setGoTo(null);
          }
        }}
      />
      <input
        ref={ref}
        className="office-sheet-formula"
        aria-label={tx("Formula bar")}
        spellCheck={false}
        readOnly={!props.editable}
        value={live ? state.text : props.value}
        data-sheet-formula
        onChange={(event) => sync(event, true)}
        onSelect={(event) => {
          if (props.editing) sync(event, false);
        }}
        onFocus={() => {
          if (props.editable && !props.editing) props.onStartEdit();
        }}
        onKeyDown={(event) => {
          if (!props.editing) return;
          handleSheetEditorKey(event, props.store, props.platform, false, props.onAction);
        }}
      />
    </>
  );
}
