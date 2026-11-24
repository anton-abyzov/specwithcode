import type { SheetTab } from "@specweave-studio/shared/officeSheet";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useTx } from "../../i18n";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/menu";

/** The tab strip: switch, add, rename (double-click) and delete (right-click). */
export function SheetTabs(props: {
  readonly tabs: ReadonlyArray<SheetTab>;
  readonly active: number;
  readonly editable: boolean;
  readonly onSelect: (index: number) => void;
  readonly onAdd: () => void;
  /** Returns a problem to show, or null when the name was taken. */
  readonly onRename: (index: number, name: string) => string | null;
  readonly onDelete: (index: number) => void;
}): ReactNode {
  const tx = useTx();
  const [renaming, setRenaming] = useState<{ readonly index: number; readonly name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ readonly index: number; readonly x: number; readonly y: number } | null>(null);
  const finish = (save: boolean) => {
    if (!renaming) return;
    if (save) {
      const result = props.onRename(renaming.index, renaming.name);
      if (result !== null) {
        setProblem(result);
        return;
      }
    }
    setProblem(null);
    setRenaming(null);
  };
  return (
    <div className="office-sheet-tabs" role="tablist" aria-label={tx("Sheet tabs")}>
      {props.tabs.map((entry, index) =>
        renaming?.index === index ? (
          <input
            key={`rename-${entry.name}`}
            className="office-tab-rename"
            aria-label={tx("Tab name")}
            aria-invalid={problem !== null}
            title={problem ?? undefined}
            value={renaming.name}
            autoFocus
            data-sheet-tab-rename
            onChange={(event) => setRenaming({ index, name: event.target.value })}
            onBlur={() => finish(true)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") finish(true);
              if (event.key === "Escape") finish(false);
            }}
          />
        ) : (
          <button
            key={entry.name}
            type="button"
            role="tab"
            aria-selected={index === props.active}
            data-active={index === props.active}
            data-sheet-tab={entry.name}
            onClick={() => props.onSelect(index)}
            onDoubleClick={() => {
              if (props.editable) setRenaming({ index, name: entry.name });
            }}
            onContextMenu={(event) => {
              if (!props.editable) return;
              event.preventDefault();
              props.onSelect(index);
              setMenu({ index, x: event.clientX, y: event.clientY });
            }}
          >
            {entry.name}
          </button>
        ),
      )}
      {props.editable ? (
        <button
          type="button"
          className="office-tab-add"
          aria-label={tx("Add tab")}
          title={tx("Add tab")}
          data-sheet-tab-add
          onClick={props.onAdd}
        >
          <PlusIcon aria-hidden />
        </button>
      ) : null}
      {problem ? (
        <span className="office-tab-problem" role="alert">
          {problem}
        </span>
      ) : null}
      <Menu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <MenuPopup
          align="start"
          side="top"
          width="sm"
          anchor={
            menu
              ? { getBoundingClientRect: () => DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }) }
              : undefined
          }
        >
          <MenuItem
            data-sheet-tab-menu="rename"
            onClick={() => {
              if (menu) setRenaming({ index: menu.index, name: props.tabs[menu.index]?.name ?? "" });
            }}
          >
            {tx("Rename")}
          </MenuItem>
          <MenuItem data-sheet-tab-menu="add" onClick={props.onAdd}>
            {tx("Add tab")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            disabled={props.tabs.length <= 1}
            data-sheet-tab-menu="delete"
            onClick={() => {
              if (menu) props.onDelete(menu.index);
            }}
          >
            {tx("Delete tab")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
