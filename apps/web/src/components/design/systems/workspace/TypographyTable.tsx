/**
 * Typography: each set of type styles as Name / Preview. The preview draws
 * the pangram in the style (at most 64 px tall); the chip under it names the
 * family and size, and for editors opens the Text popover with font, weight,
 * size, line height and letter spacing. Families, weights and other type
 * values follow as Name / Value tables.
 */
import type { DesignToken } from "@specweave-studio/contracts";
import { PlusIcon } from "lucide-react";
import { useId, useState, type CSSProperties } from "react";

import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../../ui/select";
import { NameValueTable } from "./NameValueTable";
import { tokenToEdit } from "./systemEditIntents";
import { typographyParts } from "./systemSections";
import { GUTTER, TableHeader, TokenRow, type TokenTableProps } from "./tokenRows";
import {
  baseValue,
  familyLabel,
  formatTypeStyle,
  lineHeightProblem,
  noteWithoutTracking,
  normalizeSize,
  parseTypeStyle,
  resolveFamily,
  safeFamily,
  sizeInPx,
  sizeLabel,
  sizeProblem,
  trackingOf,
  trackingProblem,
  weightName,
  WEIGHT_NAMES,
  withTracking,
  type TypeStyle,
} from "./tokenValues";

export const PANGRAM = "The quick brown fox jumps over the lazy dog";
/** Previews never draw taller than this, however large the style. */
const PREVIEW_MAX_PX = 64;

export interface TypeDraft {
  readonly family: string;
  readonly weight: number;
  readonly size: string;
  readonly lineHeight: string;
  readonly tracking: string;
}

export const DEFAULT_TYPE_DRAFT: TypeDraft = {
  family: "system-ui, sans-serif",
  weight: 400,
  size: "16",
  lineHeight: "1.5",
  tracking: "",
};

export function draftOf(style: TypeStyle, tracking: string | null): TypeDraft {
  return {
    family: style.family,
    weight: style.weight,
    size: sizeLabel(style.size),
    lineHeight: style.lineHeight ?? "",
    tracking: tracking ?? "",
  };
}

/** The first problem with a draft, or null. */
export function typeDraftProblem(draft: TypeDraft): string | null {
  if (draft.family.trim() === "" || safeFamily(draft.family.replace(/var\([^)]*\)/g, "x")) === null)
    return "A font is needed.";
  return (
    sizeProblem(draft.size) ??
    lineHeightProblem(draft.lineHeight) ??
    trackingProblem(draft.tracking)
  );
}

/** The `font` shorthand a draft writes; letter spacing goes into the usage note. */
export function typeDraftRaw(draft: TypeDraft, italic = false): string {
  return formatTypeStyle({
    italic,
    weight: draft.weight,
    size: normalizeSize(draft.size),
    lineHeight: draft.lineHeight.trim() === "" ? null : draft.lineHeight.trim(),
    family: draft.family.trim(),
  });
}

/** Font, weight, size, line height and letter spacing, shared by the Text popover and Add. */
export function TypeFields({
  draft,
  onChange,
  families,
}: {
  draft: TypeDraft;
  onChange: (draft: TypeDraft) => void;
  /** The system's font family tokens, offered as `var(--name)`. */
  families: readonly DesignToken[];
}) {
  const id = useId();
  const set = (patch: Partial<TypeDraft>) => onChange({ ...draft, ...patch });
  const problems = {
    size: sizeProblem(draft.size),
    lineHeight: lineHeightProblem(draft.lineHeight),
    tracking: trackingProblem(draft.tracking),
  };
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <div className="col-span-2 flex flex-col gap-1.5">
        <Label htmlFor={`${id}-font`}>Font</Label>
        <Input
          id={`${id}-font`}
          size="sm"
          font="mono"
          list={`${id}-fonts`}
          spellCheck={false}
          value={draft.family}
          placeholder="var(--font-sans)"
          onChange={(event) => set({ family: event.target.value })}
        />
        <datalist id={`${id}-fonts`}>
          {families.map((token) => (
            <option key={token.name} value={`var(--${token.name})`}>
              {familyLabel(baseValue(token, [])?.raw ?? token.name)}
            </option>
          ))}
          <option value="system-ui, sans-serif">System sans</option>
          <option value="Georgia, serif">Georgia</option>
          <option value="ui-monospace, monospace">System mono</option>
        </datalist>
      </div>
      <div className="col-span-2 flex flex-col gap-1.5">
        <Label htmlFor={`${id}-weight`}>Weight</Label>
        <Select
          value={String(draft.weight)}
          onValueChange={(value) => value !== null && set({ weight: Number(value) })}
        >
          <SelectTrigger id={`${id}-weight`} size="sm">
            <SelectValue>{`${draft.weight} ${weightName(draft.weight)}`}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {WEIGHT_NAMES.map(([weight, label]) => (
              <SelectItem key={weight} value={String(weight)}>
                {weight} {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <TypeInput
        id={`${id}-size`}
        label="Size"
        value={draft.size}
        placeholder="16"
        problem={problems.size}
        onChange={(size) => set({ size })}
      />
      <TypeInput
        id={`${id}-line`}
        label="Line height"
        value={draft.lineHeight}
        placeholder="1.5"
        problem={problems.lineHeight}
        onChange={(lineHeight) => set({ lineHeight })}
      />
      <TypeInput
        id={`${id}-tracking`}
        label="Letter spacing"
        value={draft.tracking}
        placeholder="0"
        problem={problems.tracking}
        onChange={(tracking) => set({ tracking })}
        wide
      />
    </div>
  );
}

function TypeInput({
  id,
  label,
  value,
  placeholder,
  problem,
  onChange,
  wide = false,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  problem: string | null;
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2 flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        size="sm"
        font="mono"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-invalid={problem !== null}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== null ? (
        <span role="alert" className="text-destructive-foreground text-xs">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/** Inline style for the pangram: the style itself, scaled down to fit 64 px. */
export function previewStyle(
  style: TypeStyle,
  tracking: string | null,
  tokens: readonly DesignToken[],
): CSSProperties {
  const sizePx = Math.min(160, Math.max(6, sizeInPx(style.size) ?? 16));
  const drawn = Math.min(sizePx, PREVIEW_MAX_PX);
  const scale = drawn / sizePx;
  const lineHeight = style.lineHeight;
  const scaledLine =
    lineHeight === null
      ? undefined
      : /^(?:\d+\.?\d*|\.\d+)$/.test(lineHeight)
        ? Number(lineHeight)
        : `${(sizeInPx(lineHeight) ?? sizePx * 1.2) * scale}px`;
  const scaledTracking =
    tracking === null
      ? undefined
      : tracking.endsWith("px")
        ? `${Number.parseFloat(tracking) * scale}px`
        : tracking;
  const family = safeFamily(resolveFamily(style.family, tokens));
  return {
    fontSize: `${drawn}px`,
    fontWeight: style.weight,
    fontStyle: style.italic ? "italic" : undefined,
    ...(scaledLine === undefined ? {} : { lineHeight: scaledLine }),
    ...(scaledTracking === undefined ? {} : { letterSpacing: scaledTracking }),
    ...(family === null ? {} : { fontFamily: family }),
  };
}

export function TypographyTable(
  props: TokenTableProps & {
    readonly tokens: readonly DesignToken[];
    readonly onAdd: (group: string) => void;
  },
) {
  const parts = typographyParts(props.tokens);
  const columns = `minmax(7.5rem,0.6fr) minmax(12rem,2fr) ${GUTTER}`;
  return (
    <div className="flex flex-col gap-6" data-testid="typography-table">
      {parts.sets.map((set) => (
        <div role="table" aria-label={set.label} key={set.key} className="overflow-x-auto">
          <div className="min-w-[26rem]">
            <div className="flex items-center gap-2 px-3 pb-1">
              <h3 className="font-medium text-sm text-foreground">{set.label}</h3>
              <span className="text-muted-foreground text-xs tabular-nums">
                {set.tokens.length}
              </span>
              {props.canEdit ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Add style"
                  aria-label={`Add a type style to ${set.label}`}
                  onClick={() => props.onAdd(set.key)}
                >
                  <PlusIcon aria-hidden />
                </Button>
              ) : null}
            </div>
            <TableHeader columns={columns} labels={["Name", "Preview"]} />
            {set.tokens.map((token) => (
              <TypeRow
                key={token.name}
                {...props}
                token={token}
                columns={columns}
                families={parts.families}
              />
            ))}
          </div>
        </div>
      ))}
      {parts.families.length > 0 ? (
        <NameValueTable {...props} title="Font families" tokens={parts.families} check="plain" />
      ) : null}
      {parts.weights.length > 0 ? (
        <NameValueTable {...props} title="Font weights" tokens={parts.weights} check="plain" />
      ) : null}
      {parts.other.length > 0 ? (
        <NameValueTable {...props} title="Other type values" tokens={parts.other} check="plain" />
      ) : null}
    </div>
  );
}

function TypeRow(
  props: TokenTableProps & {
    token: DesignToken;
    columns: string;
    families: readonly DesignToken[];
  },
) {
  const { token, system } = props;
  const base = baseValue(token, system.modes);
  const style = base === null ? null : parseTypeStyle(base.raw);
  const tracking = trackingOf(token.description);
  const save = (raw: string, nextTracking: string | null) => {
    const edit = tokenToEdit(token);
    const baseId = system.modes[0]?.id ?? "default";
    void props.onEdit({
      kind: "replace",
      token: {
        ...edit,
        values: { ...edit.values, [baseId]: raw },
        description: withTracking(token.description, nextTracking),
      },
    });
  };
  return (
    <TokenRow
      {...props}
      copyValue={base?.raw ?? null}
      note={noteWithoutTracking(token.description)}
      onSaveNote={(text) =>
        void props.onEdit({
          kind: "replace",
          token: { ...tokenToEdit(token), description: withTracking(text, tracking) },
        })
      }
    >
      <div role="cell" className="flex min-w-0 flex-col gap-1 py-1">
        {style === null ? (
          <span className="truncate font-mono text-[13px] text-muted-foreground">
            {base?.raw ?? "—"}
          </span>
        ) : (
          <>
            <span
              className="block max-w-full truncate whitespace-nowrap text-foreground"
              style={previewStyle(style, tracking, system.tokens)}
              data-testid="type-preview"
            >
              {PANGRAM}
            </span>
            <TypeChip
              {...props}
              style={style}
              tracking={tracking}
              onSave={(draft) => save(typeDraftRaw(draft, style.italic), draft.tracking || null)}
            />
          </>
        )}
      </div>
    </TokenRow>
  );
}

function TypeChip({
  token,
  system,
  canEdit,
  style,
  tracking,
  families,
  onSave,
}: TokenTableProps & {
  token: DesignToken;
  style: TypeStyle;
  tracking: string | null;
  families: readonly DesignToken[];
  onSave: (draft: TypeDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const initial = draftOf(style, tracking);
  const [draft, setDraft] = useState(initial);
  const family = familyLabel(resolveFamily(style.family, system.tokens));
  const chip = `${family} · ${sizeLabel(style.size)}`;
  if (!canEdit)
    return (
      <span className="truncate text-muted-foreground text-xs" data-testid="type-chip">
        {[
          family,
          `${sizeLabel(style.size)}${style.lineHeight === null ? "" : `/${style.lineHeight}`}`,
          weightName(style.weight),
          tracking,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    );
  const close = () => {
    setOpen(false);
    const changed = JSON.stringify(draft) !== JSON.stringify(initial);
    if (changed && typeDraftProblem(draft) === null) onSave(draft);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(initial);
          setOpen(true);
        } else close();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            data-row-edit=""
            data-testid="type-chip"
            aria-label={`Edit text style of ${token.name}`}
            className="inline-flex max-w-full self-start truncate rounded-md border border-border/70 px-1.5 py-0.5 text-muted-foreground text-xs outline-none transition-colors duration-[120ms] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {chip}
      </PopoverTrigger>
      <PopoverPopup width="md" align="start" padding="compact">
        <div className="flex flex-col gap-3 py-1" data-testid="text-popover">
          <PopoverTitle>Text</PopoverTitle>
          <TypeFields draft={draft} onChange={setDraft} families={families} />
          <div className="flex justify-end">
            <Button size="xs" disabled={typeDraftProblem(draft) !== null} onClick={close}>
              Done
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
