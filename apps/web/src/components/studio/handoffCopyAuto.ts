import {
  folderCopyAllConflictsKey,
  ProjectId,
  type FolderCopyChoice,
  type FolderCopyFileClass,
  type FolderCopyOffer,
  type FolderCopyRow,
  type FolderCopyStartInput,
  type FolderCopyStatus,
} from "@specweave-studio/contracts";
import { copyRowTitle } from "../../studio/folderCopy";
import type { PendingCopy, ReplaceAllOutcome } from "./handoffFolderCopyPending";

/**
 * One-click copy decisions: when a destination plan can be approved without asking,
 * what "Replace all" answers, and what the reduced preview shows.
 */

/** Row states that cannot replace anything on the destination, whatever it reports. */
const NOTHING_THERE: ReadonlySet<FolderCopyRow["status"]> = new Set([
  "new",
  "only-here",
  "skipped",
]);
/** Row states that leave the destination's files as they are when nothing is counted as replaced. */
const UNTOUCHED: ReadonlySet<FolderCopyRow["status"]> = new Set([
  "new",
  "same",
  "only-here",
  "skipped",
]);

/** Files this row's plan replaces or moves to the backup; null when the destination does not say. */
export function rowReplacing(row: FolderCopyRow): number | null {
  return row.replacing ?? null;
}

/**
 * Files on the destination the plan replaces or moves to the backup, from the totals or the
 * rows; null when an older destination does not count them.
 */
export function replacingCount(status: FolderCopyStatus): number | null {
  const total = status.totals?.replacing;
  if (total !== undefined) return total;
  if (status.rows.length === 0) return null;
  let sum = 0;
  for (const row of status.rows) {
    const value = rowReplacing(row);
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

/** A row that leaves the destination as it is: counted as replacing nothing, or nothing is there. */
function rowUntouched(row: FolderCopyRow): boolean {
  const counted = rowReplacing(row);
  // Without a count (an older destination) only rows with nothing there are safe.
  const safe = counted === null ? NOTHING_THERE.has(row.status) : counted === 0;
  return (
    safe &&
    UNTOUCHED.has(row.status) &&
    !row.needsDecision &&
    row.conflicts.length === 0 &&
    row.moreConflicts === 0 &&
    row.choices.length === 0
  );
}

/**
 * True only when approving cannot replace or move anything on the destination: every row
 * is counted as replacing nothing (or, from an older destination, is new or only there),
 * no branch moves, nothing needs a choice, no file conflicts, and the destination has room.
 * Secret-like files never block it: they stay on the source unless chosen. Any doubt means
 * the preview is shown.
 */
export function replacesNothing(status: FolderCopyStatus): boolean {
  if (status.state !== "previewed" || !status.totals) return false;
  if (status.totals.decisionsNeeded !== 0 || status.disk) return false;
  if ((status.totals.replacing ?? 0) !== 0) return false;
  // A plan without rows says nothing about what is already there.
  return status.rows.length > 0 && status.rows.every(rowUntouched);
}

/**
 * What a "Replace all" click saw and asks for: whether files only here are mirrored away,
 * which file classes travel, which repositories are cloned or left out, and the decision
 * each listed row and file conflict ends with once the click's answers are in. Another
 * window changing any of them makes the click no approval of the result.
 */
export function replaceAllBasis(status: FolderCopyStatus): string {
  return JSON.stringify({ choices: choicesOf(status), decisions: listedDecisions(status, true) });
}

function choicesOf(status: FolderCopyStatus): string {
  const rows = status.rows;
  return JSON.stringify({
    mirror: status.mirror,
    selection: [...status.selection].sort(),
    clone: rows
      .filter((row) => row.clone)
      .map((row) => row.id)
      .sort(),
    skip: rows
      .filter((row) => row.status === "skipped")
      .map((row) => row.id)
      .sort(),
  });
}

/** Each listed decision: as shown, or (`clicked`) as the click's answers leave it. */
function listedDecisions(status: FolderCopyStatus, clicked: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const theirs = (choices: ReadonlyArray<FolderCopyChoice>, answers: boolean) =>
    clicked && answers && choices.includes("take-theirs");
  for (const row of status.rows) {
    out[`row:${row.id}`] = theirs(row.choices, open(row.decision))
      ? "take-theirs"
      : (row.decision ?? "open");
    // A conflict that appeared since the click would take the row's one answer unseen.
    out[`count:${row.id}`] = String(row.conflicts.length + row.moreConflicts);
    const covers = replaceAllCoversRow(row);
    for (const conflict of row.conflicts)
      out[`file:${conflict.id}`] = theirs(conflict.choices, covers || open(conflict.decision))
        ? "take-theirs"
        : (conflict.decision ?? "open");
  }
  return out;
}

/**
 * A re-compared plan "Replace all" can approve: no open choice, room on the destination,
 * and (when the click recorded its basis) the same choices and listed decisions the click
 * asked for. Anything listed now must have been listed then; what went away since is fine.
 */
export function replaceAllReady(status: FolderCopyStatus, basis?: string): boolean {
  if (
    status.state !== "previewed" ||
    status.totals === null ||
    status.totals.decisionsNeeded !== 0 ||
    status.disk
  )
    return false;
  if (basis === undefined) return true;
  let asked: { choices?: unknown; decisions?: Record<string, unknown> };
  try {
    asked = JSON.parse(basis) as typeof asked;
  } catch {
    return false;
  }
  const seen = asked.decisions;
  if (asked.choices !== choicesOf(status) || !seen) return false;
  const now = listedDecisions(status, false);
  // A row or listed conflict the click never saw is no part of what it approved, even
  // when it took the place of one that went away; one settled away since is fine.
  if (!Object.keys(now).every((key) => Object.hasOwn(seen, key))) return false;
  return Object.entries(seen).every(([key, decision]) => {
    if (!Object.hasOwn(now, key)) return true;
    // Fewer conflicts in a row than the click saw replaces less; more needs review.
    if (key.startsWith("count:")) return Number(now[key]) <= Number(decision);
    return now[key] === decision;
  });
}

/** Rows the reduced preview shows: anything that may change something already there. */
export function changedRows(rows: ReadonlyArray<FolderCopyRow>): ReadonlyArray<FolderCopyRow> {
  return rows.filter((row) => {
    if (row.needsDecision || row.conflicts.length > 0 || row.moreConflicts > 0) return true;
    if (!UNTOUCHED.has(row.status)) return true;
    const counted = rowReplacing(row);
    // An unchanged-looking row from an older destination may still overwrite files.
    return counted === null ? !NOTHING_THERE.has(row.status) : counted > 0;
  });
}

/** Still open or answered with the source version: what "Replace all" would replace. */
const replaceable = (decision: FolderCopyChoice | null | undefined) =>
  (decision ?? null) === null || decision === "take-theirs";
const open = (decision: FolderCopyChoice | null | undefined) => (decision ?? null) === null;

/**
 * Whether "Replace all" answers every file conflict in the row with one key, unlisted ones
 * included: only when every listed conflict can take the source version and is still open
 * or already answered that way.
 */
function replaceAllCoversRow(row: FolderCopyRow): boolean {
  return row.conflicts.every(
    (conflict) => conflict.choices.includes("take-theirs") && replaceable(conflict.decision),
  );
}

/**
 * Unlisted conflicts "Replace all" leaves open: it cannot answer them one by one, and it
 * sends the row's one key only when it covers the row. A listed conflict still open means
 * no "All" choice answered the row. The row's own open choice is answered on its own key,
 * which leaves the unlisted conflicts open too; otherwise the row's own flag says.
 */
function unlistedLeftOpen(row: FolderCopyRow): number {
  if (row.moreConflicts === 0 || replaceAllCoversRow(row)) return 0;
  if (row.conflicts.some((conflict) => open(conflict.decision))) return row.moreConflicts;
  const rowOpen = row.choices.length > 0 && open(row.decision);
  return row.needsDecision || rowOpen ? row.moreConflicts : 0;
}

/**
 * How much "Replace all" would replace on the destination: only what it actually sends.
 * Items already answered with the destination's version are not counted, nor are
 * unlisted conflicts it leaves open.
 */
export function replacements(rows: ReadonlyArray<FolderCopyRow>): {
  readonly files: number;
  readonly repositories: number;
} {
  let files = 0;
  let repositories = 0;
  for (const row of rows) {
    if (row.choices.includes("take-theirs") && replaceable(row.decision)) repositories += 1;
    files += row.conflicts.filter(
      (conflict) => conflict.choices.includes("take-theirs") && replaceable(conflict.decision),
    ).length;
    // Unlisted conflicts are replaced only through the row's one key.
    if (row.moreConflicts > 0 && replaceAllCoversRow(row)) files += row.moreConflicts;
  }
  return { files, repositories };
}

/** "3 files and 1 repository", or null when nothing would be replaced. */
export function replacementText(rows: ReadonlyArray<FolderCopyRow>): string | null {
  const { files, repositories } = replacements(rows);
  const parts = [
    files > 0 ? `${files.toLocaleString()} ${files === 1 ? "file" : "files"}` : null,
    repositories > 0
      ? `${repositories.toLocaleString()} ${repositories === 1 ? "repository" : "repositories"}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" and ") : null;
}

/**
 * "4 more conflicts in Other files still need a choice.", for each row whose unlisted
 * conflicts "Replace all" leaves open; null when it leaves none.
 */
export function replaceAllLeftText(
  rows: ReadonlyArray<FolderCopyRow>,
  rootLabel?: string,
): string | null {
  const parts = rows.flatMap((row) => {
    const left = unlistedLeftOpen(row);
    if (left === 0) return [];
    return [
      `${left.toLocaleString()} more ${left === 1 ? "conflict" : "conflicts"} in ${copyRowTitle(row, rootLabel)} still ${left === 1 ? "needs" : "need"} a choice.`,
    ];
  });
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * What "Replace all" leads to: "copy" when it answers everything still open, "copy-kept"
 * when it does and some items keep the destination's version, and "ask" when something
 * would still need a choice, so the re-compared plan waits for the person.
 */
export function replaceAllOutcome(rows: ReadonlyArray<FolderCopyRow>): ReplaceAllOutcome {
  let kept = false;
  for (const row of rows) {
    if (unlistedLeftOpen(row) > 0) return "ask";
    if (row.choices.length > 0) {
      if (open(row.decision) && !row.choices.includes("take-theirs")) return "ask";
      if (!replaceable(row.decision)) kept = true;
    }
    for (const conflict of row.conflicts) {
      if (open(conflict.decision) && !conflict.choices.includes("take-theirs")) return "ask";
      if (!replaceable(conflict.decision)) kept = true;
    }
    // Every listed conflict kept: an "All" choice kept the unlisted ones too.
    if (row.moreConflicts > 0 && !replaceAllCoversRow(row)) kept = true;
  }
  return kept ? "copy-kept" : "copy";
}

/**
 * Answers every open replaceable row and conflict with the source version; old versions go
 * to the backup. Items the person already answered keep their answer.
 */
export function replaceAllDecisions(
  rows: ReadonlyArray<FolderCopyRow>,
): Readonly<Record<string, FolderCopyChoice>> {
  const decisions: Record<string, FolderCopyChoice> = {};
  for (const row of rows) {
    if (row.choices.includes("take-theirs") && open(row.decision))
      decisions[row.id] = "take-theirs";
    if (row.conflicts.length === 0 && row.moreConflicts === 0) continue;
    // One key answers every file conflict in the row, including unlisted ones.
    if (replaceAllCoversRow(row)) decisions[folderCopyAllConflictsKey(row.id)] = "take-theirs";
    else
      for (const conflict of row.conflicts)
        if (conflict.choices.includes("take-theirs") && open(conflict.decision))
          decisions[conflict.id] = "take-theirs";
  }
  return decisions;
}

/**
 * Who can send the secrets a copy left behind: this window (its grant on the source holds
 * access:write), only the source's own window, or not confirmed yet.
 */
export type SecretsSender = "here" | "source-only" | "unconfirmed";

/**
 * "3 secret-like files (.env and similar) stayed on M4. …" with the action that sends them:
 * from this window only when it can, otherwise from SpecWithCode on the source, which
 * always can. No action is named (a null sender) when a fresh copy would carry none of
 * them. Null when none stayed.
 */
export function secretsLeftText(
  count: number,
  sourceLabel: string,
  sender: SecretsSender | null = "here",
): string | null {
  if (count <= 0) return null;
  const stayed = `${count.toLocaleString()} secret-like ${count === 1 ? "file" : "files"} (.env and similar) stayed on ${sourceLabel}.`;
  if (sender === null) return stayed;
  if (sender === "here") return `${stayed} To send them, copy again with Secrets ticked.`;
  return sender === "source-only"
    ? `${stayed} This window can't send them: only SpecWithCode on ${sourceLabel} can. Start the copy again there with Secrets ticked.`
    : `${stayed} To send them, start the copy again in SpecWithCode on ${sourceLabel} with Secrets ticked.`;
}

/** The left-behind secret files a fresh copy could carry: those among the ones that can travel. */
export function secretsLeftSendable(
  secretFiles: ReadonlyArray<{ readonly path: string }> | null | undefined,
  sent: ReadonlyArray<{ readonly path: string }> | null | undefined,
  travel: ReadonlyArray<string>,
): boolean {
  if (!secretFiles) return false;
  const arrived = new Set((sent ?? []).map((file) => file.path));
  return secretFiles.some((file) => !arrived.has(file.path) && travel.includes(file.path));
}

/** Secret-like files measured on the source that were not sent with this copy. */
export function secretsLeft(
  secretFiles: ReadonlyArray<{ readonly path: string }> | null | undefined,
  sent: ReadonlyArray<{ readonly path: string }> | null | undefined,
): number {
  if (!secretFiles) return 0;
  const arrived = new Set((sent ?? []).map((file) => file.path));
  return secretFiles.filter((file) => !arrived.has(file.path)).length;
}

/** Repository rows still waiting for the clone method's automatic choice. */
export function undecidedCloneRows(rows: ReadonlyArray<FolderCopyRow>): ReadonlyArray<string> {
  return rows
    .filter((row) => row.kind === "repository" && row.cloneAvailable && !row.clone)
    .map((row) => row.id);
}

/** The destination request that starts comparing, from the source's offer and the saved pointer. */
export function copyStartInput(
  offer: FolderCopyOffer,
  saved: PendingCopy,
  selection: ReadonlyArray<FolderCopyFileClass>,
): FolderCopyStartInput {
  return {
    operationId: offer.operationId,
    sourceEnvironmentId: offer.sourceEnvironmentId,
    sourceProjectId: offer.sourceProjectId,
    sourceUrl: offer.sourceUrl,
    ...(offer.sourceConnectUrl ? { sourceConnectUrl: offer.sourceConnectUrl } : {}),
    sourceMachine: offer.sourceMachine,
    token: offer.token,
    title: offer.title,
    mode: offer.mode,
    targetFolder: saved.targetFolder,
    ...(offer.copyRoot ? { copyRoot: offer.copyRoot } : {}),
    ...(offer.projectRelativePath ? { projectRelativePath: offer.projectRelativePath } : {}),
    selection,
    ...(saved.projectId ? { projectId: ProjectId.make(saved.projectId) } : {}),
    // The person reviews every repository here, so "take theirs" stays offered.
    purpose: "review",
  };
}

/** The pointer after a "Replace all" click: what it leads to and the choices it saw. */
export function replaceAllPointer(saved: PendingCopy, status: FolderCopyStatus): PendingCopy {
  return {
    ...saved,
    replaceAll: true,
    replaceAllOutcome: replaceAllOutcome(status.rows),
    replaceAllBasis: replaceAllBasis(status),
  };
}
