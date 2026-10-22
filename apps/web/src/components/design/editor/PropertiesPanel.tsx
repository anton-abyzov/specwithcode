import type {
  DesignLength,
  DesignNode,
  DesignOperation,
  DesignPage,
  DesignPaint,
  DesignSystem,
  DesignToken,
} from "@specweave-studio/contracts";
import { NOTE_COLORS, designTokenValue } from "@specweave-studio/shared/designRender";
import {
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignEndHorizontalIcon,
  AlignEndVerticalIcon,
  AlignHorizontalSpaceAroundIcon,
  AlignStartHorizontalIcon,
  AlignStartVerticalIcon,
  AlignVerticalSpaceAroundIcon,
  ArrowDownToLineIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  BracesIcon,
  SlashIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useFieldDraft } from "./fieldDraft";
import {
  alignOperations,
  distributeOperations,
  indexNodes,
  reorderOperations,
  type Alignment,
} from "../canvas/geometry";

/**
 * Position, size, fill, stroke, radius, opacity and text style of the
 * selection. Color and type fields offer the design system's tokens and
 * store `{ token }` references, so a token change in the system restyles
 * every node that uses it.
 */
export function PropertiesPanel({
  page,
  selection,
  system,
  mode,
  readOnly,
  onCommit,
  onPreview,
}: {
  page: DesignPage;
  selection: readonly string[];
  system: DesignSystem | null;
  mode: string;
  readOnly: boolean;
  onCommit: (operations: DesignOperation[]) => void;
  /** Shows a change without saving it (a color drag); the next commit replaces it. */
  onPreview: (operations: DesignOperation[] | null) => void;
}) {
  const index = useMemo(() => indexNodes(page), [page]);
  const nodes = selection.map((id) => index.get(id)).filter((node) => node !== undefined);
  const node = nodes.length === 1 ? nodes[0]! : null;
  const patchAll = (
    patch: Record<string, unknown>,
    filter: (node: DesignNode) => boolean = () => true,
  ) =>
    onCommit(
      nodes
        .filter(filter)
        .map((target) => ({ op: "update_node" as const, pageId: page.id, id: target.id, patch })),
    );
  const patch = (key: string, value: unknown) => patchAll({ [key]: value });
  const previewAll = (patch: Record<string, unknown>) =>
    onPreview(
      nodes.map((target) => ({
        op: "update_node" as const,
        pageId: page.id,
        id: target.id,
        patch,
      })),
    );

  if (nodes.length === 0)
    return (
      <PanelShell>
        <p className="px-3 py-4 text-xs text-muted-foreground">
          Select a layer to edit its position, size and style.
          {system === null
            ? " This design has no design system, so tokens are not offered."
            : ` Tokens come from ${system.name}.`}
        </p>
      </PanelShell>
    );

  const fillable = nodes.every(
    (item) =>
      item.type === "frame" ||
      item.type === "rect" ||
      item.type === "ellipse" ||
      item.type === "path",
  );
  const strokable = nodes.every(
    (item) =>
      item.type === "frame" ||
      item.type === "rect" ||
      item.type === "ellipse" ||
      item.type === "line" ||
      item.type === "path",
  );
  const rounded = nodes.every(
    (item) => item.type === "frame" || item.type === "rect" || item.type === "image",
  );

  return (
    <PanelShell>
      <fieldset disabled={readOnly} className="contents">
        {node !== null && (
          <Section title="Layer">
            <LayerNameField key={node.id} node={node} onRename={(name) => patch("name", name)} />
          </Section>
        )}
        <Section title="Arrange">
          <div className="flex flex-wrap gap-0.5">
            {ALIGN.map(([alignment, label, Icon]) => (
              <IconAction
                key={alignment}
                label={label}
                disabled={readOnly || (nodes.length === 1 && node?.parentId === null)}
                onClick={() => onCommit(alignOperations(page, index, selection, alignment))}
              >
                <Icon />
              </IconAction>
            ))}
            <IconAction
              label="Distribute horizontally"
              disabled={readOnly || nodes.length < 3}
              onClick={() => onCommit(distributeOperations(page, index, selection, "horizontal"))}
            >
              <AlignHorizontalSpaceAroundIcon />
            </IconAction>
            <IconAction
              label="Distribute vertically"
              disabled={readOnly || nodes.length < 3}
              onClick={() => onCommit(distributeOperations(page, index, selection, "vertical"))}
            >
              <AlignVerticalSpaceAroundIcon />
            </IconAction>
          </div>
          <div className="mt-1 flex gap-0.5">
            <IconAction
              label="Bring to front (Shift+])"
              disabled={readOnly}
              onClick={() => onCommit(reorderOperations(page, selection, "front"))}
            >
              <ArrowUpToLineIcon />
            </IconAction>
            <IconAction
              label="Bring forward (])"
              disabled={readOnly}
              onClick={() => onCommit(reorderOperations(page, selection, "forward"))}
            >
              <ArrowUpIcon />
            </IconAction>
            <IconAction
              label="Send backward ([)"
              disabled={readOnly}
              onClick={() => onCommit(reorderOperations(page, selection, "backward"))}
            >
              <ArrowDownIcon />
            </IconAction>
            <IconAction
              label="Send to back (Shift+[)"
              disabled={readOnly}
              onClick={() => onCommit(reorderOperations(page, selection, "back"))}
            >
              <ArrowDownToLineIcon />
            </IconAction>
          </div>
        </Section>
        {node !== null && (
          <Section title="Position and size">
            <div className="grid grid-cols-2 gap-1.5">
              <NumberInput label="X" value={node.x} onChange={(value) => patch("x", value)} />
              <NumberInput label="Y" value={node.y} onChange={(value) => patch("y", value)} />
              <NumberInput
                label="W"
                min={1}
                value={node.width}
                onChange={(value) => patch("width", Math.max(1, value))}
              />
              <NumberInput
                label="H"
                min={1}
                value={node.height}
                onChange={(value) => patch("height", Math.max(1, value))}
              />
            </div>
          </Section>
        )}
        <Section title="Layer style">
          <NumberInput
            label="Opacity"
            suffix="%"
            min={0}
            max={100}
            value={Math.round((node?.opacity ?? nodes[0]!.opacity ?? 1) * 100)}
            onChange={(value) => patchAll({ opacity: Math.min(1, Math.max(0, value / 100)) })}
          />
          {rounded && (
            <LengthField
              label="Radius"
              value={(nodes[0] as { radius?: DesignLength }).radius}
              system={system}
              mode={mode}
              onChange={(value) => patchAll({ radius: value })}
            />
          )}
        </Section>
        {fillable && (
          <Section title="Fill">
            <PaintField
              label="Fill"
              value={(nodes[0] as { fill?: DesignPaint }).fill}
              system={system}
              mode={mode}
              onChange={(value) => patchAll({ fill: value })}
              onPreview={(value) => previewAll({ fill: value })}
            />
          </Section>
        )}
        {strokable && (
          <Section title="Stroke">
            <PaintField
              label="Stroke"
              value={(nodes[0] as { stroke?: DesignPaint }).stroke}
              system={system}
              mode={mode}
              onChange={(value) => patchAll({ stroke: value })}
              onPreview={(value) => previewAll({ stroke: value })}
            />
            <NumberInput
              label="Width"
              min={0}
              value={
                (nodes[0] as { strokeWidth?: number }).strokeWidth ??
                (nodes[0]!.type === "line" || nodes[0]!.type === "path" ? 2 : 1)
              }
              onChange={(value) => patchAll({ strokeWidth: Math.max(0, value) })}
            />
          </Section>
        )}
        {node?.type === "text" && (
          <TextSection
            node={node}
            system={system}
            mode={mode}
            onPatch={(fields) => patchAll(fields)}
            onPreviewPatch={(fields) => previewAll(fields)}
          />
        )}
        {node?.type === "note" && (
          <Section title="Note color">
            <div className="flex gap-1">
              {(Object.keys(NOTE_COLORS) as (keyof typeof NOTE_COLORS)[]).map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Note ${color}`}
                  aria-pressed={(node.color ?? "yellow") === color}
                  className="size-6 rounded-sm border border-border aria-pressed:ring-2 aria-pressed:ring-ring"
                  style={{ background: NOTE_COLORS[color] }}
                  onClick={() => patch("color", color)}
                />
              ))}
            </div>
          </Section>
        )}
      </fieldset>
    </PanelShell>
  );
}

const ALIGN: readonly [Alignment, string, typeof AlignStartVerticalIcon][] = [
  ["left", "Align left (Alt+A)", AlignStartVerticalIcon],
  ["hcenter", "Align horizontal centers (Alt+H)", AlignCenterVerticalIcon],
  ["right", "Align right (Alt+D)", AlignEndVerticalIcon],
  ["top", "Align top (Alt+W)", AlignStartHorizontalIcon],
  ["vcenter", "Align vertical centers (Alt+V)", AlignCenterHorizontalIcon],
  ["bottom", "Align bottom (Alt+S)", AlignEndHorizontalIcon],
];

export function labelFor(node: DesignNode): string {
  switch (node.type) {
    case "frame":
      return "Frame";
    case "rect":
      return "Rectangle";
    case "ellipse":
      return "Ellipse";
    case "line":
      return "Line";
    case "path":
      return "Path";
    case "text":
      return node.text.slice(0, 40) || "Text";
    case "image":
      return "Image";
    case "note":
      return "Note";
    case "html":
      return "HTML";
    case "component":
      return node.componentId;
  }
}

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="properties-panel"
      className="flex min-h-0 flex-col overflow-y-auto pb-3 text-sm"
    >
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-border/70 px-3 py-2.5 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const field = useFieldDraft(formatNumber(value));
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{label}</span>
      <Input
        size="compact"
        font="mono"
        inputMode="decimal"
        aria-label={label}
        {...field.inputProps}
        onBlur={(event) => {
          const parsed = Number(event.currentTarget.value);
          field.end();
          if (!Number.isFinite(parsed)) return;
          const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
          if (next !== value) onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const step = (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
            const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value + step));
            field.set(formatNumber(next));
            onChange(next);
          }
        }}
      />
      {suffix !== undefined && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </label>
  );
}

function formatNumber(value: number) {
  return String(Math.round(value * 100) / 100);
}

function LayerNameField({
  node,
  onRename,
}: {
  node: DesignNode;
  onRename: (name: string | null) => void;
}) {
  const field = useFieldDraft(node.name ?? "");
  return (
    <Input
      size="compact"
      aria-label="Layer name"
      {...field.inputProps}
      placeholder={labelFor(node)}
      onBlur={(event) => {
        const value = event.currentTarget.value.trim();
        field.end();
        if (value !== (node.name ?? "")) onRename(value === "" ? null : value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function tokensOf(system: DesignSystem | null, types: readonly DesignToken["type"][]) {
  return system?.tokens.filter((token) => types.includes(token.type)) ?? [];
}

function TokenList({
  tokens,
  system,
  mode,
  swatch,
  onPick,
}: {
  tokens: readonly DesignToken[];
  system: DesignSystem | null;
  mode: string;
  swatch: boolean;
  onPick: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = tokens
    .filter((token) => token.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 200);
  if (tokens.length === 0)
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        {system === null
          ? "No design system on this design."
          : `${system.name} has no tokens of this kind.`}
      </p>
    );
  return (
    <div className="flex flex-col gap-1">
      <Input
        size="compact"
        placeholder="Search tokens"
        aria-label="Search tokens"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <ul className="max-h-64 overflow-y-auto" role="listbox" aria-label="Tokens">
        {shown.map((token) => {
          const value = designTokenValue(system, token.name, mode) ?? "";
          return (
            <li key={token.name}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => onPick(token.name)}
              >
                {swatch && (
                  <span
                    className="size-3.5 shrink-0 rounded-xs border border-border"
                    style={{ background: value }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{token.name}</span>
                <span className="max-w-24 shrink-0 truncate font-mono text-muted-foreground">
                  {value}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PaintField({
  label,
  value,
  system,
  mode,
  onChange,
  compact = false,
  onPreview,
}: {
  label: string;
  value: DesignPaint | undefined;
  system: DesignSystem | null;
  mode: string;
  onChange: (value: DesignPaint | null) => void;
  /** Swatch only, for the selection toolbar. */
  compact?: boolean;
  /** Live value while the color picker is dragged; `onChange` commits once when it closes. */
  onPreview?: (value: DesignPaint) => void;
}) {
  const colorInput = useRef<HTMLInputElement>(null);
  const commitColor = useRef(onChange);
  useEffect(() => {
    commitColor.current = onChange;
  }, [onChange]);
  useEffect(() => {
    const input = colorInput.current;
    if (input === null) return;
    // React's onChange is the input event (every drag step); the native change event fires once.
    const onNativeChange = () => commitColor.current(input.value);
    input.addEventListener("change", onNativeChange);
    return () => input.removeEventListener("change", onNativeChange);
  });
  const [open, setOpen] = useState(false);
  const hex = useFieldDraft(typeof value === "string" ? value : "");
  const resolved =
    value === undefined
      ? null
      : typeof value === "string"
        ? value
        : designTokenValue(system, value.token, mode);
  const text = value === undefined ? "None" : typeof value === "string" ? value : value.token;
  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`${label}: ${text}`}
              className={cn(
                "flex h-7 min-w-0 items-center gap-2 rounded-md text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                compact ? "px-1.5" : "flex-1 border border-input px-2",
              )}
            />
          }
        >
          <span
            className="grid size-4 shrink-0 place-items-center rounded-xs border border-border"
            style={resolved === null ? undefined : { background: resolved }}
          >
            {resolved === null && (
              <SlashIcon aria-hidden className="size-3 text-destructive-foreground" />
            )}
          </span>
          {!compact && <span className="min-w-0 flex-1 truncate">{text}</span>}
          {!compact && typeof value === "object" && (
            <BracesIcon aria-label="Token" className="size-3 text-muted-foreground" />
          )}
        </PopoverTrigger>
        <PopoverPopup side="left" align="start" className="w-72">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-xs">
              <span className="w-12 text-muted-foreground">Custom</span>
              <input
                type="color"
                aria-label={`${label} color`}
                className="h-7 w-9 cursor-pointer rounded border border-input bg-transparent p-0.5"
                ref={colorInput}
                value={toHex(resolved) ?? "#000000"}
                onChange={(event) => onPreview?.(event.currentTarget.value)}
              />
              <Input
                size="compact"
                font="mono"
                aria-label={`${label} value`}
                {...hex.inputProps}
                placeholder="#000000"
                onBlur={hex.end}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    const next = event.currentTarget.value.trim();
                    hex.end();
                    if (next !== "") onChange(next);
                    setOpen(false);
                  }
                }}
              />
            </label>
            <TokenList
              tokens={tokensOf(system, ["color"])}
              system={system}
              mode={mode}
              swatch
              onPick={(token) => {
                onChange({ token });
                setOpen(false);
              }}
            />
          </div>
        </PopoverPopup>
      </Popover>
      {value !== undefined && !compact && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

const LENGTH_TOKEN_TYPES: readonly DesignToken["type"][] = ["dimension", "number"];

function LengthField({
  label,
  value,
  system,
  mode,
  onChange,
  tokenTypes = LENGTH_TOKEN_TYPES,
}: {
  label: string;
  value: DesignLength | undefined;
  system: DesignSystem | null;
  mode: string;
  onChange: (value: DesignLength | null) => void;
  tokenTypes?: readonly DesignToken["type"][];
}) {
  const [open, setOpen] = useState(false);
  const tokens = tokensOf(system, tokenTypes);
  const field = useFieldDraft(typeof value === "number" ? String(value) : "");
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{label}</span>
      {typeof value === "object" ? (
        <span className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-input px-2 text-xs">
          <BracesIcon className="size-3 text-muted-foreground" />
          <span className="truncate">{value.token}</span>
        </span>
      ) : (
        <Input
          size="compact"
          font="mono"
          aria-label={label}
          {...field.inputProps}
          placeholder="0"
          onBlur={(event) => {
            const raw = event.currentTarget.value.trim();
            field.end();
            if (raw === "") {
              if (value !== undefined) onChange(null);
              return;
            }
            const parsed = Number(raw);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed !== value) onChange(parsed);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button variant="ghost" size="icon-xs" aria-label={`${label} token`} />}
        >
          <BracesIcon />
        </PopoverTrigger>
        <PopoverPopup side="left" align="start" className="w-72">
          <TokenList
            tokens={tokens}
            system={system}
            mode={mode}
            swatch={false}
            onPick={(token) => {
              onChange({ token });
              setOpen(false);
            }}
          />
        </PopoverPopup>
      </Popover>
      {typeof value === "object" && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Detach ${label.toLowerCase()} token`}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

function TextSection({
  node,
  system,
  mode,
  onPatch,
  onPreviewPatch,
}: {
  node: Extract<DesignNode, { type: "text" }>;
  system: DesignSystem | null;
  mode: string;
  onPatch: (fields: Record<string, unknown>) => void;
  onPreviewPatch: (fields: Record<string, unknown>) => void;
}) {
  const [familyOpen, setFamilyOpen] = useState(false);
  const family =
    node.fontFamily === undefined
      ? "System"
      : typeof node.fontFamily === "string"
        ? node.fontFamily
        : node.fontFamily.token;
  return (
    <Section title="Text">
      <PaintField
        label="Color"
        value={node.color}
        system={system}
        mode={mode}
        onChange={(value) => onPatch({ color: value })}
        onPreview={(value) => onPreviewPatch({ color: value })}
      />
      <div className="flex items-center gap-1.5">
        <span className="w-12 shrink-0 text-xs text-muted-foreground">Font</span>
        <Popover open={familyOpen} onOpenChange={setFamilyOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={`Font family: ${family}`}
                className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-input px-2 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              />
            }
          >
            {typeof node.fontFamily === "object" && (
              <BracesIcon className="size-3 text-muted-foreground" />
            )}
            <span className="truncate">{family}</span>
          </PopoverTrigger>
          <PopoverPopup side="left" align="start" className="w-72">
            <div className="flex flex-col gap-2">
              <Input
                size="compact"
                aria-label="Font family value"
                placeholder="Inter, system-ui"
                defaultValue={typeof node.fontFamily === "string" ? node.fontFamily : ""}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    const next = event.currentTarget.value.trim();
                    onPatch({ fontFamily: next === "" ? null : next });
                    setFamilyOpen(false);
                  }
                }}
              />
              <TokenList
                tokens={tokensOf(system, ["fontFamily"])}
                system={system}
                mode={mode}
                swatch={false}
                onPick={(token) => {
                  onPatch({ fontFamily: { token } });
                  setFamilyOpen(false);
                }}
              />
            </div>
          </PopoverPopup>
        </Popover>
      </div>
      <LengthField
        label="Size"
        value={node.fontSize ?? 16}
        system={system}
        mode={mode}
        tokenTypes={["dimension", "typography", "number"]}
        onChange={(value) => onPatch({ fontSize: value })}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <NumberInput
          label="Weight"
          min={100}
          max={900}
          value={node.fontWeight ?? 400}
          onChange={(value) => onPatch({ fontWeight: Math.round(value / 100) * 100 })}
        />
        <NumberInput
          label="Line"
          min={0.5}
          max={4}
          value={node.lineHeight ?? 1.4}
          onChange={(value) => onPatch({ lineHeight: value })}
        />
      </div>
      <NumberInput
        label="Spacing"
        min={-20}
        max={50}
        value={node.letterSpacing ?? 0}
        onChange={(value) => onPatch({ letterSpacing: value })}
      />
      <div className="flex items-center gap-1.5">
        <span className="w-12 shrink-0 text-xs text-muted-foreground">Align</span>
        <div className="flex gap-0.5" role="radiogroup" aria-label="Text align">
          {(["left", "center", "right"] as const).map((align) => (
            <Button
              key={align}
              variant={(node.align ?? "left") === align ? "secondary" : "ghost"}
              size="xs"
              role="radio"
              aria-checked={(node.align ?? "left") === align}
              onClick={() => onPatch({ align })}
            >
              {align[0]!.toUpperCase() + align.slice(1)}
            </Button>
          ))}
        </div>
      </div>
    </Section>
  );
}

function toHex(color: string | null): string | null {
  if (color === null) return null;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return null;
}
