/**
 * Whether a project shows its "changed code without an increment" notice.
 * Increments are recommended, never required. Dismissing the notice
 * acknowledges the threads it counts: it comes back only when a thread it has
 * not counted before changes code without an increment. The Threads sort menu
 * turns the notice off for good per project, which also drops the row chips and
 * stops opening the plan card for those threads. Acknowledging changes nothing
 * on the server: those threads keep their chip and their plan card.
 * Saved on this device, like the pane's sort order and folded groups.
 */
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import {
  getLocalStorageItem,
  LocalStorageOperationError,
  removeLocalStorageItem,
  useLocalStorage,
} from "../hooks/useLocalStorage";

export const UNPLANNED_NOTICE_STORAGE_KEY = "studio:unplanned-notice-hidden:v1";
export const UNPLANNED_ACKNOWLEDGED_STORAGE_KEY = "studio:unplanned-acknowledged:v1";
const HiddenSchema = Schema.Array(Schema.String);
const AcknowledgedSchema = Schema.Record(Schema.String, Schema.Array(Schema.String));
type Acknowledged = Readonly<Record<string, readonly string[]>>;
const NOTHING_HIDDEN: readonly string[] = [];
const NO_ACKNOWLEDGED: Acknowledged = {};
const isStorageError = Schema.is(LocalStorageOperationError);
/** Per project; the oldest acknowledgments go first past this. */
const ACKNOWLEDGED_LIMIT = 1000;

export function unplannedNoticeKey(
  environmentId: string | null | undefined,
  projectId: string | null | undefined,
): string | null {
  return environmentId && projectId ? `${environmentId}:${projectId}` : null;
}

export function withNoticeHidden(
  hidden: readonly string[],
  key: string,
  hide: boolean,
): readonly string[] {
  const rest = hidden.filter((entry) => entry !== key);
  return hide ? [...rest, key] : rest;
}

/**
 * Adds `threadIds` to the project's acknowledged threads as the newest, so a
 * thread acknowledged again is never the one the limit drops.
 */
export function withAcknowledged(
  acknowledged: Acknowledged,
  key: string,
  threadIds: Iterable<string>,
): Acknowledged {
  const incoming = new Set(threadIds);
  const older = (acknowledged[key] ?? []).filter((threadId) => !incoming.has(threadId));
  return { ...acknowledged, [key]: [...older, ...incoming].slice(-ACKNOWLEDGED_LIMIT) };
}

export function withoutAcknowledged(acknowledged: Acknowledged, key: string): Acknowledged {
  if (!(key in acknowledged)) return acknowledged;
  const { [key]: _dropped, ...rest } = acknowledged;
  return rest;
}

/** The threads the notice counts: unplanned and not yet acknowledged. */
export function unacknowledgedThreads(
  unplanned: ReadonlySet<string>,
  acknowledged: readonly string[],
): ReadonlySet<string> {
  if (acknowledged.length === 0) return unplanned;
  const seen = new Set(acknowledged);
  return new Set([...unplanned].filter((threadId) => !seen.has(threadId)));
}

/**
 * Drops a stored value this version cannot read, which would otherwise block
 * every later write to its key. Read failures are left to the hook.
 */
function discardUndecodable<T, E>(key: string, schema: Schema.Codec<T, E>): void {
  try {
    getLocalStorageItem(key, schema);
  } catch (error) {
    if (isStorageError(error) && error.operation === "decode") removeLocalStorageItem(key);
  }
}

export function discardUndecodableAcknowledged(): void {
  discardUndecodable(UNPLANNED_ACKNOWLEDGED_STORAGE_KEY, AcknowledgedSchema);
}

export function discardUndecodableHidden(): void {
  discardUndecodable(UNPLANNED_NOTICE_STORAGE_KEY, HiddenSchema);
}

/** `[shown, setShown]`; a thread outside a project always shows nothing to hide. */
export function useUnplannedNoticeShown(
  environmentId: string | null | undefined,
  projectId: string | null | undefined,
): readonly [boolean, (shown: boolean) => void] {
  const key = unplannedNoticeKey(environmentId, projectId);
  const [hidden, setHidden] = useLocalStorage<readonly string[], readonly string[]>(
    UNPLANNED_NOTICE_STORAGE_KEY,
    NOTHING_HIDDEN,
    HiddenSchema,
  );
  const setShown = useCallback(
    (shown: boolean) => {
      if (!key) return;
      discardUndecodableHidden();
      setHidden((current) => withNoticeHidden(current, key, !shown));
    },
    [key, setHidden],
  );
  return [key === null || !hidden.includes(key), setShown] as const;
}

export interface UnplannedNotice {
  /** The sort menu switch: off hides the notice and the row chips for good. */
  readonly shown: boolean;
  /** Turning the switch back on clears the project's acknowledgments. */
  readonly setShown: (shown: boolean) => void;
  /** What the notice counts and filters to; empty while the switch is off. */
  readonly fresh: ReadonlySet<string>;
  /** Acknowledges every thread in `unplanned` for this project. */
  readonly dismiss: () => void;
}

/** The Threads pane's notice for one project, over its unplanned thread ids. */
export function useUnplannedNotice(
  environmentId: string | null | undefined,
  projectId: string | null | undefined,
  unplanned: ReadonlySet<string>,
): UnplannedNotice {
  const key = unplannedNoticeKey(environmentId, projectId);
  const [shown, setNoticeShown] = useUnplannedNoticeShown(environmentId, projectId);
  const [acknowledged, setAcknowledged] = useLocalStorage<
    Acknowledged,
    { readonly [x: string]: readonly string[] }
  >(UNPLANNED_ACKNOWLEDGED_STORAGE_KEY, NO_ACKNOWLEDGED, AcknowledgedSchema);
  const projectAcknowledged = key ? acknowledged[key] : undefined;
  const fresh = useMemo(
    () => (shown ? unacknowledgedThreads(unplanned, projectAcknowledged ?? []) : new Set<string>()),
    [shown, unplanned, projectAcknowledged],
  );
  const dismiss = useCallback(() => {
    if (!key) return;
    discardUndecodableAcknowledged();
    setAcknowledged((current) => withAcknowledged(current, key, unplanned));
  }, [key, setAcknowledged, unplanned]);
  const setShown = useCallback(
    (next: boolean) => {
      setNoticeShown(next);
      if (!next || !key) return;
      discardUndecodableAcknowledged();
      setAcknowledged((current) => withoutAcknowledged(current, key));
    },
    [key, setAcknowledged, setNoticeShown],
  );
  return { shown, setShown, fresh, dismiss };
}
