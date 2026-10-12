import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import {
  type ProjectMessageRouting,
  type ProjectThreadOpenOptions,
  useProjectMessageRouting,
} from "../studio/projectMessageRouting";

/** True when the surrounding project took the thread into its right panel. */
export function openThreadInProject(
  routing: Pick<ProjectMessageRouting, "openThread"> | null,
  ref: ScopedThreadRef,
  options?: ProjectThreadOpenOptions,
): boolean {
  if (routing === null) return false;
  return options === undefined
    ? routing.openThread(ref.threadId, ref.environmentId)
    : routing.openThread(ref.threadId, ref.environmentId, options);
}

export interface OpenThreadOptions {
  readonly replace?: boolean;
}

/**
 * The one way to open a thread from inside a chat. Inside a project's panel the
 * project shows it in the same panel; anywhere else, or for another project's
 * thread, it opens full page.
 *
 * The callbacks keep one identity for the life of the component: the timeline
 * memoizes on them, and the project's routing value changes on every render of
 * the project page.
 */
export function useOpenThread() {
  const routing = useProjectMessageRouting();
  const navigate = useNavigate();
  // A mirror of the current project, so the stable callbacks still read it.
  const routingRef = useRef(routing);
  useLayoutEffect(() => {
    routingRef.current = routing;
  });
  const openInProject = useCallback(
    (ref: ScopedThreadRef, options?: ProjectThreadOpenOptions) =>
      openThreadInProject(routingRef.current, ref, options),
    [],
  );
  const openThread = useCallback(
    async (ref: ScopedThreadRef, options?: OpenThreadOptions): Promise<void> => {
      if (openThreadInProject(routingRef.current, ref)) return;
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
        ...(options?.replace ? { replace: true } : {}),
      });
    },
    [navigate],
  );
  return { openThread, openInProject };
}
