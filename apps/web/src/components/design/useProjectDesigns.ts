/**
 * The designs one project owns (`<checkout>/.specweave/design/`), newest
 * first. The project page's header button, its Designs tab, the Library and
 * the Threads pane all read this one list: the query input is the same as the
 * Library's, so they share one cached request.
 *
 * `design.watch` follows a single design, not an owner's list, so the list
 * refreshes on mount, after the caller changes something, and when the window
 * regains focus (at most once every 10 s). It never polls, and a list with
 * problems is not retried in a loop.
 */
import type {
  DesignListResult,
  DesignSummary,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { design } from "../../studio/design";

const FOCUS_REFRESH_MS = 10_000;
const NO_DESIGNS: readonly DesignSummary[] = [];
const NO_PROBLEMS: DesignListResult["problems"] = [];

export interface ProjectDesigns {
  /** Newest edit first. */
  readonly designs: readonly DesignSummary[];
  /** Owners the server could not read, such as a checkout missing on a linked machine. */
  readonly problems: DesignListResult["problems"];
  readonly count: number;
  /** The design each agent thread is bound to, by thread id. */
  readonly byThreadId: ReadonlyMap<string, DesignSummary>;
  readonly refresh: () => void;
  /** True once the first answer (or failure) arrived. */
  readonly loaded: boolean;
  readonly error: string | null;
}

/** Sorts and indexes one list answer; pure, so the tests and the hook share it. */
export function projectDesignsView(result: DesignListResult | null): {
  designs: readonly DesignSummary[];
  byThreadId: ReadonlyMap<string, DesignSummary>;
} {
  if (result === null) return { designs: NO_DESIGNS, byThreadId: new Map() };
  const designs = result.designs.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byThreadId = new Map<string, DesignSummary>();
  // Newest first, so a thread bound to two designs points at the one edited last.
  for (const summary of designs) {
    const threadId = summary.thread?.threadId;
    if (threadId !== undefined && !byThreadId.has(threadId)) byThreadId.set(threadId, summary);
  }
  return { designs, byThreadId };
}

/**
 * `enabled` must be a derived boolean (project known and its machine
 * connected), never a whole presentation object: reading one of those inside
 * the gate re-creates the request on every presentation change and aborts it.
 */
export function useProjectDesigns(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  enabled: boolean,
): ProjectDesigns {
  const active = enabled && environmentId !== null && projectId !== null;
  const query = useEnvironmentQuery(
    active
      ? design.list({ environmentId, input: { filter: { kind: "project", projectId } } })
      : null,
  );
  const { refresh } = query;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!active) return;
    lastRefresh.current = Date.now();
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRefresh.current < FOCUS_REFRESH_MS) return;
      lastRefresh.current = now;
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refresh]);
  const data = query.data ?? null;
  const view = useMemo(() => projectDesignsView(data), [data]);
  return {
    designs: view.designs,
    problems: data?.problems ?? NO_PROBLEMS,
    count: view.designs.length,
    byThreadId: view.byThreadId,
    refresh,
    loaded: active && (data !== null || query.error !== null || query.failure !== null),
    error: query.error,
  };
}
