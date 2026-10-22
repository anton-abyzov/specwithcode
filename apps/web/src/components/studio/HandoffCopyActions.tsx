import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The dialog owns placement; the copy flow keeps its current handlers and state. */
export const HandoffCopyActionsTarget = createContext<HTMLElement | null | undefined>(undefined);

export function HandoffCopyActions({ children }: { readonly children: ReactNode }) {
  const target = useContext(HandoffCopyActionsTarget);
  const actions = (
    <div
      data-slot="copy-actions"
      className="flex min-w-0 flex-1 flex-wrap justify-end gap-2 [&>button]:h-auto [&>button]:min-h-9 [&>button]:min-w-0 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:wrap-anywhere [&>button]:py-2 sm:[&>button]:min-h-8"
    >
      {children}
    </div>
  );
  // Standalone consumers keep their actions. Inside a dialog, wait for its outlet
  // instead of briefly putting buttons back inside the scrolling panel.
  return target === undefined ? actions : target ? createPortal(actions, target) : null;
}
