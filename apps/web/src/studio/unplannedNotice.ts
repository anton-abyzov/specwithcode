/**
 * Whether a project shows its "changed code without an increment" notice.
 * Increments are recommended, never required, so the notice can be hidden for
 * good per project; the Threads sort menu turns it back on. Hiding it also
 * drops the row chips and stops opening the plan card for those threads.
 * Saved on this device, like the pane's sort order and folded groups.
 */
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";

export const UNPLANNED_NOTICE_STORAGE_KEY = "studio:unplanned-notice-hidden:v1";
const HiddenSchema = Schema.Array(Schema.String);

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

/** `[shown, setShown]`; a thread outside a project always shows nothing to hide. */
export function useUnplannedNoticeShown(
  environmentId: string | null | undefined,
  projectId: string | null | undefined,
): readonly [boolean, (shown: boolean) => void] {
  const key = unplannedNoticeKey(environmentId, projectId);
  const [hidden, setHidden] = useLocalStorage<readonly string[], readonly string[]>(
    UNPLANNED_NOTICE_STORAGE_KEY,
    [],
    HiddenSchema,
  );
  const setShown = useCallback(
    (shown: boolean) => {
      if (key) setHidden((current) => withNoticeHidden(current, key, !shown));
    },
    [key, setHidden],
  );
  return [key === null || !hidden.includes(key), setShown] as const;
}
