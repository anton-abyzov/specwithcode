import type { MachineHandoffSourceChanges } from "@specweave-studio/contracts";
import { formatBytes } from "../../studio/folderCopy";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { checkLabel } from "./handoffCopyNotices";
import { measuredAgo } from "./HandoffCopyScanFreshness";

type ChangeRow = MachineHandoffSourceChanges["rows"][number];

/** A row by what it describes, as the source matches them: a repository apart from a file. */
export const changeKey = (row: Pick<ChangeRow, "path" | "kind">) =>
  `${row.kind === "repository" ? "repository" : "path"}:${row.path}`;

/**
 * What a move left only on the source: every path that differs there now, and which of
 * them the person chose to move without. `chosen` is null when this browser no longer
 * has that full list, after a reopen or when it was longer than the source sends.
 */
export interface LeftOnSource {
  readonly total: number;
  readonly rows: ReadonlyArray<ChangeRow>;
  readonly truncated: boolean;
  /** Rows by `changeKey`. */
  readonly chosen: ReadonlySet<string> | null;
}

const KIND_LABEL: Readonly<Record<ChangeRow["kind"], string>> = {
  changed: "Changed",
  added: "New",
  removed: "Removed",
  unreadable: "Unreadable",
  repository: "Git",
};

const ROOT_GROUP = "Top folder";
const REPOSITORY_GROUP = "Repositories";

const paths = (value: number) => `${value.toLocaleString()} ${value === 1 ? "path" : "paths"}`;

/** "Move without this path" or "Move without these 3 paths". */
export const moveWithoutLabel = (total: number) =>
  `Move without ${total === 1 ? "this path" : `these ${total.toLocaleString()} paths`}`;

const shortHead = (head: string | undefined) => (head ? head.slice(0, 7) : "none");

/** One repository row in words: its commit, branches, stashes and staged changes. */
function repositoryDetail(row: ChangeRow): string {
  const repository = row.repository;
  if (!repository) return "Git data changed.";
  const parts: string[] = [];
  if (repository.headFrom !== repository.headTo)
    parts.push(`${shortHead(repository.headFrom)} → ${shortHead(repository.headTo)}`);
  if (repository.branchesChanged.length > 0)
    parts.push(
      `${repository.branchesChanged.length === 1 ? "branch" : "branches"} ${repository.branchesChanged.join(", ")}`,
    );
  if (repository.stashFrom !== repository.stashTo)
    parts.push(`stashes ${repository.stashFrom} → ${repository.stashTo}`);
  if (repository.indexChanged) parts.push("staged changes differ");
  if (repository.refsChanged) parts.push("tags or other refs differ");
  if (repository.settingsChanged) parts.push("Git settings or hooks differ");
  return parts.length > 0 ? parts.join("; ") : "Git data changed.";
}

/** Rows grouped by their top folder, repositories apart, in the order the source sent them. */
function groupRows(rows: ReadonlyArray<ChangeRow>) {
  const groups = new Map<string, ChangeRow[]>();
  for (const row of rows) {
    const slash = row.path.indexOf("/");
    const key =
      row.kind === "repository"
        ? REPOSITORY_GROUP
        : slash > 0
          ? `${row.path.slice(0, slash)}/`
          : ROOT_GROUP;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()];
}

/** The listed paths, grouped by top folder, each with its kind and size. */
function SourceChangeRows({
  rows,
  total,
  label,
}: {
  readonly rows: ReadonlyArray<ChangeRow>;
  /** Every path the list stands for; more than the rows when the source cut it short. */
  readonly total: number;
  readonly label: string;
}) {
  return (
    <div className="space-y-2 text-xs" aria-label={label} role="group">
      {groupRows(rows).map(([group, entries]) => (
        <div key={group} className="space-y-1" data-slot="source-change-group">
          <p className="font-medium wrap-anywhere">{group}</p>
          <ul className="space-y-0.5 pl-1">
            {entries.map((row) => (
              <li
                key={`${row.kind}:${row.path}`}
                className="flex items-baseline gap-2"
                data-slot="source-change"
                data-kind={row.kind}
              >
                <Badge
                  size="sm"
                  variant={row.kind === "unreadable" || row.unsettled ? "warning" : "outline"}
                >
                  {row.unsettled ? "Copied mid-write" : KIND_LABEL[row.kind]}
                </Badge>
                <span className="min-w-0 font-mono wrap-anywhere">
                  {row.kind === "repository" ? checkLabel(row.path) : row.path}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {row.kind === "repository"
                    ? repositoryDetail(row)
                    : row.size !== undefined
                      ? formatBytes(row.size)
                      : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {total > rows.length && (
        <p className="text-muted-foreground">and {(total - rows.length).toLocaleString()} more.</p>
      )}
    </div>
  );
}

/**
 * What each kind of row means for the copy: removed paths are gone from the source but
 * still in the copy, files copied mid-write may be incomplete there, and the rest
 * differ only on the source.
 */
function rowConsequences(
  rows: ReadonlyArray<ChangeRow>,
  sourceLabel: string,
  targetLabel: string,
): string {
  const removed = rows.filter((row) => row.kind === "removed").length;
  const unsettled = rows.filter((row) => row.unsettled).length;
  const notes: string[] = [];
  if (removed > 0)
    notes.push(
      `${removed === 1 ? "The removed path is" : `The ${removed.toLocaleString()} removed paths are`} gone from ${sourceLabel} but still in the copy on ${targetLabel}; delete ${removed === 1 ? "it" : "them"} there if the coordinator should not see ${removed === 1 ? "it" : "them"}.`,
    );
  if (unsettled > 0)
    notes.push(
      `${unsettled === 1 ? "A file was" : `${unsettled.toLocaleString()} files were`} still being written when copied, so the copy on ${targetLabel} may be incomplete.`,
    );
  return notes.join(" ");
}

/**
 * The source's list of paths that changed after copying, shown when it refused to move the
 * coordinator. The choices sit in the footer: see HandoffSourceChangesActions.
 */
export function HandoffSourceChanges({
  changes,
  sourceLabel,
  targetLabel,
  capturedAt,
}: {
  readonly changes: MachineHandoffSourceChanges;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  /** When the copied files were captured; older copies have no time. */
  readonly capturedAt?: number | undefined;
}) {
  return (
    <div
      className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
      data-slot="source-changes"
    >
      <p>
        {changes.total === 1 ? "This path is" : "These paths are"} different on {sourceLabel} than
        in the copy on {targetLabel}.
        {capturedAt !== undefined &&
          ` The copy has the files as they were ${measuredAgo(capturedAt)}.`}
      </p>
      <SourceChangeRows
        rows={changes.rows}
        total={changes.total}
        label={`Changed on ${sourceLabel}`}
      />
      <p className="text-xs text-muted-foreground">
        {changes.acceptable
          ? `Copy again brings ${sourceLabel}'s version over. Move without them keeps ${sourceLabel}'s changes there and the copy on ${targetLabel} as it is. Keep the coordinator on ${sourceLabel} to go on working there; the copy on ${targetLabel} stays.`
          : `This copy was not captured, so you can't move without them. Copy again brings them over. Or keep the coordinator on ${sourceLabel}; the copy on ${targetLabel} stays.`}
        {rowConsequences(changes.rows, sourceLabel, targetLabel) &&
          ` ${rowConsequences(changes.rows, sourceLabel, targetLabel)}`}
      </p>
    </div>
  );
}

/** The footer's choices while the change list is shown. */
export function HandoffSourceChangesActions({
  changes,
  sourceLabel,
  busy,
  onCopyAgain,
  onMoveWithout,
  onKeepHere,
}: {
  readonly changes: MachineHandoffSourceChanges;
  readonly sourceLabel: string;
  readonly busy: boolean;
  readonly onCopyAgain: () => void;
  readonly onMoveWithout: () => void;
  readonly onKeepHere: () => void;
}) {
  return (
    <>
      <Button disabled={busy} onClick={onCopyAgain}>
        Copy again
      </Button>
      {changes.acceptable && (
        <Button variant="outline" disabled={busy} onClick={onMoveWithout}>
          {moveWithoutLabel(changes.total)}
        </Button>
      )}
      <Button variant="ghost" data-leading disabled={busy} onClick={onKeepHere}>
        Keep the coordinator on {sourceLabel}
      </Button>
    </>
  );
}

/** After a move: the paths that are only on the source, split by why when that is known. */
export function HandoffLeftOnSource({
  left,
  sourceLabel,
  targetLabel,
}: {
  readonly left: LeftOnSource;
  readonly sourceLabel: string;
  readonly targetLabel: string;
}) {
  const chosen = left.chosen;
  const byChoice = chosen ? left.rows.filter((row) => chosen.has(changeKey(row))) : [];
  const later = chosen ? left.rows.filter((row) => !chosen.has(changeKey(row))) : [];
  const consequences = rowConsequences(left.rows, sourceLabel, targetLabel);
  return (
    <div
      className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
      data-slot="copy-left-on-source"
    >
      <p role="status" className="font-medium text-warning-foreground">
        {paths(left.total)} {left.total === 1 ? "differs" : "differ"} on {sourceLabel} from the copy
        on {targetLabel}.
      </p>
      {chosen && !left.truncated ? (
        <>
          {byChoice.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs">Left by your choice:</p>
              <SourceChangeRows
                rows={byChoice}
                total={byChoice.length}
                label="Left by your choice"
              />
            </div>
          )}
          {later.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs">Changed after the handoff:</p>
              <SourceChangeRows
                rows={later}
                total={later.length}
                label="Changed after the handoff"
              />
            </div>
          )}
        </>
      ) : (
        <SourceChangeRows rows={left.rows} total={left.total} label={`Only on ${sourceLabel}`} />
      )}
      <p className="text-xs text-muted-foreground">
        {`Changed and new paths are only on ${sourceLabel}: copy them yourself if the coordinator needs them.`}
        {consequences && ` ${consequences}`}
      </p>
    </div>
  );
}
