import type { ScopedThreadRef } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const ShelfState = Schema.Struct({
  pinned: Schema.Array(Schema.String),
  hidden: Schema.Array(Schema.String),
});
type ShelfState = typeof ShelfState.Type;

const EMPTY: ShelfState = { pinned: [], hidden: [] };
/** Enough for any thread; the oldest choice drops first past it. */
const LIMIT = 500;

export function artifactShelfStorageKey(threadRef: ScopedThreadRef | null): string {
  return threadRef === null
    ? "studio:artifact-shelf:v1:none"
    : `studio:artifact-shelf:v1:${threadRef.environmentId}:${threadRef.threadId}`;
}

function toggled(list: ReadonlyArray<string>, id: string, on: boolean): string[] {
  const rest = list.filter((entry) => entry !== id);
  return on ? [...rest, id].slice(-LIMIT) : rest;
}

/**
 * What the user pinned and hid in one thread's artifacts list, on this
 * device. Hiding takes an entry off the list and nothing else: the file stays
 * where it is.
 */
export function useArtifactShelfState(threadRef: ScopedThreadRef | null) {
  const [state, setState] = useLocalStorage(artifactShelfStorageKey(threadRef), EMPTY, ShelfState);
  const pinned = useMemo(() => new Set(state.pinned), [state.pinned]);
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden]);
  const setPinned = useCallback(
    (id: string, on: boolean) =>
      setState((current) => ({
        pinned: toggled(current.pinned, id, on),
        // A pinned entry is one the user wants to see.
        hidden: on ? toggled(current.hidden, id, false) : current.hidden,
      })),
    [setState],
  );
  const setHidden = useCallback(
    (id: string, on: boolean) =>
      setState((current) => ({
        pinned: on ? toggled(current.pinned, id, false) : current.pinned,
        hidden: toggled(current.hidden, id, on),
      })),
    [setState],
  );
  return { pinned, hidden, setPinned, setHidden };
}
