import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { parseProjectWorkspaceSearch } from "./projectPaneThreads";

/** Where the Board tab stands, so a link naming an increment can bring it up. */
export interface BoardIncrementPane {
  /** The project has a board (SpecWeave is set up and it is not a personal project). */
  readonly available: boolean;
  /** The panel is open on the Board tab. */
  readonly shown: boolean;
  /** Opens the panel on the Board tab. */
  readonly show: () => void;
}

/**
 * The increment whose view is open on the project's Board tab, kept as
 * `?increment=<folder>` on the project page. Opening a card adds a history
 * entry, so app back and the phone's back gesture close the view; walking
 * from card to card and closing replace it. Opening a thread drops it, and
 * back returns to the view.
 *
 * A link that names an increment opens the panel on the Board tab, once per
 * increment: someone who then moves to another tab is left there.
 */
export function useBoardIncrementRoute(pane: BoardIncrementPane): {
  readonly incrementId: string | null;
  readonly open: (incrementId: string | null, options?: { readonly replace?: boolean }) => void;
} {
  const incrementId = useSearch({
    strict: false,
    select: (search) =>
      parseProjectWorkspaceSearch(search as Record<string, unknown>).increment ?? null,
  });
  const navigate = useNavigate();
  const open = useCallback(
    (next: string | null, options?: { readonly replace?: boolean }) =>
      void navigate({
        to: ".",
        search: ({ increment: _increment, ...rest }: Record<string, unknown>) =>
          next === null ? rest : { ...rest, increment: next },
        ...(options?.replace ? { replace: true } : {}),
      }),
    [navigate],
  );
  const { available, shown, show } = pane;
  const brought = useRef<string | null>(null);
  useEffect(() => {
    if (incrementId === null) {
      brought.current = null;
      return;
    }
    // Until the project has said whether it has a board, wait.
    if (brought.current === incrementId || !available) return;
    brought.current = incrementId;
    if (!shown) show();
  }, [available, incrementId, show, shown]);
  return { incrementId, open };
}
