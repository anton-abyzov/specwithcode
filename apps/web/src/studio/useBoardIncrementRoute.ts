import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { parseProjectWorkspaceSearch } from "./projectPaneThreads";

/**
 * The increment whose view is open on the project's Board tab, kept as
 * `?increment=<folder>` on the project page. Opening a card adds a history
 * entry, so app back and the phone's back gesture close the view; walking
 * from card to card and closing replace it. Opening a thread drops it, and
 * back returns to the view.
 */
export function useBoardIncrementRoute(): {
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
  return { incrementId, open };
}
