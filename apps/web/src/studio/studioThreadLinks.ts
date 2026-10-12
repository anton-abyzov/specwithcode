/**
 * `studio://thread/<id>` is how a coordinator links the threads it works with.
 * The project page renders this project's workers as chips that open in its
 * right pane; everywhere else chat markdown resolves the link here.
 */
import type { ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { parseStudioThreadHref } from "@specweave-studio/shared/studioThreadLinks";

export {
  STUDIO_THREAD_HREF_PREFIX,
  formatStudioThreadHref,
  formatStudioThreadLink,
  parseStudioThreadHref,
  parseStudioThreadTarget,
  studioThreadLinkLabel,
} from "@specweave-studio/shared/studioThreadLinks";

/**
 * Servers name themselves with a UUID. A first segment that is not one is a
 * title with a slash in it (`studio://thread/CI/CD`), not another machine.
 */
export function looksLikeEnvironmentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

type LinkShell = Pick<EnvironmentThreadShell, "id" | "title"> &
  Partial<Pick<EnvironmentThreadShell, "environmentId" | "deletedAt">>;

export type StudioThreadLinkResolution<Shell extends LinkShell = LinkShell> =
  | { readonly kind: "thread"; readonly id: ThreadId; readonly shell: Shell }
  /** The link names, by its exact ID, a live thread that is not one of `threads`. */
  | { readonly kind: "elsewhere" }
  | { readonly kind: "deleted" }
  | { readonly kind: "missing" };

/**
 * The thread a link names: the ID decoded once, then the ID as written, then a
 * title only one thread has (the link's target, then its label), since agents
 * sometimes put a title where the ID belongs. Only threads in `environmentId`
 * count when it is given. `known` is every thread the link could name (all of
 * the environment's, live or deleted) when `threads` is a subset such as one
 * project's workers. A link whose ID names any known thread never falls back to
 * a title: a link to another project's thread stays with that thread, and one
 * to a deleted thread says so instead of opening a live thread of the same title.
 */
export function resolveStudioThreadLink<Shell extends LinkShell>(
  threads: readonly Shell[],
  candidates: readonly string[],
  label: string,
  environmentId?: string | null,
  known: readonly LinkShell[] = [],
): StudioThreadLinkResolution<Shell> {
  const scoped = <Row extends LinkShell>(rows: readonly Row[]): readonly Row[] =>
    environmentId === undefined || environmentId === null
      ? rows
      : rows.filter((thread) => thread.environmentId === environmentId);
  const here = scoped(threads);
  const live = here.filter((thread) => !thread.deletedAt);
  for (const candidate of candidates) {
    const byId = live.find((thread) => thread.id === candidate);
    if (byId) return { kind: "thread", id: byId.id, shell: byId };
  }
  const named = [...here, ...scoped(known)].filter((thread) => candidates.includes(thread.id));
  if (named.some((thread) => !thread.deletedAt)) return { kind: "elsewhere" };
  if (named.length > 0) return { kind: "deleted" };
  return uniqueThreadTitle(live, [...candidates, label.trim()]) ?? { kind: "missing" };
}

/** Resolves a whole `studio://thread/` href; `missing` when it is not a thread link. */
export function resolveStudioThreadHref<Shell extends LinkShell>(
  threads: readonly Shell[],
  href: string,
  label: string,
  environmentId?: string | null,
  known?: readonly LinkShell[],
): StudioThreadLinkResolution<Shell> {
  const candidates = parseStudioThreadHref(href);
  return candidates === null
    ? { kind: "missing" }
    : resolveStudioThreadLink(threads, candidates, label, environmentId, known);
}

/**
 * Agents sometimes put a thread's title where its ID belongs: the first of the
 * titles that exactly one thread has.
 */
export function uniqueThreadTitle<Shell extends Pick<EnvironmentThreadShell, "id" | "title">>(
  threads: readonly Shell[],
  titles: readonly string[],
): { readonly kind: "thread"; readonly id: ThreadId; readonly shell: Shell } | null {
  for (const title of titles) {
    const wanted = title.trim();
    if (!wanted) continue;
    const matches = threads.filter((thread) => thread.title.trim() === wanted);
    if (matches.length === 1) return { kind: "thread", id: matches[0]!.id, shell: matches[0]! };
  }
  return null;
}
