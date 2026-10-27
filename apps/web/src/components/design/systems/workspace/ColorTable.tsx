/**
 * Colors: one table per group derived from names, with a column per mode.
 * A cell is a field holding a swatch (click copies the value), the hex value
 * and its opacity; a text color adds its contrast on the page ground; an
 * alias links to its target; a later mode without its own value says it
 * inherits the first mode's. Editors change a value in a color field: the
 * system color picker, an opacity slider and the CSS text.
 */
import type { DesignSystem, DesignToken } from "@specweave-studio/contracts";
import { ArrowUpRightIcon, CheckIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../../ui/popover";
import { LARGE_RATIO, ratioLabel, TEXT_RATIO, tokenContrast, type ContrastCheck } from "./contrast";
import { copyText } from "./pageActions";
import { groupTokensByName } from "./systemSections";
import {
  GUTTER,
  TABLE_TITLE,
  TableHeader,
  TokensScroller,
  TokenRow,
  type TokenTableProps,
} from "./tokenRows";
import {
  aliasTarget,
  baseValue,
  colorLabel,
  colorProblem,
  formatColor,
  hexOf,
  isCssColor,
  modeValue,
  parseColor,
  shownValue,
} from "./tokenValues";

/** A checkerboard under the swatch, so a see-through color reads as see-through. */
const CHECKER: CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#d4d4d8 25%,transparent 25%),linear-gradient(-45deg,#d4d4d8 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d4d4d8 75%),linear-gradient(-45deg,transparent 75%,#d4d4d8 75%)",
  backgroundSize: "8px 8px",
  backgroundPosition: "0 0,0 4px,4px -4px,-4px 0",
  backgroundColor: "#fff",
};

export function Swatch({ color, label }: { color: string | null; label: string }) {
  return (
    <button
      type="button"
      title="Copy"
      aria-label={`Copy ${label}`}
      disabled={color === null}
      className="relative size-5 shrink-0 overflow-hidden rounded-[5px] outline-none ring-1 ring-black/10 ring-inset focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default dark:ring-white/15"
      style={color === null ? undefined : CHECKER}
      onClick={() => void copyText(label)}
    >
      <span
        aria-hidden
        className="absolute inset-0"
        style={color === null ? undefined : { backgroundColor: color }}
      />
    </button>
  );
}

export function ColorTable(
  props: TokenTableProps & {
    readonly tokens: readonly DesignToken[];
    /** Opens the add dialog with a group chosen. */
    readonly onAdd: (group: string) => void;
  },
) {
  const modes = props.system.modes;
  // Name and modes side by side; in a table under 42rem the name and actions
  // share a line, so Light and Dark fit at 360 px. More modes scroll sideways.
  const nameMin = "min(9rem, 26vw)";
  const modeMin = "min(11rem, 42vw)";
  const columns = `minmax(${nameMin},1.1fr) repeat(${modes.length}, minmax(${modeMin},1fr)) ${GUTTER}`;
  const narrowColumns = `repeat(${modes.length}, minmax(6.5rem,1fr))`;
  // Columns, the gaps between them and the row's side padding, wide and narrow.
  const minWidth = {
    "--table-min": `calc(${nameMin} + ${modes.length} * ${modeMin} + ${GUTTER} + ${modes.length + 1}rem + 3.5rem)`,
    "--table-min-narrow": `calc(${modes.length} * 6.5rem + ${(modes.length - 1) * 0.5}rem + 2.5rem)`,
  } as CSSProperties;
  const colorNames = props.system.tokens
    .filter((token) => token.type === "color")
    .map((token) => token.name);
  const groups = groupTokensByName(props.tokens);
  return (
    <TokensScroller data-testid="color-table">
      <div
        className="flex min-w-[var(--table-min-narrow)] flex-col gap-8 @2xl/tokens:min-w-[var(--table-min)]"
        style={minWidth}
      >
        {groups.map((group) => (
          <div role="table" aria-label={`${group.label} colors`} key={group.key}>
            <div className={TABLE_TITLE}>
              <h3 className="font-medium text-sm text-foreground">{group.label}</h3>
              <span className="text-muted-foreground text-xs tabular-nums">
                {group.tokens.length}
              </span>
              {props.canEdit ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Add color"
                  aria-label={`Add color to ${group.label}`}
                  onClick={() => props.onAdd(group.key)}
                >
                  <PlusIcon aria-hidden />
                </Button>
              ) : null}
            </div>
            <TableHeader
              columns={columns}
              narrowColumns={narrowColumns}
              labels={["Name", ...modes.map((mode) => mode.name)]}
            />
            {group.tokens.map((token) => {
              const base = baseValue(token, modes);
              return (
                <TokenRow
                  key={token.name}
                  {...props}
                  token={token}
                  columns={columns}
                  narrowColumns={narrowColumns}
                  copyValue={base === null ? null : base.raw}
                  aliasOf={token.aliasOf ?? (base === null ? null : aliasTarget(base.raw))}
                >
                  {modes.map((mode, index) => (
                    <ColorCell
                      key={mode.id}
                      {...props}
                      token={token}
                      mode={mode}
                      isBase={index === 0}
                      colorNames={colorNames}
                    />
                  ))}
                </TokenRow>
              );
            })}
          </div>
        ))}
      </div>
    </TokensScroller>
  );
}

/** The field a color value sits in; read-only viewers see it without a fill. */
const FIELD =
  "flex h-8 w-full max-w-[16rem] min-w-0 items-center gap-2 rounded-md border pr-1.5 pl-1.5 transition-colors duration-[120ms]";

function ColorCell({
  token,
  mode,
  isBase,
  system,
  canEdit,
  colorNames,
  onEdit,
  onGoTo,
}: TokenTableProps & {
  token: DesignToken;
  mode: DesignSystem["modes"][number];
  isBase: boolean;
  colorNames: readonly string[];
}) {
  const value = modeValue(token, system.modes, mode.id);
  if (value === null)
    return (
      <div role="cell" className="text-muted-foreground text-sm">
        —
      </div>
    );
  const shown = shownValue(value);
  const paint = isCssColor(shown) ? shown : null;
  const label = colorLabel(paint === null ? value.raw : shown);
  const alias = aliasTarget(value.raw);
  const baseName = system.modes[0]?.name ?? "the first mode";
  const contrast = tokenContrast(token, system, mode);
  const text = value.inherited ? (
    <span className="truncate text-muted-foreground text-[13px]">Inherits {baseName}</span>
  ) : (
    <>
      <span className="truncate font-mono text-[13px] tabular-nums">{label.text}</span>
      {label.alpha !== null ? (
        <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
          {label.alpha}
        </span>
      ) : null}
    </>
  );
  return (
    <div
      role="cell"
      data-mode={mode.id}
      data-inherited={value.inherited || undefined}
      title={value.inherited ? `Inherits ${baseName}` : undefined}
      className="flex min-w-0 items-center gap-1"
    >
      <div
        className={cn(
          FIELD,
          canEdit
            ? "border-input bg-background focus-within:border-ring hover:border-ring/60"
            : "border-border/60",
          value.inherited && "border-dashed",
        )}
      >
        <Swatch color={paint} label={paint ?? value.raw} />
        {canEdit ? (
          <ColorField
            name={token.name}
            modeName={mode.name}
            baseName={baseName}
            isBase={isBase}
            raw={value.inherited ? "" : value.raw}
            placeholder={value.raw}
            colorNames={colorNames}
            onCommit={(raw) =>
              void onEdit({ kind: "set-value", name: token.name, modeId: mode.id, raw })
            }
          >
            {text}
          </ColorField>
        ) : (
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">{text}</span>
        )}
        {contrast !== null ? <ContrastBadge check={contrast} modeName={mode.name} /> : null}
      </div>
      {alias !== null && !value.inherited ? (
        <button
          type="button"
          title={`Alias of ${alias}`}
          aria-label={`Go to ${alias}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onGoTo(alias)}
        >
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** "✓ 14.2:1" at 4.5:1 or more; a warning below, red under 3:1. */
export function ContrastBadge({ check, modeName }: { check: ContrastCheck; modeName: string }) {
  const passes = check.ratio >= TEXT_RATIO;
  const large = !passes && check.ratio >= LARGE_RATIO;
  const ratio = ratioLabel(check.ratio);
  const verdict = passes
    ? "passes for body text"
    : large
      ? "large text only; body text needs 4.5:1"
      : "fails; body text needs 4.5:1";
  return (
    <span
      data-testid="contrast-badge"
      data-passes={passes}
      title={`${ratio} on ${check.against} in ${modeName}: ${verdict}`}
      className={cn(
        "ml-auto inline-flex shrink-0 items-center gap-0.5 font-mono text-[11px] tabular-nums",
        passes
          ? "text-muted-foreground"
          : large
            ? "text-warning-foreground"
            : "text-destructive-foreground",
      )}
    >
      {passes ? (
        <CheckIcon aria-hidden className="size-3" />
      ) : (
        <TriangleAlertIcon aria-hidden className="size-3" />
      )}
      <span className="@max-md/tokens:sr-only">{ratio}</span>
      <span className="sr-only"> contrast, {verdict}</span>
    </span>
  );
}

/**
 * The color field: the system picker, an opacity slider and the CSS value.
 * The value is saved when the field closes; an invalid one is dropped.
 */
export function ColorField({
  name,
  modeName,
  baseName,
  isBase,
  raw,
  placeholder,
  colorNames,
  onCommit,
  children,
}: {
  name: string;
  modeName: string;
  baseName: string;
  isBase: boolean;
  /** The mode's own value; empty while it inherits. */
  raw: string;
  placeholder: string;
  colorNames: readonly string[];
  /** A new value, or null to copy the first mode's value. */
  onCommit: (raw: string | null) => void;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(raw);
  const problem = draft.trim() === "" && !isBase ? null : colorProblem(draft, name, colorNames);
  const parsed = parseColor(draft) ?? parseColor(placeholder);
  const rgb = parsed ?? { r: 0, g: 0, b: 0, a: 1 };
  const close = (commit: boolean) => {
    setOpen(false);
    if (!commit) return;
    const next = draft.trim();
    if (next === raw.trim()) return;
    if (next === "" && !isBase) return onCommit(null);
    if (problem === null) onCommit(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(raw);
          setOpen(true);
        } else close(true);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            data-row-edit={isBase ? "" : undefined}
            aria-label={`Edit ${name}, ${modeName}`}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup width="sm" align="start" padding="compact">
        <div className="flex flex-col gap-3 py-1" data-testid="color-field">
          <PopoverTitle className="flex items-baseline gap-1.5">
            <span className="truncate font-mono font-normal">{name}</span>
            <span className="shrink-0 font-normal text-muted-foreground text-xs">{modeName}</span>
          </PopoverTitle>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick a color"
              value={hexOf(rgb).toLowerCase()}
              className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
              onChange={(event) => {
                const picked = parseColor(event.target.value);
                if (picked !== null) setDraft(formatColor({ ...picked, a: rgb.a }));
              }}
            />
            <Input
              id={`${id}-value`}
              size="sm"
              font="mono"
              aria-label="Color value"
              aria-invalid={problem !== null}
              spellCheck={false}
              value={draft}
              placeholder={isBase ? "#595ecc" : placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  close(true);
                }
              }}
            />
          </div>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <span className="flex justify-between">
              <span>Opacity</span>
              <span className="tabular-nums">{Math.round(rgb.a * 100)}% opaque</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(rgb.a * 100)}
              disabled={parsed === null}
              className="w-full accent-primary"
              onChange={(event) =>
                setDraft(formatColor({ ...rgb, a: Number(event.target.value) / 100 }))
              }
            />
          </label>
          {problem !== null ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {problem}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            {!isBase ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={raw.trim() === ""}
                onClick={() => {
                  setDraft("");
                  setOpen(false);
                  onCommit(null);
                }}
              >
                Use {baseName}'s value
              </Button>
            ) : (
              <span />
            )}
            <Button size="xs" onClick={() => close(true)}>
              Done
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
