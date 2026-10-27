/**
 * Shadows: one stage per mode. A well in the mode's page-ground color holds
 * a small card in its surface color that carries the shadow, so elevation
 * reads as it will on the page. The value sits under each stage.
 */
import type { DesignSystem, DesignToken } from "@specweave-studio/contracts";
import { safeCssValue } from "@specweave-studio/shared/designRender";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

import { ValueField } from "./NameValueTable";
import { GUTTER, TableHeader, TokenRow, TokensScroller, type TokenTableProps } from "./tokenRows";
import { baseValue, modeValue, shadowStage } from "./tokenValues";

export function ShadowTable(props: TokenTableProps & { readonly tokens: readonly DesignToken[] }) {
  const modes = props.system.modes;
  const columns = `minmax(8rem,0.8fr) repeat(${modes.length}, minmax(11rem,1fr)) ${GUTTER}`;
  // In a table under 42rem the name and actions share a line and the stages the line under it.
  const narrowColumns = `repeat(${modes.length}, minmax(7rem,1fr))`;
  const stages = new Map(modes.map((mode) => [mode.id, shadowStage(props.system, mode)]));
  return (
    <TokensScroller data-testid="shadow-table">
      <div
        role="table"
        aria-label="Shadows"
        className="min-w-[var(--table-min-narrow)] @2xl/tokens:min-w-[var(--table-min)]"
        // Columns, the gaps between them and the row's side padding, wide and narrow.
        style={
          {
            "--table-min": `${8 + 11 * modes.length + 4.25 + (modes.length + 1) + 3.5}rem`,
            "--table-min-narrow": `${7.5 * modes.length - 0.5 + 2.5}rem`,
          } as CSSProperties
        }
      >
        <TableHeader
          columns={columns}
          narrowColumns={narrowColumns}
          labels={["Name", ...modes.map((mode) => mode.name)]}
        />
        {props.tokens.map((token) => {
          const base = baseValue(token, modes);
          return (
            <TokenRow
              key={token.name}
              {...props}
              token={token}
              columns={columns}
              narrowColumns={narrowColumns}
              copyValue={base?.raw ?? null}
            >
              {modes.map((mode, index) => (
                <ShadowCell
                  key={mode.id}
                  {...props}
                  token={token}
                  mode={mode}
                  isBase={index === 0}
                  stage={stages.get(mode.id)!}
                />
              ))}
            </TokenRow>
          );
        })}
      </div>
    </TokensScroller>
  );
}

function ShadowCell({
  token,
  mode,
  isBase,
  stage,
  system,
  canEdit,
  onEdit,
}: TokenTableProps & {
  token: DesignToken;
  mode: DesignSystem["modes"][number];
  isBase: boolean;
  stage: { ground: string; surface: string };
}) {
  const value = modeValue(token, system.modes, mode.id);
  const shadow = value === null ? undefined : safeCssValue(value.resolved ?? value.raw);
  return (
    <div role="cell" className="flex min-w-0 flex-col gap-1.5 py-1.5" data-mode={mode.id}>
      <div
        aria-hidden
        data-testid="shadow-stage"
        className="flex h-28 items-center justify-center rounded-lg ring-1 ring-black/5 ring-inset dark:ring-white/8"
        style={{ backgroundColor: stage.ground }}
      >
        <div
          className={cn("h-14 w-[62%] max-w-40 rounded-lg", value?.inherited && "opacity-70")}
          style={{ backgroundColor: stage.surface, boxShadow: shadow }}
        />
      </div>
      <ValueField
        label={`${token.name}, ${mode.name}`}
        value={value === null || (value.inherited && canEdit) ? "" : value.raw}
        placeholder={value?.inherited ? value.raw : undefined}
        check="shadow"
        canEdit={canEdit}
        allowEmpty={!isBase}
        edit={isBase}
        className={value?.inherited && !canEdit ? "opacity-60" : undefined}
        onCommit={(raw) =>
          void onEdit({
            kind: "set-value",
            name: token.name,
            modeId: mode.id,
            raw: raw === "" && !isBase ? null : raw,
          })
        }
      />
    </div>
  );
}
