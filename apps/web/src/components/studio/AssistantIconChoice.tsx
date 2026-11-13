import type { ProjectIconColor, ProjectIconOverride } from "@specweave-studio/contracts";
import {
  assistantIconChoices,
  assistantIconGlyph,
  type AssistantIcon,
} from "@specweave-studio/shared/assistantIcon";
import { projectIconNameForDisplay } from "@specweave-studio/shared/projectIconLegacy";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { Suspense } from "react";

import { cn } from "~/lib/utils";
import { useTx } from "../../i18n";
import { PROJECT_ICON_COLORS, projectIconColorClassName } from "../../projectIconColors";

export type AssistantLucideIcon = Extract<ProjectIconOverride, { kind: "lucide" }>;

const asOverride = (icon: AssistantIcon): AssistantLucideIcon => ({
  kind: "lucide",
  name: icon.name,
  color: icon.color as ProjectIconColor,
});

function label(name: string): string {
  const words = name.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The icon setup starts on: one no assistant already listed uses. */
export function suggestedAssistantIcon(
  taken: ReadonlyArray<ProjectIconOverride | null | undefined>,
  seed: string,
): AssistantLucideIcon {
  return asOverride(assistantIconChoices({ taken, seed })[0]!);
}

export function AssistantIconGlyph(props: {
  readonly icon: AssistantLucideIcon;
  readonly className?: string;
}) {
  const colorClassName = projectIconColorClassName(props.icon.color);
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0", colorClassName, props.className)}
    >
      <Suspense fallback={null}>
        <DynamicIcon
          name={projectIconNameForDisplay(props.icon.name) as IconName}
          className={cn("size-full", colorClassName)}
        />
      </Suspense>
    </span>
  );
}

/**
 * Icon and colour for a new assistant. It starts on an icon no other assistant
 * uses, and says which assistant already uses one. Nothing is saved here; the
 * choice is applied when the assistant is created.
 */
export function AssistantIconChoice(props: {
  readonly value: AssistantLucideIcon;
  readonly onChange: (icon: AssistantLucideIcon) => void;
  /** Icons of the assistants already listed, with the name each is shown under. */
  readonly others: ReadonlyArray<{
    readonly icon: ProjectIconOverride | null | undefined;
    readonly label: string;
  }>;
  readonly seed: string;
}) {
  const tx = useTx();
  const taken = props.others.map((other) => other.icon);
  const choices = assistantIconChoices({ taken, seed: props.seed });
  const usedBy = (icon: AssistantIcon) =>
    props.others.find((other) => assistantIconGlyph(other.icon) === assistantIconGlyph(icon))
      ?.label;
  const cell =
    "flex size-7 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-accent aria-checked:ring-1 aria-checked:ring-ring";
  return (
    <section className="space-y-1.5 px-4 pb-1 pt-2" data-assistant-icon-choice>
      <p className="text-xs text-muted-foreground">
        {props.others.length > 0
          ? tx("Icon and colour. Suggested so it differs from your other assistants.")
          : tx("Icon and colour")}
      </p>
      <div role="radiogroup" aria-label={tx("Icon")} className="flex flex-wrap gap-1">
        {choices.map((choice) => {
          const owner = usedBy(choice);
          const name = tx(label(choice.name));
          return (
            <button
              key={choice.name}
              type="button"
              role="radio"
              aria-checked={props.value.name === choice.name}
              aria-label={owner ? tx("{icon}, used by {name}", { icon: name, name: owner }) : name}
              title={owner ? tx("Used by {name}", { name: owner }) : name}
              data-taken={choice.taken ? "" : undefined}
              className={cn(cell, choice.taken && "opacity-45")}
              onClick={() =>
                props.onChange({
                  kind: "lucide",
                  name: choice.name,
                  // Picking a glyph keeps the colour already chosen, unless it is still the suggested pair.
                  color: choices.some(
                    (other) => other.name === props.value.name && other.color === props.value.color,
                  )
                    ? (choice.color as ProjectIconColor)
                    : props.value.color,
                })
              }
            >
              <AssistantIconGlyph
                icon={{
                  ...asOverride(choice),
                  color:
                    props.value.name === choice.name
                      ? props.value.color
                      : (choice.color as ProjectIconColor),
                }}
              />
            </button>
          );
        })}
      </div>
      <div role="radiogroup" aria-label={tx("Colour")} className="flex flex-wrap gap-1">
        {PROJECT_ICON_COLORS.map((color) => (
          <button
            key={color.value}
            type="button"
            role="radio"
            aria-checked={props.value.color === color.value}
            aria-label={tx(color.label)}
            title={tx(color.label)}
            className="flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:ring-2 aria-checked:ring-ring aria-checked:ring-offset-1 aria-checked:ring-offset-background"
            onClick={() => props.onChange({ ...props.value, color: color.value })}
          >
            <span className={cn("size-3.5 rounded-full", color.swatchClassName)} />
          </button>
        ))}
      </div>
    </section>
  );
}
