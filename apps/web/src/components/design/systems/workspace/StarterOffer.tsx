/**
 * The starter offer in an empty token section: one press adds a neutral set
 * (spacing, radii, shadows); colors first ask for an accent and type for a
 * family. Everything lands in one edit, so Undo takes it all back.
 */
import type { DesignSystem } from "@specweave-studio/contracts";
import { CheckIcon, LayersIcon } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../../ui/popover";
import {
  DEFAULT_ACCENT,
  DEFAULT_FAMILY,
  STARTER_FAMILIES,
  STARTER_LABELS,
  starterTokens,
  type StarterKind,
  type StarterOptions,
} from "./starterSets";
import type { SystemEditIntent } from "./systemEditIntents";
import { formatColor, hexOf, parseColor } from "./tokenValues";

/** Six calm hues to start from; the field takes any other. */
export const ACCENT_CHOICES: ReadonlyArray<{ readonly name: string; readonly hex: string }> = [
  { name: "Blue", hex: "#2f6fed" },
  { name: "Violet", hex: "#7c4dde" },
  { name: "Teal", hex: "#0e7490" },
  { name: "Green", hex: "#15803d" },
  { name: "Orange", hex: "#c2410c" },
  { name: "Pink", hex: "#be185d" },
];

/** Whether the palette can be built from this accent (hex or rgb()). */
export const accentProblem = (accent: string) =>
  parseColor(accent) === null ? "Use a hex or rgb() color." : null;

/** Arrow keys move the choice within a radio group, as native radios do. */
export function moveRadio(event: KeyboardEvent<HTMLElement>) {
  const step =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  const radios = [...(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
  const at = radios.indexOf(event.currentTarget);
  const next = radios[(at + step + radios.length) % radios.length];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
  next.click();
}

const OFFER_TEXT: Record<StarterKind, string> = {
  colors: "Start with a palette",
  typography: "Start with a type scale",
  spacing: "Add a 4 px scale",
  radius: "Add starter radii",
  shadows: "Add two shadows",
};

export function starterIntent(
  kind: StarterKind,
  system: Pick<DesignSystem, "modes">,
  options: StarterOptions = {},
): SystemEditIntent {
  return {
    kind: "add-many",
    label: STARTER_LABELS[kind],
    tokens: starterTokens(kind, system.modes, options),
  };
}

export function StarterOffer({
  kind,
  system,
  onEdit,
}: {
  kind: StarterKind;
  system: Pick<DesignSystem, "modes">;
  onEdit: (intent: SystemEditIntent) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [family, setFamily] = useState(DEFAULT_FAMILY);
  const trigger = (
    <Button variant="outline" size="xs" data-testid="starter-offer" data-starter={kind} />
  );
  const label = (
    <>
      <LayersIcon aria-hidden />
      {OFFER_TEXT[kind]}
    </>
  );
  if (kind !== "colors" && kind !== "typography")
    return (
      <Button
        variant="outline"
        size="xs"
        data-testid="starter-offer"
        data-starter={kind}
        onClick={() => void onEdit(starterIntent(kind, system))}
      >
        {label}
      </Button>
    );
  const add = () => {
    setOpen(false);
    void onEdit(starterIntent(kind, system, kind === "colors" ? { accent } : { family }));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger}>{label}</PopoverTrigger>
      <PopoverPopup width="sm" align="start" padding="compact">
        <div className="flex flex-col gap-3 py-1" data-testid="starter-popup">
          <PopoverTitle>{OFFER_TEXT[kind]}</PopoverTitle>
          {kind === "colors" ? (
            <AccentPicker value={accent} onChange={setAccent} />
          ) : (
            <FamilyPicker value={family} onChange={setFamily} />
          )}
          <p className="text-muted-foreground text-xs">
            {kind === "colors"
              ? "Neutrals lean toward the accent. Light and dark values; change any of them after."
              : "Display, headings, body, small, caption and code, plus sans and mono families."}
          </p>
          <div className="flex justify-end">
            <Button
              size="xs"
              data-testid="starter-add"
              disabled={kind === "colors" && accentProblem(accent) !== null}
              onClick={add}
            >
              {kind === "colors" ? "Add palette" : "Add type scale"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function AccentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (accent: string) => void;
}) {
  const id = useId();
  const parsed = parseColor(value);
  const problem = accentProblem(value);
  const chosenAt = ACCENT_CHOICES.findIndex(
    (choice) => parsed !== null && hexOf(parsed) === hexOf(parseColor(choice.hex)!),
  );
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-accent`} className="text-muted-foreground text-xs">
        Accent
      </label>
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Accent">
          {ACCENT_CHOICES.map((choice, index) => {
            const chosen = index === chosenAt;
            return (
              <button
                key={choice.hex}
                type="button"
                role="radio"
                aria-checked={chosen}
                aria-label={choice.name}
                tabIndex={chosen || (chosenAt < 0 && index === 0) ? 0 : -1}
                className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none ring-1 ring-black/10 ring-inset focus-visible:ring-2 focus-visible:ring-ring dark:ring-white/15"
                style={{ backgroundColor: choice.hex }}
                onClick={() => onChange(choice.hex)}
                onKeyDown={moveRadio}
              >
                {chosen ? <CheckIcon aria-hidden className="size-3.5 text-white" /> : null}
              </button>
            );
          })}
        </div>
        <input
          type="color"
          aria-label="Pick any accent"
          value={parsed === null ? DEFAULT_ACCENT : hexOf(parsed).toLowerCase()}
          className="h-6 w-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
          onChange={(event) => {
            const picked = parseColor(event.target.value);
            if (picked !== null) onChange(formatColor(picked));
          }}
        />
      </div>
      <Input
        id={`${id}-accent`}
        size="sm"
        font="mono"
        spellCheck={false}
        aria-invalid={problem !== null}
        aria-describedby={problem === null ? undefined : `${id}-problem`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== null ? (
        <span id={`${id}-problem`} className="text-destructive-foreground text-xs">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

export function FamilyPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (family: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1" role="radiogroup" aria-label="Font family">
      {STARTER_FAMILIES.map((choice, index) => {
        const chosen = choice.stack === value;
        const none = !STARTER_FAMILIES.some((other) => other.stack === value);
        return (
          <button
            key={choice.label}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen || (none && index === 0) ? 0 : -1}
            onKeyDown={moveRadio}
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 text-left outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring",
              chosen ? "border-ring bg-accent/50" : "border-border/70 hover:bg-accent/40",
            )}
            onClick={() => onChange(choice.stack)}
          >
            <span className="text-lg leading-tight" style={{ fontFamily: choice.stack }}>
              {choice.label}
            </span>
            <span className="text-muted-foreground text-xs" style={{ fontFamily: choice.stack }}>
              Aa Bb 123
            </span>
          </button>
        );
      })}
    </div>
  );
}
