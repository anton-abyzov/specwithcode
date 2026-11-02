import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { TeamRulesLock } from "../../teamRules/teamRulesView";
import { TeamRulesLabel } from "./settingsLayout";

/** Shows a control the rules turn off without letting anyone use it. Adds nothing when free. */
export function TeamRulesInert({
  lock,
  className,
  children,
}: {
  readonly lock: TeamRulesLock | null;
  /** Layout for when several children sit in the locked wrapper. */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return lock === null ? (
    <>{children}</>
  ) : (
    <div
      inert
      aria-disabled
      data-team-rules-locked
      className={cn("opacity-50 select-none", className)}
    >
      {children}
    </div>
  );
}

/** Who locked this and why, for a place that is not a settings row. */
export function TeamRulesLockNote({ lock }: { readonly lock: TeamRulesLock }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <TeamRulesLabel>{lock.setBy}</TeamRulesLabel>
      <span>{lock.message}</span>
    </p>
  );
}
