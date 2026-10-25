import { type ChangedFilesAttribution } from "@specweave-studio/client-runtime/work-log/presentation";
import { type RunId, type ThreadId } from "@specweave-studio/contracts";
import {
  type MouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";
import { type TurnDiffLinkOptions } from "~/diffPanelStore";
import { type TurnDiffFileChange } from "../../types";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import { ChevronRightIcon, FileDiffIcon, XIcon } from "lucide-react";
import { ChevronsDownUp, ChevronsUpDown, Folder, FolderClosed } from "lucide";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { MorphIcon } from "~/components/MorphIcon";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export const NOT_REPORTED_BY_EDIT_TOOL_LABEL =
  "Changed in this folder during the turn, not reported by an edit tool (commands, other tools or other agents in this checkout)";

/** Opens the OS-level context menu for a changed file (reveal in file manager, open in editor). */
export type ChangedFileContextMenuHandler = (filePath: string, event: MouseEvent) => void;

export type OpenTurnDiffHandler = (
  runId: RunId,
  filePath?: string,
  options?: TurnDiffLinkOptions,
) => void;

interface ChangedFilesSections {
  /** Files the turn's own edit tools named, or every file when there is no attribution. */
  readonly own: ReadonlyArray<TurnDiffFileChange>;
  readonly bySubagent: ReadonlyArray<{
    readonly title: string;
    readonly files: ReadonlyArray<TurnDiffFileChange>;
    readonly linkOptions: TurnDiffLinkOptions;
  }>;
  readonly notReported: ReadonlyArray<TurnDiffFileChange>;
  /** Distinct files listed under any subagent. */
  readonly subagentFileCount: number;
}

/**
 * Splits the card's files by who reported them. A file a loaded subagent named lists under
 * that subagent and never under the turn's own edits or the not-reported section; attribution
 * paths the card does not list are ignored, since they carry no stats.
 */
function splitChangedFiles(
  files: ReadonlyArray<TurnDiffFileChange>,
  attribution: ChangedFilesAttribution | undefined,
  sourceThreadId: ThreadId | undefined,
): ChangedFilesSections {
  if (!attribution) return { own: files, bySubagent: [], notReported: [], subagentFileCount: 0 };
  const bySubagentPaths = new Set<string>();
  const bySubagent = attribution.bySubagent.flatMap((group) => {
    const named = new Set(group.files);
    const listed = files.filter((file) => named.has(file.path));
    if (listed.length === 0) return [];
    for (const file of listed) bySubagentPaths.add(file.path);
    return [
      {
        title: group.title,
        files: listed,
        linkOptions: {
          ...(sourceThreadId ? { sourceThreadId } : {}),
          attributedTo: { title: group.title },
        },
      },
    ];
  });
  const notReportedPaths = new Set(attribution.notReported);
  return {
    own: files.filter(
      (file) => !bySubagentPaths.has(file.path) && !notReportedPaths.has(file.path),
    ),
    bySubagent,
    notReported: files.filter(
      (file) => notReportedPaths.has(file.path) && !bySubagentPaths.has(file.path),
    ),
    subagentFileCount: bySubagentPaths.size,
  };
}

function formatTitleList(titles: ReadonlyArray<string>): string {
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/** Names the run's subagents whose edits could not be checked, so no file is pinned on the turn. */
function unloadedSubagentNote(titles: ReadonlyArray<string>): string | null {
  if (titles.length === 0) return null;
  return titles.length === 1
    ? `May include edits by subagent ${titles[0]}, whose activity is not loaded here.`
    : `May include edits by subagents ${formatTitleList(titles)}, whose activity is not loaded here.`;
}

function subagentSummary(sections: ChangedFilesSections): string | null {
  const count = sections.subagentFileCount;
  if (count === 0) return null;
  const only = sections.bySubagent.length === 1 ? sections.bySubagent[0] : undefined;
  return only ? `${count} by subagent ${only.title}` : `${count} by subagents`;
}

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  runId: RunId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: OpenTurnDiffHandler;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
  /** Concise timeline detail: the count, stats and Open diff on one line, without the tree. */
  summaryOnly?: boolean;
  /** Who reported each file (AC-07, AC-19). Without it every file lists in one tree. */
  attribution?: ChangedFilesAttribution | undefined;
  /** The thread whose turn this is; every Open diff from the card carries it. */
  sourceThreadId?: ThreadId | undefined;
  /** Failed entries of the turn, counted on the Concise line (D-09). */
  failedCount?: number | undefined;
}) {
  const {
    summaryOnly = false,
    runId,
    files,
    allDirectoriesExpanded,
    resolvedTheme,
    onToggleAllDirectories,
    onOpenTurnDiff,
    onFileContextMenu,
    attribution,
    sourceThreadId,
    failedCount = 0,
  } = props;
  const summaryStat = useMemo(() => summarizeTurnDiffStats(files), [files]);
  const sections = useMemo(
    () => splitChangedFiles(files, attribution, sourceThreadId),
    [attribution, files, sourceThreadId],
  );
  const linkOptions = useMemo<TurnDiffLinkOptions | undefined>(
    () => (sourceThreadId ? { sourceThreadId } : undefined),
    [sourceThreadId],
  );
  if (files.length === 0) return null;
  const hasDirectories = !summaryOnly && files.some((file) => /[/\\]/.test(file.path));
  const notReportedNote = unloadedSubagentNote(attribution?.unloadedSubagentTitles ?? []);
  const subagentLine = summaryOnly ? subagentSummary(sections) : null;
  const treeProps = {
    runId,
    allDirectoriesExpanded,
    resolvedTheme,
    onOpenTurnDiff,
    onFileContextMenu,
  };

  return (
    <div
      className="@container/changed-files mt-4 rounded-lg bg-secondary dark:bg-input/20"
      data-changed-files-state={summaryOnly ? "summary" : "tree"}
    >
      <div
        data-changed-files-header=""
        className={cn(
          "flex items-center justify-between gap-2 rounded-lg px-3 py-2",
          !summaryOnly &&
            "sticky top-2 z-10 rounded-b-none bg-secondary dark:bg-background dark:bg-linear-to-b dark:from-input/20 dark:to-input/20",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground",
            summaryOnly ? "flex-nowrap overflow-hidden" : "flex-wrap",
          )}
        >
          <span className="shrink-0 whitespace-nowrap">
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(summaryStat) && (
            <DiffStatLabel
              additions={summaryStat.additions}
              deletions={summaryStat.deletions}
              layout="inline"
              className="shrink-0 text-xs leading-4"
            />
          )}
          {summaryOnly && failedCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-tool-error-icon">
              <XIcon aria-hidden className="size-3" />
              {failedCount} failed
            </span>
          ) : null}
          {/* A narrow card cuts these, so each tooltip starts with the text it cuts. */}
          {summaryOnly && sections.notReported.length > 0 ? (
            <span
              className="min-w-0 truncate font-normal text-muted-foreground"
              title={[
                `+${sections.notReported.length} not from edit tools`,
                NOT_REPORTED_BY_EDIT_TOOL_LABEL,
                ...(notReportedNote ? [notReportedNote] : []),
              ].join("\n")}
            >
              +{sections.notReported.length} not from edit tools
            </span>
          ) : null}
          {subagentLine ? (
            <span
              className="min-w-0 truncate font-normal text-muted-foreground"
              title={[
                subagentLine,
                ...(sections.bySubagent.length > 1
                  ? sections.bySubagent.map((group) => `Edited by subagent ${group.title}`)
                  : []),
              ].join("\n")}
            >
              {subagentLine}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasDirectories && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={
                      allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                    }
                    data-scroll-anchor-ignore
                    onClick={onToggleAllDirectories}
                  />
                }
              >
                <MorphIcon
                  className="size-3"
                  icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  aria-label="Open diff"
                  onClick={() => openTurnDiff(onOpenTurnDiff, runId, files[0]?.path, linkOptions)}
                />
              }
            >
              <FileDiffIcon className="size-3" />
              <span className={summaryOnly ? undefined : "hidden @[24rem]/changed-files:inline"}>
                Open diff
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">Open the full diff</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {summaryOnly ? null : (
        <div>
          {sections.own.length > 0 ? (
            <ChangedFilesTree
              key={`${runId}:own:${allDirectoriesExpanded}`}
              {...treeProps}
              files={sections.own}
              linkOptions={linkOptions}
            />
          ) : null}
          {sections.bySubagent.map((group, index) => (
            <ChangedFilesSection
              key={`subagent:${index}:${group.title}`}
              kind="subagent"
              label={`Edited by subagent ${group.title}`}
            >
              <ChangedFilesTree
                key={`${runId}:subagent:${index}:${allDirectoriesExpanded}`}
                {...treeProps}
                files={group.files}
                linkOptions={group.linkOptions}
              />
            </ChangedFilesSection>
          ))}
          {sections.notReported.length > 0 ? (
            <ChangedFilesSection
              kind="not-reported"
              label={NOT_REPORTED_BY_EDIT_TOOL_LABEL}
              note={notReportedNote}
            >
              <ChangedFilesTree
                key={`${runId}:not-reported:${allDirectoriesExpanded}`}
                {...treeProps}
                files={sections.notReported}
                linkOptions={linkOptions}
              />
            </ChangedFilesSection>
          ) : null}
        </div>
      )}
    </div>
  );
});

/** A labelled group of card files that the turn's own edit tools did not report. */
function ChangedFilesSection(props: {
  kind: "subagent" | "not-reported";
  label: string;
  note?: string | null | undefined;
  children: ReactNode;
}) {
  const labelId = useId();
  const noteId = useId();
  return (
    <section
      data-changed-files-section={props.kind}
      aria-labelledby={props.note ? `${labelId} ${noteId}` : labelId}
      className="border-t border-border/60 first:border-t-0"
    >
      <div className="px-4 pt-2.5 text-2xs leading-4 text-muted-foreground">
        <p id={labelId}>{props.label}</p>
        {props.note ? (
          <p id={noteId} className="text-muted-foreground">
            {props.note}
          </p>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

/** Calls the handler without a trailing undefined, so two-argument callers see what they did before. */
function openTurnDiff(
  onOpenTurnDiff: OpenTurnDiffHandler,
  runId: RunId,
  filePath: string | undefined,
  options: TurnDiffLinkOptions | undefined,
) {
  if (options) onOpenTurnDiff(runId, filePath, options);
  else onOpenTurnDiff(runId, filePath);
}

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  runId: RunId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: OpenTurnDiffHandler;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
  /** Passed with every file's Open diff: the source thread and, for subagent files, the title. */
  linkOptions?: TurnDiffLinkOptions | undefined;
}) {
  const {
    files,
    allDirectoriesExpanded,
    onOpenTurnDiff,
    resolvedTheme,
    runId,
    onFileContextMenu,
    linkOptions,
  } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const hasDirectoryNodes = directoryPathsKey.length > 0;
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
          },
        };
      });
    },
    [allDirectoriesExpanded, expansionStateKey],
  );

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            aria-expanded={isExpanded}
            className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/80",
                isExpanded && "rotate-90",
              )}
            />
            <MorphIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              icon={isExpanded ? Folder : FolderClosed}
            />
            <span
              className="truncate font-mono text-2xs text-muted-foreground group-hover:text-foreground/90"
              title={node.path}
            >
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div>{node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}</div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => openTurnDiff(onOpenTurnDiff, runId, node.path, linkOptions)}
        onContextMenu={
          onFileContextMenu
            ? (event) => {
                event.preventDefault();
                onFileContextMenu(node.path, event);
              }
            : undefined
        }
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <PierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground"
        />
        <span className="flex min-w-0 font-mono text-xs text-foreground/85 group-hover:text-foreground">
          <MiddleTruncate value={node.name} />
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return <div className="p-2">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>;
});

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
