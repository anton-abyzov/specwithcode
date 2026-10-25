import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";

import { parseProjectWorkspaceSearch } from "./projectPaneThreads";
import type { ProjectPaneTab } from "./projectPaneModel";

/**
 * `?pane=<tab>` on a project page opens the right panel on that tab once, then
 * leaves the URL. The tab the person picks is remembered in local storage as
 * before; tab clicks never write to the URL.
 */
export function useProjectPaneDeepLink(open: (tab: ProjectPaneTab) => void) {
  const pane = useSearch({
    strict: false,
    select: (search) => parseProjectWorkspaceSearch(search as Record<string, unknown>).pane ?? null,
  });
  const navigate = useNavigate();
  useEffect(() => {
    if (pane === null) return;
    open(pane);
    void navigate({
      to: ".",
      search: ({ pane: _pane, ...rest }: Record<string, unknown>) => rest,
      replace: true,
    });
  }, [navigate, open, pane]);
}
