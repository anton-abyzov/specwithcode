import { type CellRange, type SheetChartType, SHEET_LIMITS, columnLetters, rangeName } from "@specweave-studio/shared/officeSheet";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import { Button } from "../ui/button";

const CHART_TYPES: ReadonlyArray<{ readonly type: SheetChartType; readonly label: string }> = [
  { type: "bar", label: "Bar" },
  { type: "column", label: "Column" },
  { type: "line", label: "Line" },
  { type: "donut", label: "Donut" },
];

/** The file changed on disk under an edit: reload it, or keep the edit over it. */
export function SheetConflictBanner(props: {
  readonly canKeep: boolean;
  readonly refreshing: boolean;
  readonly saving: boolean;
  readonly onReload: () => void;
  readonly onKeep: () => void;
}): ReactNode {
  const tx = useTx();
  return (
    <div className="office-sheet-conflict" role="alert" data-sheet-conflict>
      <span>{tx("This sheet changed on disk while you were editing.")}</span>
      <div className="office-sheet-conflict-actions">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-sheet-conflict-reload
          onClick={props.onReload}
        >
          {tx("Reload latest")}
        </Button>
        {props.canKeep ? (
          <Button
            type="button"
            size="sm"
            data-sheet-conflict-keep
            disabled={props.saving || props.refreshing}
            onClick={props.onKeep}
          >
            {props.refreshing ? tx("Refreshing latest...") : tx("Keep my edits")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Show, hide and reorder columns. */
export function SheetColumnsPanel(props: {
  readonly columns: number;
  readonly hidden: ReadonlyArray<string>;
  readonly onToggle: (col: number) => void;
  readonly onMove: (col: number, delta: -1 | 1) => void;
}): ReactNode {
  const tx = useTx();
  const hiddenSet = new Set(props.hidden.map((entry) => entry.toUpperCase()));
  return (
    <div className="office-sheet-columns-panel" data-sheet-columns-panel>
      {Array.from({ length: props.columns }, (_, col) => {
        const letter = columnLetters(col);
        const hidden = hiddenSet.has(letter);
        return (
          <span key={letter} className="office-column-pill" data-hidden={hidden}>
            <button
              type="button"
              data-col-toggle={letter}
              aria-pressed={!hidden}
              aria-label={tx("Show column {column}", { column: letter })}
              onClick={() => props.onToggle(col)}
            >
              {hidden ? `${letter} (${tx("hidden")})` : letter}
            </button>
            {!hidden ? (
              <>
                <button
                  type="button"
                  aria-label={tx("Move column {column} left", { column: letter })}
                  data-col-left={letter}
                  onClick={() => props.onMove(col, -1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label={tx("Move column {column} right", { column: letter })}
                  data-col-right={letter}
                  onClick={() => props.onMove(col, 1)}
                >
                  ›
                </button>
              </>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** Make a chart from the selected range. */
export function SheetInsertChartForm(props: {
  readonly range: CellRange;
  readonly chartType: SheetChartType;
  readonly title: string;
  readonly saving: boolean;
  readonly onType: (type: SheetChartType) => void;
  readonly onTitle: (title: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const tx = useTx();
  return (
    <form
      className="office-sheet-insert"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <span className="text-muted-foreground">{rangeName(props.range)}</span>
      <span className="office-segment" role="radiogroup" aria-label={tx("Chart type")}>
        {CHART_TYPES.map((entry) => (
          <button
            key={entry.type}
            type="button"
            role="radio"
            aria-checked={props.chartType === entry.type}
            data-active={props.chartType === entry.type}
            onClick={() => props.onType(entry.type)}
          >
            {tx(entry.label)}
          </button>
        ))}
      </span>
      <input
        className="office-sheet-input"
        value={props.title}
        maxLength={SHEET_LIMITS.titleChars}
        placeholder={tx("Chart title")}
        aria-label={tx("Chart title")}
        onChange={(event) => props.onTitle(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={props.saving} data-sheet-add-chart>
        {tx("Add chart")}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={props.onCancel}>
        {tx("Cancel")}
      </Button>
    </form>
  );
}
