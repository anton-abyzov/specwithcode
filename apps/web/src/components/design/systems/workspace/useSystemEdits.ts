/**
 * Saving edits on the design system page. Each intent becomes operations that
 * `designSystem.apply` checks against the revision the page shows; edits run
 * one at a time so a quick second edit uses the first one's new revision. A
 * revision conflict stops further edits until the page reloads, so nothing
 * overwrites a change made elsewhere. Every saved edit offers Undo.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  DesignOwnerInput,
  DesignSystem,
  DesignSystemId,
  DesignSystemOperation,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { toastManager } from "../../../ui/toast";
import { failureText } from "../reviewModel";
import {
  intentLabel,
  inverseOperations,
  operationsFor,
  type SystemEditIntent,
} from "./systemEditIntents";

export const CONFLICT_TEXT = "This design system changed elsewhere.";

export type ApplyOutcome =
  | { readonly ok: true; readonly system: DesignSystem }
  | {
      readonly ok: false;
      readonly conflict: boolean;
      /** On a revision conflict, the revision the server is at. */
      readonly currentRevision?: number;
      readonly message: string;
    };

export type EditNotice =
  | { readonly kind: "saved"; readonly title: string; readonly undo: (() => void) | null }
  | { readonly kind: "failed"; readonly title: string; readonly description: string };

export interface EditRunnerDeps {
  readonly apply: (
    expectedRevision: number,
    operations: readonly DesignSystemOperation[],
  ) => Promise<ApplyOutcome>;
  /** The system as the page shows it now, including edits saved a moment ago. */
  readonly current: () => DesignSystem;
  readonly onSaved: (system: DesignSystem) => void;
  /** `revision` is the one the page must reach before edits run again. */
  readonly onConflict: (revision: number) => void;
  readonly notify: (notice: EditNotice) => void;
}

export interface EditRunner {
  /** Resolves true once saved, false when nothing changed hands. */
  readonly edit: (intent: SystemEditIntent) => Promise<boolean>;
  /** After a reload, edits may run again. */
  readonly reset: () => void;
}

/** The queue behind the hook; plain functions so tests can drive it with fakes. */
export function createEditRunner(deps: EditRunnerDeps): EditRunner {
  let tail: Promise<unknown> = Promise.resolve();
  let blocked = false;

  const run = (
    build: (system: DesignSystem) => readonly DesignSystemOperation[],
    title: string,
    undoable: boolean,
  ): Promise<boolean> => {
    const next = tail.then(async () => {
      if (blocked) return false;
      const before = deps.current();
      const operations = build(before);
      if (operations.length === 0) return false;
      const inverse = inverseOperations(before, operations);
      const outcome = await deps.apply(before.revision, operations);
      if (!outcome.ok) {
        if (outcome.conflict) {
          blocked = true;
          deps.onConflict(outcome.currentRevision ?? before.revision + 1);
        } else {
          deps.notify({
            kind: "failed",
            title: "The change was not saved",
            description: outcome.message,
          });
        }
        return false;
      }
      deps.onSaved(outcome.system);
      deps.notify({
        kind: "saved",
        title,
        undo:
          undoable && inverse.length > 0
            ? () =>
                void run(
                  () => inverse,
                  `Undid: ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
                  false,
                )
            : null,
      });
      return true;
    });
    tail = next.catch(() => false);
    return next;
  };

  return {
    edit: (intent) => run((system) => operationsFor(system, intent), intentLabel(intent), true),
    reset: () => {
      blocked = false;
    },
  };
}

// Only a revision conflict names the server's revision. A save that timed out waiting for
// another writer's lock is also "conflict", but nothing changed, so it is an ordinary failure.
export const conflictRevision = (cause: unknown): number | null => {
  if (typeof cause !== "object" || cause === null) return null;
  const error = cause as { _tag?: unknown; code?: unknown; currentRevision?: unknown };
  return error._tag === "DesignError" &&
    error.code === "conflict" &&
    typeof error.currentRevision === "number"
    ? error.currentRevision
    : null;
};

/**
 * failureText reads every conflict as a stale proposal, but nothing on the system page is a
 * proposal. A revision conflict says to reload; a lock wait or a move gets the server's sentence.
 */
export function editFailureText(cause: unknown, fallback: string): string {
  const error = cause as { _tag?: unknown; code?: unknown; detail?: unknown } | null;
  if (
    typeof cause === "object" &&
    error !== null &&
    error._tag === "DesignError" &&
    error.code === "conflict"
  ) {
    if (conflictRevision(cause) !== null)
      return `${CONFLICT_TEXT} Reload to see the latest version.`;
    return typeof error.detail === "string" && error.detail.trim() !== "" ? error.detail : fallback;
  }
  return failureText(cause, fallback);
}

export interface SystemEdits {
  readonly edit: (intent: SystemEditIntent) => Promise<boolean>;
  readonly conflict: boolean;
  /** Reads the system again; edits run again once a newer version has arrived. */
  readonly reload: () => void;
}

/** The page's edits, wired to `designSystem.apply` and the toast stack. */
export function useSystemEdits(input: {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly systemId: DesignSystemId;
  readonly system: DesignSystem;
  readonly onSaved: (system: DesignSystem) => void;
  readonly refresh: () => void;
}): SystemEdits {
  const { environmentId, owner, systemId } = input;
  const applyCommand = useAtomCommand(design.systemApply, { reportFailure: false });
  const latest = useRef(input.system);
  // A newer revision from the server wins over what this page saved last.
  if (input.system.revision >= latest.current.revision) latest.current = input.system;
  const onSaved = useRef(input.onSaved);
  onSaved.current = input.onSaved;
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const reloadTo = useRef<number | null>(null);
  const lastToast = useRef<string | null>(null);

  const runner = useMemo(
    () =>
      createEditRunner({
        apply: async (expectedRevision, operations) => {
          const result = await applyCommand({
            environmentId,
            input: { owner, systemId, expectedRevision, operations: [...operations] },
          });
          if (result._tag === "Success") return { ok: true, system: result.value.system };
          const cause = squashAtomCommandFailure(result);
          const currentRevision = conflictRevision(cause);
          return {
            ok: false,
            conflict: currentRevision !== null,
            ...(currentRevision === null ? {} : { currentRevision }),
            message: editFailureText(cause, "The design system could not be saved."),
          };
        },
        current: () => latest.current,
        onSaved: (system) => {
          latest.current = system;
          onSaved.current(system);
        },
        onConflict: (revision) => {
          reloadTo.current = revision;
          setConflict(true);
        },
        notify: (notice) => {
          if (lastToast.current !== null) toastManager.close(lastToast.current);
          lastToast.current =
            notice.kind === "saved"
              ? toastManager.add({
                  type: "success",
                  title: notice.title,
                  ...(notice.undo === null
                    ? {}
                    : { actionProps: { children: "Undo", onClick: notice.undo } }),
                })
              : toastManager.add({
                  type: "error",
                  title: notice.title,
                  description: notice.description,
                });
        },
      }),
    [applyCommand, environmentId, owner, systemId],
  );

  // Edits stay blocked until the reload brings the revision the server reported; an Add
  // pressed while the reload is in flight would conflict again.
  const revision = input.system.revision;
  useEffect(() => {
    if (!reloading) return;
    if (reloadTo.current !== null && revision < reloadTo.current) return;
    reloadTo.current = null;
    setReloading(false);
    setConflict(false);
    runner.reset();
  }, [reloading, revision, runner]);

  const refresh = input.refresh;
  const reload = useCallback(() => {
    setReloading(true);
    refresh();
  }, [refresh]);

  return { edit: runner.edit, conflict, reload };
}
