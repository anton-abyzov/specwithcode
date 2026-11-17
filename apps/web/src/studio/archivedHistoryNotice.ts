/**
 * The project's notice when resolved history could not be loaded from some of
 * its machines. Pure rules only; ProjectWorkspaceSurface renders it.
 *
 * @module archivedHistoryNotice
 */
import type { MachineReachState } from "@specweave-studio/client-runtime/connection";

export interface ArchivedHistoryNotice {
  /** An English phrase for `say`/`tx`, with a `{machines}` slot when it names them. */
  readonly phrase: string;
  readonly params: Readonly<Record<string, string>>;
}

export const ARCHIVED_HISTORY_FAILED_NAMED = "Resolved history from {machines} could not be loaded.";
export const ARCHIVED_HISTORY_FAILED_UNNAMED =
  "Resolved history from another machine could not be loaded.";

/**
 * A machine the app already shows as not connected (down, reconnecting or
 * connecting). Its history failing is that machine's own notice, not a second
 * alarm for the project. A machine the app has not judged is not shown at all,
 * so its failure still counts.
 */
function shownNotConnected(state: MachineReachState | undefined): boolean {
  return state !== undefined && state !== "connected" && state !== "catching-up";
}

/**
 * What the notice says, or null when it should not show: nothing failed, or
 * every machine that failed is already shown as not connected. It names the
 * machines that failed; one with no name to show reads as "another machine",
 * never its raw id.
 */
export function archivedHistoryNotice(input: {
  readonly failedEnvironmentIds: ReadonlyArray<string>;
  readonly reach: ReadonlyMap<string, MachineReachState>;
  /** The machine's name, or null when the app has none to show. */
  readonly label: (environmentId: string) => string | null;
}): ArchivedHistoryNotice | null {
  const failed = [...new Set(input.failedEnvironmentIds)].filter(
    (environmentId) => !shownNotConnected(input.reach.get(environmentId)),
  );
  if (failed.length === 0) return null;
  const names = [
    ...new Set(
      failed.map((environmentId) => input.label(environmentId)).filter((name) => name !== null),
    ),
  ];
  if (names.length === 0) return { phrase: ARCHIVED_HISTORY_FAILED_UNNAMED, params: {} };
  const unnamed = failed.some((environmentId) => input.label(environmentId) === null);
  return {
    phrase: ARCHIVED_HISTORY_FAILED_NAMED,
    params: { machines: [...names, ...(unnamed ? ["another machine"] : [])].join(", ") },
  };
}
