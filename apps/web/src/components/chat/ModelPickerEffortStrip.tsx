import { ZapIcon } from "lucide-react";
import { memo } from "react";
import { cn } from "~/lib/utils";
import { EffortGlyph, effortLevelDescription, effortLevelLabel } from "./EffortGlyph";

/**
 * The effort of the picked model, chosen in the model picker itself. Hosts build it from
 * the model's option descriptors (`useTraitsEffortControl`), so the picker never parses
 * provider options of its own.
 */
export interface ModelPickerEffort {
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly value: string | null;
  /** Why the effort can't change here, as when the prompt asks for ultrathink. */
  readonly locked: string | null;
  readonly select: (id: string) => void;
  /** The model's Fast mode, when it has one. */
  readonly fast: { readonly on: boolean; readonly toggle: () => void } | null;
}

/** The effort next to `value` in the strip's order, or null at an end. */
export function adjacentEffort(effort: ModelPickerEffort, direction: 1 | -1): string | null {
  if (effort.locked || effort.options.length === 0) return null;
  const index = effort.options.findIndex((option) => option.id === effort.value);
  const next = index < 0 ? (direction === 1 ? 0 : effort.options.length - 1) : index + direction;
  return effort.options[next]?.id ?? null;
}

/** The effort word a row or trigger shows, from a level id and its provider label. */
export function effortWord(option: { readonly id: string; readonly label: string }): string {
  return effortLevelLabel(option.id, option.label);
}

const isStrong = (id: string) => /^(max|ultracode|ultrathink)$/i.test(id.replace(/[^a-z]/gi, ""));

/**
 * A segmented row of effort words with the Fast toggle, at the foot of the picker.
 * Left and Right in the search box move along it.
 */
export const ModelPickerEffortStrip = memo(function ModelPickerEffortStrip(props: {
  readonly effort: ModelPickerEffort;
  /** The model the effort belongs to, for the accessible name. */
  readonly modelLabel: string;
}) {
  const { effort } = props;
  if (effort.options.length === 0 && !effort.fast) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-border/70 px-2 py-1.5"
      data-model-picker-effort=""
    >
      {effort.options.length > 0 ? (
        <>
          <span className="shrink-0 text-2xs font-medium text-muted-foreground">Effort</span>
          <div
            role="radiogroup"
            aria-label={`Effort for ${props.modelLabel}`}
            className="sws-picker-segments flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-full p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {effort.options.map((option) => {
              const checked = option.id === effort.value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={effort.locked !== null && !checked}
                  aria-description={effortLevelDescription(option.id) ?? undefined}
                  data-effort-option={option.id}
                  // The search keeps focus; a click here never takes it.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => effort.select(option.id)}
                  className={cn(
                    "sws-picker-segment inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-xs whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50",
                    isStrong(option.id) && "text-primary",
                  )}
                >
                  {checked ? <EffortGlyph value={option.id} className="size-3.5" /> : null}
                  {effortWord(option)}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <span className="flex-1" />
      )}
      {effort.locked ? (
        <span className="sr-only" role="note">
          {effort.locked}
        </span>
      ) : null}
      {effort.fast ? (
        <button
          type="button"
          role="switch"
          aria-checked={effort.fast.on}
          data-model-picker-fast=""
          onMouseDown={(event) => event.preventDefault()}
          onClick={effort.fast.toggle}
          className="sws-picker-segment inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-xs"
        >
          <ZapIcon className={cn("size-3.5", effort.fast.on && "fill-current")} aria-hidden />
          Fast
        </button>
      ) : null}
    </div>
  );
});
