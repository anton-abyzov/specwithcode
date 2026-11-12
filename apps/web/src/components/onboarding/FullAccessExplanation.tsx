import { CheckIcon, PauseIcon } from "lucide-react";

import { useT, type MessageKey } from "../../i18n";
import { cn } from "../../lib/utils";

/** What Full access lets an agent do without asking, in the order the list shows it. */
export const FULL_ACCESS_ALLOWS = [
  "wizard.access.allowCommands",
  "wizard.access.allowFiles",
  "wizard.access.allowNetwork",
] as const satisfies readonly MessageKey[];

/**
 * The one plain-language account of Full access: what it allows and what still
 * stops. The first-run Access step and the composer's callout both draw it, so
 * the two can never say different things.
 */
export function FullAccessExplanation({ className }: { readonly className?: string }) {
  const t = useT();
  return (
    <ul data-slot="full-access-explanation" className={cn("grid gap-1.5 text-sm", className)}>
      {FULL_ACCESS_ALLOWS.map((key) => (
        <li key={key} className="flex items-start gap-2 text-foreground">
          <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success-foreground" />
          <span>{t(key)}</span>
        </li>
      ))}
      <li className="flex items-start gap-2 text-muted-foreground">
        <PauseIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{t("wizard.access.stillStops")}</span>
      </li>
    </ul>
  );
}
