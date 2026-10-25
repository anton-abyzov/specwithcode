/**
 * Name / Value tables for spacing, corner radius and the extra families. The
 * value is a monospace field for editors, saved on Enter or when it loses
 * focus; spacing and radius take lengths, the rest any plain CSS value.
 * Spacing splits into sub-tables when its names carry more than one prefix.
 */
import type { DesignToken } from "@specweave-studio/contracts";
import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";

import { groupTokensByName } from "./systemSections";
import { GUTTER, TableHeader, TokenRow, type TokenTableProps } from "./tokenRows";
import {
  aliasTarget,
  baseValue,
  lengthProblem,
  plainValueProblem,
  shadowProblem,
} from "./tokenValues";

export type ValueCheck = "length" | "plain" | "shadow";

export const VALUE_CHECKS: Record<ValueCheck, (raw: string) => string | null> = {
  length: lengthProblem,
  plain: plainValueProblem,
  shadow: shadowProblem,
};

/** A monospace value field: Enter or leaving it saves, Escape puts the old value back. */
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
}) {
  const errorId = useId();
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // A new value from the server replaces the draft unless the person is mid-edit.
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const problem =
    draft.trim() === value.trim() || (allowEmpty && draft.trim() === "")
      ? null
      : VALUE_CHECKS[check](draft);
  if (!canEdit)
    return (
      <span className={cn("block truncate font-mono text-[13px] text-foreground", className)}>
        {value}
      </span>
    );
  const commit = () => {
    const next = draft.trim();
    if (next === value.trim() || problem !== null) return;
    onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(value);
    }
  };
  return (
    <span className={cn("flex min-w-0 flex-col gap-1", className)}>
      <input
        aria-label={label}
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? errorId : undefined}
        data-row-edit={edit ? "" : undefined}
        spellCheck={false}
        value={draft}
        placeholder={placeholder}
        className="h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 font-mono text-[13px] text-foreground outline-none placeholder:text-placeholder transition-[border-color,background-color] duration-[120ms] hover:border-input focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/25 aria-invalid:border-destructive/60"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
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
  },
) {
  const columns = `minmax(8rem,1fr) minmax(9rem,1.4fr) ${GUTTER}`;
  const groups = props.split ? groupTokensByName(props.tokens) : [];
  const tables =
    groups.length > 1
      ? groups.map((group) => ({ key: group.key, title: group.label, tokens: group.tokens }))
      : [{ key: "all", title: props.title, tokens: props.tokens }];
  return (
    <div className="flex flex-col gap-5" data-testid="name-value-table">
      {tables.map((table) => (
        <div role="table" aria-label={table.title ?? "Tokens"} key={table.key}>
          {table.title !== undefined ? (
            <h3 className="px-3 pb-1 font-medium text-sm text-foreground">{table.title}</h3>
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

function ValueRow(
  props: TokenTableProps & { token: DesignToken; columns: string; check: ValueCheck },
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
        <ValueField
          label={`Value of ${token.name}`}
          value={base?.raw ?? ""}
          check={props.check}
          canEdit={props.canEdit}
          onCommit={(raw) =>
            void props.onEdit({ kind: "set-value", name: token.name, modeId: baseId, raw })
          }
        />
        {others.length > 0 ? (
          <span className="truncate px-1.5 font-mono text-muted-foreground text-xs">
            {others.join(" · ")}
          </span>
        ) : null}
      </div>
    </TokenRow>
  );
}
