/**
 * A design that moved from the Playground into a project answers its old
 * address with `not_found` and `movedTo`. The editor route reads that answer
 * and replaces the old link with the new one; the design id never changes, so
 * `pg.<id>` becomes `p.<projectId>.<id>`.
 */
import { DesignError } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { encodeDesignKey } from "./designKey";

const isDesignError = Schema.is(DesignError);

/** The `/design/$designKey` key of the first failure that says where the design moved, or null. */
export function movedDesignKey(...failures: readonly unknown[]): string | null {
  for (const failure of failures) {
    if (isDesignError(failure) && failure.movedTo !== undefined)
      return encodeDesignKey(failure.movedTo.owner, failure.movedTo.designId);
  }
  return null;
}

/** Replaces the current history entry with the moved design, so Back skips the old link. */
export function useMovedDesignRedirect(movedKey: string | null): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (movedKey === null) return;
    void navigate({ to: "/design/$designKey", params: { designKey: movedKey }, replace: true });
  }, [movedKey, navigate]);
}
