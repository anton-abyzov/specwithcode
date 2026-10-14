import { createContext } from "react";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ScopedThreadRef } from "@specweave-studio/contracts";

/** A history selection can exist outside the live shell index. Scoped to its panel. */
export const SelectedThreadShell = createContext<EnvironmentThreadShell | null>(null);

export function resolveSelectedThreadShell(
  ref: ScopedThreadRef | null,
  live: EnvironmentThreadShell | null,
  selected: EnvironmentThreadShell | null,
): EnvironmentThreadShell | null {
  if (live) return live;
  if (!ref || !selected || selected.deletedAt !== null ||
      ref.environmentId !== selected.environmentId || ref.threadId !== selected.id) return null;
  return selected;
}
