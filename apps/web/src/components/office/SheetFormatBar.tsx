import type {
  SheetAlign,
  SheetBorderPreset,
  SheetCellStyle,
  SheetNumberFormat,
  SheetTone,
} from "@specweave-studio/shared/officeSheet";
import {
  BoldIcon,
  DecimalsArrowLeftIcon,
  DecimalsArrowRightIcon,
  Grid3x3Icon,
  ItalicIcon,
  KeyboardIcon,
  PaintBucketIcon,
  Redo2Icon,
  TextAlignCenterIcon,
  TextAlignEndIcon,
  TextAlignStartIcon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

export type SheetFillChoice = "none" | "band" | SheetTone;
export type SheetNumberChoice = "general" | "number" | "currency" | "percent" | "text";

const FILLS: ReadonlyArray<{ readonly id: SheetFillChoice; readonly label: string }> = [
  { id: "none", label: "No fill" },
  { id: "band", label: "Soft band" },
  { id: "accent", label: "Accent" },
  { id: "positive", label: "Green" },
  { id: "warning", label: "Amber" },
  { id: "negative", label: "Red" },
  { id: "muted", label: "Grey" },
];

const NUMBERS: ReadonlyArray<{ readonly id: SheetNumberChoice; readonly label: string }> = [
  { id: "general", label: "General" },
  { id: "number", label: "Number" },
  { id: "currency", label: "Currency" },
  { id: "percent", label: "Percent" },
  { id: "text", label: "Text" },
];

const BORDERS: ReadonlyArray<{ readonly id: SheetBorderPreset; readonly label: string }> = [
  { id: "all", label: "All borders" },
  { id: "outline", label: "Outside border" },
  { id: "top", label: "Top border" },
  { id: "bottom", label: "Bottom border" },
  { id: "left", label: "Left border" },
  { id: "right", label: "Right border" },
  { id: "none", label: "No borders" },
];

/** The number format a choice in the menu stands for. */
export function numberFormatFor(choice: SheetNumberChoice): SheetNumberFormat | null {
  switch (choice) {
    case "general":
      return null;
    case "number":
      return { kind: "number", decimals: 2 };
    case "currency":
      return { kind: "currency", currency: "USD", decimals: 2 };
    case "percent":
      return { kind: "percent", decimals: 0 };
    case "text":
      return { kind: "text" };
  }
}

export function numberChoiceOf(format: SheetNumberFormat | undefined): SheetNumberChoice {
  return format?.kind ?? "general";
}

/** Keeps the grid focused, so a click on the bar never takes the keyboard away from the cells. */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

function ToolButton(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly data: string;
}): ReactNode {
  return (
    <button
      type="button"
      className="office-tool"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onMouseDown={keepFocus}
      onClick={props.onClick}
      data-sheet-tool={props.data}
    >
      {props.children}
    </button>
  );
}

/** Bold, italic, underline, alignment, fill, number format, decimals and borders for the selection. */
export function SheetFormatBar(props: {
  readonly style: SheetCellStyle | undefined;
  readonly format: SheetNumberFormat | undefined;
  readonly disabled: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly shortcutHint: string;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onToggle: (style: "bold" | "italic" | "underline") => void;
  readonly onAlign: (align: SheetAlign | undefined) => void;
  readonly onFill: (fill: SheetFillChoice) => void;
  readonly onNumber: (choice: SheetNumberChoice) => void;
  readonly onDecimals: (delta: 1 | -1) => void;
  readonly onBorders: (preset: SheetBorderPreset) => void;
  readonly onShortcuts: () => void;
}): ReactNode {
  const tx = useTx();
  const { style, disabled } = props;
  const choice = numberChoiceOf(props.format);
  const align = (value: SheetAlign) => props.onAlign(style?.align === value ? undefined : value);
  return (
    <div className="office-format-bar" role="toolbar" aria-label={tx("Formatting")} data-sheet-format-bar>
      <ToolButton label={tx("Undo")} disabled={!props.canUndo} onClick={props.onUndo} data="undo">
        <Undo2Icon aria-hidden />
      </ToolButton>
      <ToolButton label={tx("Redo")} disabled={!props.canRedo} onClick={props.onRedo} data="redo">
        <Redo2Icon aria-hidden />
      </ToolButton>
      <span className="office-tool-gap" />
      <ToolButton label={tx("Bold")} pressed={style?.bold === true} disabled={disabled} onClick={() => props.onToggle("bold")} data="bold">
        <BoldIcon aria-hidden />
      </ToolButton>
      <ToolButton label={tx("Italic")} pressed={style?.italic === true} disabled={disabled} onClick={() => props.onToggle("italic")} data="italic">
        <ItalicIcon aria-hidden />
      </ToolButton>
      <ToolButton label={tx("Underline")} pressed={style?.underline === true} disabled={disabled} onClick={() => props.onToggle("underline")} data="underline">
        <UnderlineIcon aria-hidden />
      </ToolButton>
      <span className="office-tool-gap" />
      <ToolButton label={tx("Align left")} pressed={style?.align === "left"} disabled={disabled} onClick={() => align("left")} data="align-left">
        <TextAlignStartIcon aria-hidden />
      </ToolButton>
      <ToolButton label={tx("Align center")} pressed={style?.align === "center"} disabled={disabled} onClick={() => align("center")} data="align-center">
        <TextAlignCenterIcon aria-hidden />
      </ToolButton>
      <ToolButton label={tx("Align right")} pressed={style?.align === "right"} disabled={disabled} onClick={() => align("right")} data="align-right">
        <TextAlignEndIcon aria-hidden />
      </ToolButton>
      <span className="office-tool-gap" />
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={<button type="button" className="office-tool" onMouseDown={keepFocus} />}
          aria-label={tx("Fill colour")}
          title={tx("Fill colour")}
          data-sheet-tool="fill"
        >
          <PaintBucketIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start" width="sm">
          {FILLS.map((entry) => (
            <MenuItem key={entry.id} onClick={() => props.onFill(entry.id)} data-sheet-fill={entry.id}>
              <span className="office-fill-swatch" data-fill-swatch={entry.id} aria-hidden />
              {tx(entry.label)}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={<button type="button" className="office-tool" onMouseDown={keepFocus} />}
          aria-label={tx("Borders")}
          title={tx("Borders")}
          data-sheet-tool="borders"
        >
          <Grid3x3Icon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start" width="sm">
          {BORDERS.map((entry, index) => (
            <span key={entry.id} className="contents">
              {index === BORDERS.length - 1 ? <MenuSeparator /> : null}
              <MenuItem onClick={() => props.onBorders(entry.id)} data-sheet-border={entry.id}>
                {tx(entry.label)}
              </MenuItem>
            </span>
          ))}
        </MenuPopup>
      </Menu>
      <span className="office-tool-gap" />
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={<button type="button" className="office-tool office-tool-text" onMouseDown={keepFocus} />}
          aria-label={tx("Number format")}
          title={tx("Number format")}
          data-sheet-tool="number"
        >
          {tx(NUMBERS.find((entry) => entry.id === choice)?.label ?? "General")}
        </MenuTrigger>
        <MenuPopup align="start" width="sm">
          {NUMBERS.map((entry) => (
            <MenuItem key={entry.id} onClick={() => props.onNumber(entry.id)} data-sheet-number={entry.id}>
              {tx(entry.label)}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <ToolButton label={tx("Fewer decimals")} disabled={disabled} onClick={() => props.onDecimals(-1)} data="decimals-less">
        <DecimalsArrowLeftIcon aria-hidden />
      </ToolButton>
      <ToolButton label={tx("More decimals")} disabled={disabled} onClick={() => props.onDecimals(1)} data="decimals-more">
        <DecimalsArrowRightIcon aria-hidden />
      </ToolButton>
      <span className="office-tool-spacer" />
      <ToolButton label={`${tx("Keyboard shortcuts")} (${props.shortcutHint})`} onClick={props.onShortcuts} data="shortcuts">
        <KeyboardIcon aria-hidden />
      </ToolButton>
    </div>
  );
}
