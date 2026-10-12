import type { ThreadId } from "@specweave-studio/contracts";
import { useSearch } from "@tanstack/react-router";

import { parseProjectWorkspaceSearch } from "./projectPaneThreads";

/** The thread a project page shows in its right panel, as `?thread=` names it. */
export function useProjectPaneThreadParam(): ThreadId | null {
  return useSearch({
    strict: false,
    select: (search) =>
      parseProjectWorkspaceSearch(search as Record<string, unknown>).thread ?? null,
  });
}
