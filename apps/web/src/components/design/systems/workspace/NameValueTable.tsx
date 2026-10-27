/**
 * Name / Value tables for spacing, corner radius and the extra families. The
 * value is a monospace field for editors, saved on Enter or when it loses
 * focus; spacing and radius take lengths, the rest any plain CSS value. A
 * length in px, rem or em edits as a number with its unit after it, and
 * spacing and radius rows draw the size. Spacing splits into sub-tables when
 * its names carry more than one prefix.
 */
import type { DesignToken } from "@specweave-studio/contracts";
import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";

import { groupTokensByName } from "./systemSections";
import { GUTTER, TABLE_TITLE, TableHeader, TokenRow, type TokenTableProps } from "./tokenRows";
import {
  aliasTarget,
  baseValue,
  lengthProblem,
  plainValueProblem,
  shadowProblem,
  sizeInPx,
} from "./tokenValues";

export type ValueCheck = "length" | "plain" | "shadow";

export const VALUE_CHECKS: Record<ValueCheck, (raw: string) => string | null> = {
  length: lengthProblem,
  plain: plainValueProblem,
  shadow: shadowProblem,
};

/** `16px` → 16 and px, a bare `0` → 0 and px; null for anything else (calc, var, other numbers). */
export function splitLength(
  raw: string,
): { readonly amount: string; readonly unit: string } | null {
  const text = raw.trim();
  if (/^-?0*\.?0+$/.test(text)) return { amount: text, unit: "px" };
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)$/i.exec(text);
  return match === null ? null : { amount: match[1]!, unit: match[2]!.toLowerCase() };
}

/** A bare number typed into a field with a unit gets that unit; anything else stays as typed. */
export function withUnit(draft: string, unit: string | null): string {
  const text = draft.trim();
  return unit !== null && /^-?(?:\d+\.?\d*|\.\d+)$/.test(text) ? `${text}${unit}` : text;
}

const FIELD =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 font-mono text-[13px] text-foreground outline-none placeholder:text-placeholder transition-[border-color,box-shadow] duration-[120ms] hover:border-ring/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 aria-invalid:border-destructive/60";

/**
 * A monospace value field: Enter or leaving it saves, Escape puts the old
 * value back. With `units`, a length shows its number and its unit after it.
 */
export function ValueField({
  label,
  value,
  check,
  canEdit,
  onCommit,
  className,
  edit = true,
  allowEmpty = false,
  placeholder,
  units = false,
}: {
  label: string;
  value: string;
  check: ValueCheck;
  canEdit: boolean;
  onCommit: (raw: string) => void;
  className?: string | undefined;
  /** Marks the field the row menu's Edit focuses. */
  edit?: boolean;
  /** An empty value is allowed (a later mode inheriting the first mode's). */
  allowEmpty?: boolean;
  placeholder?: string | undefined;
  /** Edit a px, rem or em length as a number with its unit shown after it. */
  units?: boolean;
}) {
  const errorId = useId();
  const unitId = useId();
  const split = units ? splitLength(value) : null;
  const unit = split?.unit ?? null;
  const shown = split?.amount ?? value;
  const [draft, setDraft] = useState(shown);
  const [seen, setSeen] = useState(value);
  // A new value from the server replaces the draft unless the person is mid-edit.
  if (value !== seen) {
    setSeen(value);
    setDraft(shown);
  }
  const next = withUnit(draft, unit);
  // Leaving the field untouched never saves, even when the stored form differs (`16PX`, `0`).
  const untouched = draft.trim() === shown.trim();
  const problem =
    untouched || next === value.trim() || (allowEmpty && draft.trim() === "")
      ? null
      : VALUE_CHECKS[check](next);
  if (!canEdit)
    return (
      <span className={cn("block truncate font-mono text-[13px] text-foreground", className)}>
        {value}
      </span>
    );
  const commit = () => {
    if (untouched || next === value.trim() || problem !== null) return;
    onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(shown);
    }
  };
  // The unit stays put while the number is edited; a typed unit replaces it.
  const suffix = unit !== null && withUnit(draft, unit) !== draft.trim() ? unit : null;
  const describedBy = [problem !== null ? errorId : null, suffix !== null ? unitId : null]
    .filter((id) => id !== null)
    .join(" ");
  return (
    <span className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="relative flex min-w-0">
        <input
          aria-label={label}
          aria-invalid={problem !== null}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          data-row-edit={edit ? "" : undefined}
          spellCheck={false}
          value={draft}
          placeholder={placeholder}
          className={cn(FIELD, suffix !== null && "pr-9")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
        {suffix !== null ? (
          <span
            id={unitId}
            className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center font-mono text-muted-foreground text-xs"
          >
            {suffix}
          </span>
        ) : null}
      </span>
      {problem !== null ? (
        <span id={errorId} role="alert" className="text-destructive-foreground text-xs">
          {problem}
        </span>
      ) : null}
    </span>
  );
}

export function NameValueTable(
  props: TokenTableProps & {
    readonly tokens: readonly DesignToken[];
    readonly check: ValueCheck;
    /** A heading above the table, for tables inside another section. */
    readonly title?: string;
    /** Split into sub-tables by name prefix when there is more than one. */
    readonly split?: boolean;
    /** Draws each value: a bar for spacing, a corner for radius. */
    readonly preview?: "spacing" | "radius";
  },
) {
  // The value column may shrink to nothing: its field and drawing wrap instead of pushing Remove out.
  const columns = `minmax(min(8rem,28vw),1fr) minmax(0,2.4fr) ${GUTTER}`;
  const groups = props.split ? groupTokensByName(props.tokens) : [];
  const tables =
    groups.length > 1
      ? groups.map((group) => ({ key: group.key, title: group.label, tokens: group.tokens }))
      : [{ key: "all", title: props.title, tokens: props.tokens }];
  return (
    <div className="flex flex-col gap-8" data-testid="name-value-table">
      {tables.map((table) => (
        <div role="table" aria-label={table.title ?? "Tokens"} key={table.key}>
          {table.title !== undefined ? (
            <div className={TABLE_TITLE}>
              <h3 className="font-medium text-sm text-foreground">{table.title}</h3>
            </div>
          ) : null}
          <TableHeader columns={columns} labels={["Name", "Value"]} />
          {table.tokens.map((token) => (
            <ValueRow key={token.name} {...props} token={token} columns={columns} />
          ))}
        </div>
      ))}
    </div>
  );
}

const PREVIEW_MAX = 240;

/** A bar as long as the space, or a corner drawn at the radius; nothing for values it can't size. */
export function SizePreview({ raw, kind }: { raw: string; kind: "spacing" | "radius" }) {
  const px = sizeInPx(raw);
  if (px === null) return null;
  if (kind === "spacing")
    return (
      <span
        aria-hidden
        data-testid="spacing-preview"
        className="h-3 max-w-full shrink-0 rounded-[2px] bg-primary/55"
        style={{ width: `${Math.max(1, Math.min(PREVIEW_MAX, px))}px` }}
      />
    );
  return (
    <span
      aria-hidden
      data-testid="radius-preview"
      className="size-8 shrink-0 border-primary/70 border-t-2 border-l-2 bg-primary/8"
      style={{ borderTopLeftRadius: `${Math.min(32, px)}px` }}
    />
  );
}

function ValueRow(
  props: TokenTableProps & {
    token: DesignToken;
    columns: string;
    check: ValueCheck;
    preview?: "spacing" | "radius";
  },
) {
  const { token, system } = props;
  const base = baseValue(token, system.modes);
  const baseId = system.modes[0]?.id ?? "default";
  // Values a later mode sets for itself, so they are not hidden behind the first mode's.
  const others = system.modes
    .slice(1)
    .filter(
      (mode) => token.values[mode.id] !== undefined && token.values[mode.id]!.raw !== base?.raw,
    )
    .map((mode) => `${mode.name} ${token.values[mode.id]!.raw}`);
  return (
    <TokenRow
      {...props}
      copyValue={base?.raw ?? null}
      aliasOf={token.aliasOf ?? (base === null ? null : aliasTarget(base.raw))}
    >
      <div role="cell" className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5">
          <ValueField
            label={`Value of ${token.name}`}
            value={base?.raw ?? ""}
            check={props.check}
            canEdit={props.canEdit}
            units={props.check === "length"}
            className={props.check === "length" ? "w-36 max-w-full" : "max-w-[36rem] flex-1"}
            onCommit={(raw) =>
              void props.onEdit({ kind: "set-value", name: token.name, modeId: baseId, raw })
            }
          />
          {props.preview !== undefined && base !== null ? (
            <SizePreview raw={base.resolved ?? base.raw} kind={props.preview} />
          ) : null}
        </span>
        {others.length > 0 ? (
          <span className="truncate px-2 font-mono text-muted-foreground text-xs">
            {others.join(" · ")}
          </span>
        ) : null}
      </div>
    </TokenRow>
  );
}
