import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/menu";

export interface SheetContextTarget {
  readonly kind: "row" | "col" | "cell";
  readonly x: number;
  readonly y: number;
  /** Rows and columns the commands act on, first and count. */
  readonly rows: { readonly first: number; readonly count: number };
  readonly cols: { readonly first: number; readonly count: number };
}

export type SheetStructureCommand =
  | "rowAbove"
  | "rowBelow"
  | "deleteRows"
  | "colLeft"
  | "colRight"
  | "deleteCols"
  | "clear"
  | "copy"
  | "cut"
  | "paste";

/** Right-click on a row header, a column header or a cell. */
export function SheetContextMenu(props: {
  readonly target: SheetContextTarget | null;
  readonly onClose: () => void;
  readonly onCommand: (command: SheetStructureCommand, target: SheetContextTarget) => void;
}): ReactNode {
  const tx = useTx();
  const target = props.target;
  const rows = target?.rows.count ?? 1;
  const cols = target?.cols.count ?? 1;
  const item = (command: SheetStructureCommand, label: string, destructive = false) => (
    <MenuItem
      key={command}
      variant={destructive ? "destructive" : "default"}
      data-sheet-menu={command}
      onClick={() => target && props.onCommand(command, target)}
    >
      {label}
    </MenuItem>
  );
  const rowItems = [
    item("rowAbove", rows > 1 ? tx("Insert {count} rows above", { count: rows }) : tx("Insert row above")),
    item("rowBelow", rows > 1 ? tx("Insert {count} rows below", { count: rows }) : tx("Insert row below")),
    item("deleteRows", rows > 1 ? tx("Delete {count} rows", { count: rows }) : tx("Delete row"), true),
  ];
  const colItems = [
    item("colLeft", cols > 1 ? tx("Insert {count} columns left", { count: cols }) : tx("Insert column left")),
    item("colRight", cols > 1 ? tx("Insert {count} columns right", { count: cols }) : tx("Insert column right")),
    item("deleteCols", cols > 1 ? tx("Delete {count} columns", { count: cols }) : tx("Delete column"), true),
  ];
  return (
    <Menu open={target !== null} onOpenChange={(open) => !open && props.onClose()}>
      <MenuPopup
        align="start"
        width="sm"
        anchor={
          target
            ? { getBoundingClientRect: () => DOMRect.fromRect({ x: target.x, y: target.y, width: 0, height: 0 }) }
            : undefined
        }
      >
        {target?.kind === "row" ? rowItems : null}
        {target?.kind === "col" ? colItems : null}
        {target?.kind === "cell" ? (
          <>
            {item("cut", tx("Cut"))}
            {item("copy", tx("Copy"))}
            {item("paste", tx("Paste"))}
            <MenuSeparator />
            {rowItems}
            <MenuSeparator />
            {colItems}
            <MenuSeparator />
            {item("clear", tx("Clear contents"))}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
