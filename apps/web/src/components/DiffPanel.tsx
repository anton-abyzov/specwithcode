import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@specweave-studio/client-runtime/errors";
import {
  matchDiffPath,
  repoRelativePath,
  turnDiffState,
  turnDiffStateMessage,
  type DiffPathMatch,
  type PathRoots,
  type TurnDiffState,
} from "@specweave-studio/client-runtime/work-log/presentation";
import type { ScopedThreadRef, RunId } from "@specweave-studio/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import {
  firstChangedNewSideLine,
  openDiffFilePrimaryAction,
  resolveDiffFileTarget,
} from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { useProject, useThreadProjection, useThreadShell } from "../state/entities";
import { useMachineNicknames } from "../studio/machineNickname";
import { resolveThreadRouteRef } from "../threadRoutes";
import type { TurnDiffSummary } from "../types";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { Button } from "./ui/button";
import { MiddleTruncate } from "./ui/middle-truncate";
import { toastManager } from "./ui/toast";
import { MorphIcon } from "~/components/MorphIcon";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";

import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileHeaderSuffix } from "./diffs/DiffFileHeaderSuffix";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const DIFF_FILE_TREE_STORAGE_KEY = "studio.diffFileTreeOpen";
const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number }
>();

function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const CURRENT_FILE_NOTICE = "Showing the current file; it may differ from this turn";

/** The run's ready checkpoint, else whichever checkpoint it has. */
function findTurnSummary(
  summaries: ReadonlyArray<TurnDiffSummary>,
  runId: RunId,
): TurnDiffSummary | undefined {
  return (
    summaries.find((summary) => summary.runId === runId && summary.status === "ready") ??
    summaries.find((summary) => summary.runId === runId)
  );
}

/**
 * The file of a patch that a link names. The exact relativizer decides first; a path that is
 * already repository-relative, as a card row's checkpoint path is, then matches as written.
 * A rename matches by its old name too.
 */
function resolveLinkedDiffFile(
  path: string,
  files: ReadonlyArray<{ readonly name: string; readonly prevName?: string | undefined }>,
  roots: PathRoots,
): DiffPathMatch | null {
  const match = (candidates: ReadonlyArray<string>): DiffPathMatch | null => {
    const relativized = matchDiffPath(path, candidates, roots);
    if (relativized) return relativized;
    const written = path
      .trim()
      .replaceAll("\\", "/")
      .replace(/^(?:\.\/)+/, "");
    return candidates.includes(written) ? { path: written, matchedBy: "exact" } : null;
  };
  const byName = match(files.map((file) => file.name));
  if (byName) return byName;
  const renamed = files.filter((file) => file.prevName && file.prevName !== file.name);
  const byPreviousName = match(renamed.map((file) => file.prevName!));
  const file = byPreviousName && renamed.find((entry) => entry.prevName === byPreviousName.path);
  return file ? { path: file.name, matchedBy: byPreviousName.matchedBy } : null;
}

type MissingDiffFileReason =
  | { readonly kind: "outside_folder"; readonly folder: string }
  | { readonly kind: "whitespace" }
  | { readonly kind: "size_limit" }
  | { readonly kind: "not_in_snapshot" };

function missingDiffFileReasonText(reason: MissingDiffFileReason): string {
  switch (reason.kind) {
    case "outside_folder":
      return `outside the checkpoint folder ${reason.folder}`;
    case "whitespace":
      return "hidden by Ignore whitespace";
    case "size_limit":
      return "beyond the diff size limit";
    case "not_in_snapshot":
      return "not in this turn's snapshot (ignored path, nested repository or reverted)";
  }
}

function pathBaseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}

function DiffNotice({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "warning";
}) {
  return (
    <div
      className={cn(
        "shrink-0 border-b border-border/70 px-3 py-1.5 text-2xs",
        tone === "warning"
          ? "bg-warning/8 text-warning-foreground"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** Where and on which machine a turn's snapshot was taken, from the checkpoint's stamp. */
function TurnProvenanceHeader({
  turn,
  turnCount,
  capturedOn,
  servedBy,
}: {
  turn: TurnDiffSummary;
  turnCount: number | undefined;
  capturedOn: string | null;
  servedBy: string | null;
}) {
  const shortHead = turn.headOid?.slice(0, 7);
  const revision =
    turn.branch && shortHead
      ? `${turn.branch}@${shortHead}`
      : (shortHead ?? (turn.branch === null ? null : turn.branch));
  if (!turn.repoRoot && !turn.cwd && !revision && !capturedOn) return null;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-border/70 px-3 py-1.5 text-2xs text-muted-foreground"
      aria-label="Turn snapshot"
    >
      <span className="font-medium text-foreground">Turn {turnCount ?? "?"}</span>
      {turn.repoRoot ? (
        <span className="min-w-0 truncate" title={turn.repoRoot}>
          {pathBaseName(turn.repoRoot)}
        </span>
      ) : null}
      {turn.cwd ? <MiddleTruncate className="min-w-0 font-mono" value={turn.cwd} /> : null}
      {revision ? (
        <MiddleTruncate
          className="min-w-0 font-mono"
          value={revision}
          {...(shortHead ? { tail: shortHead.length + 1 } : {})}
        />
      ) : null}
      {capturedOn ? (
        servedBy ? (
          <span className="text-warning-foreground">
            Captured on {capturedOn}, served by {servedBy}
          </span>
        ) : (
          <span title={`Captured on ${capturedOn}`}>{capturedOn}</span>
        )
      ) : null}
    </div>
  );
}

/** Collapse control for one file header; re-renders only when its own file changes. */
function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  unavailable,
  iconClassName,
  onToggle,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  unavailable: boolean;
  iconClassName: string;
  onToggle: (fileKey: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="-ms-0.5"
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            aria-expanded={!collapsed}
            disabled={unavailable}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        <MorphIcon
          className={cn("size-4", iconClassName)}
          icon={collapsed ? ChevronRight : ChevronDown}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  threadRef?: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}

export default function DiffPanel({
  mode = "inline",
  threadRef: selectedThreadRef,
  composerDraftTarget,
  workspaceMutationId,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const diffLayout = settings.diffLayout;
  const updateClientSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    DIFF_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [baseRefQuery, setBaseRefQuery] = useState("");
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const [codeViewRevision, setCodeViewRevision] = useState(0);
  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const threadRef = selectedThreadRef ?? routeThreadRef;
  const activeThreadId = threadRef?.threadId ?? null;
  const activeThread = useThreadShell(threadRef);
  const activeThreadProjection = useThreadProjection(threadRef)?.projection ?? null;
  const fileAccess = useFilesystemReadAccess(activeThread?.environmentId ?? null);
  const { canReadFiles } = fileAccess;
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const onFileContextMenu = useFileContextMenuHandler(activeThread?.environmentId ?? null);
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByRunId } =
    useTurnDiffSummaries(activeThreadProjection);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[left.runId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[right.runId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByRunId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!threadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      threadRef,
      orderedTurnDiffSummaries.map((summary) => summary.runId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, threadRef]);

  const selectedRunId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope = diffSelection.kind === "unstaged" ? "unstaged" : "branch";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  // A link names one run and shows only that run's diff; the panel's own menu may fall back.
  const isLinkedTurn = diffSelection.kind === "turn" && diffSelection.origin === "link";
  const selectedTurnAttribution =
    diffSelection.kind === "turn" ? (diffSelection.attributedTo ?? null) : null;
  const selectedTurn =
    selectedRunId === null
      ? undefined
      : (findTurnSummary(orderedTurnDiffSummaries, selectedRunId) ??
        (isLinkedTurn ? undefined : orderedTurnDiffSummaries[0]));
  const projectionRuns = activeThreadProjection?.runs;
  const selectedTurnState = useMemo<TurnDiffState | null>(() => {
    const runId = selectedTurn?.runId ?? (isLinkedTurn ? selectedRunId : null);
    if (runId === null) return null;
    // A ready checkpoint of a run this projection does not list still shows its diff.
    if (selectedTurn?.status === "ready" && !projectionRuns?.some((run) => run.id === runId)) {
      return {
        kind: "available",
        turnCount: selectedTurn.checkpointTurnCount,
        fromBaseline: false,
      };
    }
    return turnDiffState({ runId, runs: projectionRuns ?? [], checkpoints: turnDiffSummaries });
  }, [isLinkedTurn, projectionRuns, selectedRunId, selectedTurn, turnDiffSummaries]);
  const turnStateMessage = selectedTurnState ? turnDiffStateMessage(selectedTurnState) : null;
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[selectedTurn.runId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const latestCheckpointedTurn = orderedTurnDiffSummaries.find(
    (summary) => summary.status === "ready",
  );
  const isRunActive = projectionRuns?.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? false;
  const isLatestTurnSelected =
    selectedTurn !== undefined && selectedTurn.runId === latestTurn?.runId;
  const selectedScopeLabel =
    selectedRunId === null
      ? selectedGitScope === "unstaged"
        ? "Uncommitted"
        : "Changes"
      : isLatestTurnSelected
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.runId}` : selectedGitScope;
  const collapseScopeKey = threadRef
    ? `${threadRef.environmentId}:${threadRef.threadId}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedGitScope === "unstaged"
      ? "Uncommitted"
      : "Changes";
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.runId}` : null,
    },
    {
      enabled: isGitRepo && selectedTurn !== undefined && selectedTurnState?.kind === "available",
    },
  );
  // Always read the thread's own folder. When the server refuses it, show that
  // error rather than quietly diffing another folder (such as the service home).
  const branchDiffPreview = useEnvironmentQuery(
    canReadFiles && selectedRunId === null && activeThread && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const canRefreshGitDiff =
    isGitRepo && selectedRunId === null && activeThread != null && activeCwd != null;
  const activeThreadRefreshKey = threadRef
    ? `${threadRef.environmentId}:${threadRef.threadId}`
    : null;

  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === (selectedGitScope === "unstaged" ? "working-tree" : "branch-range"),
  );
  const refreshPreviewQuery = branchDiffPreview.refresh;
  const refreshDiffFromUserAction = refreshPreviewQuery;

  const currentLoadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = branchDiffPreview.data;
    if (selectedRunId !== null || !activeThread || !preview || !selectedGitSource) {
      return undefined;
    }

    if (!canReadFiles) return undefined;
    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: preview.cwd,
      sourceKind: selectedGitSource.kind,
      baseRef: selectedGitSource.baseRef,
      headRef: selectedGitSource.headRef,
      cacheKey: selectedGitSource.diffHash,
    });
  }, [
    activeThread,
    branchDiffPreview.data,
    getDiffFileContents,
    canReadFiles,
    selectedGitSource,
    selectedRunId,
  ]);
  const loadDiffFilesRef = useRef(currentLoadDiffFiles);
  loadDiffFilesRef.current = currentLoadDiffFiles;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const loader = loadDiffFilesRef.current;
    if (!loader) throw new Error("Diff file contents are unavailable for this selection.");
    return loader(fileDiff);
  }, []);
  const localBranchRefs = useEnvironmentQuery(
    selectedRunId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    selectedRunId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== selectedGitSource?.headRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ];
  const gitDiff = selectedGitSource?.diff;

  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff;
  const isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true;
  const isTurnPatchTruncated =
    selectedTurn !== undefined && activeCheckpointDiff.data?.truncated === true;
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const lazySource =
    !selectedTurn && selectedGitSource?.truncated && selectedGitSource.files
      ? selectedGitSource
      : null;
  const renderablePatch = useMemo(
    () =>
      lazySource
        ? null
        : getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
            compactPartialHunkOffsets: selectedRunId === null,
          }),
    [lazySource, resolvedTheme, selectedPatch, selectedRunId],
  );
  const fileStats = useMemo(
    () => new Map(lazySource?.files?.map((file) => [file.path, file])),
    [lazySource?.files],
  );
  const {
    scope: filePatchScope,
    isPending: areFilePatchesPending,
    fileStates,
    retry,
    requestFile,
    readyFilePaths,
    renderableFiles,
    settledFileCount,
    loadNextFiles,
  } = useReviewFilePatches({
    environmentId: activeThread?.environmentId,
    cwd: branchDiffPreview.data?.cwd,
    source: lazySource,
    baseRef: lazySource?.baseRef ?? selectedBaseRef,
    ignoreWhitespace: diffIgnoreWhitespace,
    theme: resolvedTheme,
    revision: branchDiffPreview.data
      ? DateTime.formatIso(branchDiffPreview.data.generatedAt)
      : undefined,
    preview: renderablePatch,
  });
  const refreshBranchDiffPreview = refreshPreviewQuery;

  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshBranchDiffPreview();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshBranchDiffPreview]);

  useWorkspaceMutationRefresh({
    enabled: canRefreshGitDiff,
    mutationId: workspaceMutationId,
    refresh: refreshBranchDiffPreview,
    resourceKey: `diff:${activeThreadRefreshKey ?? ""}`,
  });

  const isRefreshingDiff = branchDiffPreview.isPending || areFilePatchesPending;
  const renderableFileEntries = useMemo(
    () => renderableFiles.map(getCachedFileEntry),
    [renderableFiles],
  );
  const defaultCollapsedDiffFileKeys = useMemo(
    () =>
      settings.diffFilesCollapsed
        ? new Set(renderableFileEntries.map((file) => file.fileKey))
        : EMPTY_COLLAPSED_DIFF_FILE_KEYS,
    [renderableFileEntries, settings.diffFilesCollapsed],
  );
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : defaultCollapsedDiffFileKeys;
  const renderLoadingBoundary = useCallback(
    () =>
      settledFileCount < renderableFiles.length ? (
        <DiffFileLoadingBoundary
          load={loadNextFiles}
          count={renderableFiles.length - settledFileCount}
        />
      ) : null,
    [settledFileCount, renderableFiles.length, loadNextFiles],
  );
  const codeViewFiles = useMemo(
    () =>
      renderableFileEntries
        .filter(({ fileDiff }) => !lazySource || readyFilePaths.has(resolveFileDiffPath(fileDiff)))
        .map(({ fileDiff, fileKey, fileVersion }) => {
          return {
            fileDiff,
            filePath: resolveFileDiffPath(fileDiff),
            fileKey,
            fileVersion,
            // Header-only placeholders use the viewer's collapsed geometry until their patch arrives.
            collapsed:
              collapsedDiffFileKeys.has(fileKey) ||
              fileDiff.cacheKey?.endsWith(":pending") === true,
          };
        }),
    [collapsedDiffFileKeys, renderableFileEntries, lazySource, readyFilePaths],
  );
  const diffFileKeys = useMemo(
    () => renderableFileEntries.map((file) => file.fileKey),
    [renderableFileEntries],
  );
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const diffLineStat = useMemo(() => {
    if (!selectedTurn && selectedGitSource?.files) {
      return selectedGitSource.files.reduce(
        (total, file) => ({
          additions: total.additions + file.additions,
          deletions: total.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
    }
    return getDiffLineStat(renderableFiles);
  }, [renderableFiles, selectedGitSource, selectedTurn]);
  const fileTreeEntries = useMemo(() => diffFileTreeEntries(renderableFiles), [renderableFiles]);
  // Patch paths are relative to the stamped repository root; a link's path is the provider's.
  const turnPathRoots = useMemo<PathRoots>(
    () => ({ repoRoot: selectedTurn?.repoRoot, workspaceRoot: selectedTurn?.cwd ?? activeCwd }),
    [activeCwd, selectedTurn?.cwd, selectedTurn?.repoRoot],
  );
  const linkedDiffFile = useMemo(
    () =>
      selectedTurn && selectedFilePath
        ? resolveLinkedDiffFile(selectedFilePath, renderableFiles, turnPathRoots)
        : null,
    [renderableFiles, selectedFilePath, selectedTurn, turnPathRoots],
  );
  const revealFilePath = lazySource ? selectedFilePath : (linkedDiffFile?.path ?? null);
  const missingLinkedFile = useMemo((): {
    readonly path: string;
    readonly reason: MissingDiffFileReason;
  } | null => {
    if (!selectedTurn || !selectedFilePath || linkedDiffFile) return null;
    if (isLoadingSelectedPatch || !hasResolvedPatch || renderablePatch?.kind === "raw") return null;
    const path = repoRelativePath(selectedFilePath, turnPathRoots) ?? selectedFilePath;
    const folder = selectedTurn.cwd ?? activeCwd;
    if (folder && repoRelativePath(selectedFilePath, { repoRoot: folder }) === null) {
      return { path: selectedFilePath, reason: { kind: "outside_folder", folder } };
    }
    const onCard =
      resolveLinkedDiffFile(
        selectedFilePath,
        selectedTurn.files.map((file) => ({ name: file.path })),
        turnPathRoots,
      ) !== null;
    if (onCard && isTurnPatchTruncated) return { path, reason: { kind: "size_limit" } };
    if (onCard && diffIgnoreWhitespace) return { path, reason: { kind: "whitespace" } };
    return { path, reason: { kind: "not_in_snapshot" } };
  }, [
    activeCwd,
    diffIgnoreWhitespace,
    hasResolvedPatch,
    isLoadingSelectedPatch,
    isTurnPatchTruncated,
    linkedDiffFile,
    renderablePatch?.kind,
    selectedFilePath,
    selectedTurn,
    turnPathRoots,
  ]);
  // Card files the cut patch never reached (AC-08).
  const filesBeyondSizeLimit = useMemo(() => {
    if (!selectedTurn || !isTurnPatchTruncated) return [];
    const inPatch = new Set(
      renderableFiles.flatMap((file) => (file.prevName ? [file.name, file.prevName] : [file.name])),
    );
    return selectedTurn.files.map((file) => file.path).filter((path) => !inPatch.has(path));
  }, [isTurnPatchTruncated, renderableFiles, selectedTurn]);
  const resolveMachineName = useMachineNicknames();
  const capturedOnEnvironmentId = selectedTurn?.capturedOnEnvironmentId;
  const capturedOnMachine = capturedOnEnvironmentId
    ? resolveMachineName(capturedOnEnvironmentId)
    : null;
  const capturedElsewhere =
    capturedOnEnvironmentId !== undefined &&
    activeThread != null &&
    capturedOnEnvironmentId !== activeThread.environmentId;
  const servingMachine =
    capturedElsewhere && activeThread ? resolveMachineName(activeThread.environmentId) : null;
  const selectedDiffFileKey = revealFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === revealFilePath)?.fileKey ?? null)
    : null;

  useEffect(() => {
    if (!selectedDiffFileKey || !codeView?.getInstance()) return;
    codeView.scrollTo({ type: "item", id: selectedDiffFileKey, align: "start" });
  }, [codeView, codeViewMountKey, selectedDiffFileKey, selectedFileRevealRequestId]);

  const treeRevealScope = useMemo(
    () => ({ collapseScopeKey, diffSelection }),
    [collapseScopeKey, diffSelection],
  );
  const requestTreeReveal = useCodeViewFileReveal(
    codeView,
    treeRevealScope,
    codeViewFiles.map((file) => file.fileKey),
  );
  const revealDiffFile = useCallback(
    (filePath: string) => {
      const index = renderableFileEntries.findIndex(
        (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
      );
      const file = renderableFileEntries[index];
      if (!file) return;
      setCollapsedDiffFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
        );
        next.delete(file.fileKey);
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
      if (lazySource && index >= settledFileCount) {
        requestFile(index);
      }
      requestTreeReveal(file.fileKey);
    },
    [
      renderableFileEntries,
      collapseScopeKey,
      defaultCollapsedDiffFileKeys,
      requestTreeReveal,
      lazySource,
      settledFileCount,
      requestFile,
    ],
  );

  // Each link reveals its file once, expanded even when the setting collapses files.
  const externalRevealRef = useRef<{ cache: string | null; key: string } | null>(null);
  const revealCache = lazySource ? filePatchScope : collapseScopeKey;
  const isRevealFileRendered =
    revealFilePath !== null &&
    renderableFileEntries.some(
      (candidate) => resolveFileDiffPath(candidate.fileDiff) === revealFilePath,
    );
  useEffect(() => {
    if (!revealFilePath || !isRevealFileRendered) return;
    const key = `${revealFilePath}:${selectedFileRevealRequestId}`;
    if (externalRevealRef.current?.cache === revealCache && externalRevealRef.current.key === key)
      return;
    externalRevealRef.current = { cache: revealCache, key };
    revealDiffFile(revealFilePath);
  }, [
    isRevealFileRendered,
    revealCache,
    revealDiffFile,
    revealFilePath,
    selectedFileRevealRequestId,
  ]);

  const selectedCheckpointFolder = useMemo(
    () => (selectedTurn ? { cwd: selectedTurn.cwd, repoRoot: selectedTurn.repoRoot } : undefined),
    [selectedTurn],
  );
  // The working tree still matches only the latest snapshot, and only while no run edits it (D-20).
  const opensSelectedTurnVersion =
    selectedTurn !== undefined &&
    selectedTurn.runId === latestCheckpointedTurn?.runId &&
    !isRunActive;
  const openDiffFile = useCallback(
    (filePath: string) => {
      const fileDiff = selectedCheckpointFolder
        ? renderableFileEntries.find(
            (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
          )?.fileDiff
        : undefined;
      const sameFolder =
        resolveDiffFileTarget({
          filePath,
          activeCwd,
          repositoryRoot: activeRepositoryRoot,
          checkpoint: selectedCheckpointFolder,
        })?.otherCheckpointFolder === null;
      const atTurnLine = opensSelectedTurnVersion && sameFolder;
      const line = atTurnLine && fileDiff ? firstChangedNewSideLine(fileDiff) : null;
      const opened = openDiffFilePrimaryAction({
        threadRef,
        filePath,
        activeCwd,
        repositoryRoot: activeRepositoryRoot,
        checkpoint: selectedCheckpointFolder,
        ...(line === null ? {} : { line }),
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(threadRef
                  ? {
                      environmentId: threadRef.environmentId,
                      threadId: threadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
      // The file surface keeps only a relative path, so it shows today's copy in today's folder.
      if (selectedCheckpointFolder && opened && !atTurnLine) {
        toastManager.add({
          type: "info",
          title: CURRENT_FILE_NOTICE,
          ...(opened.otherCheckpointFolder && activeCwd
            ? {
                description: `This turn's snapshot was taken in ${opened.otherCheckpointFolder}; the file opened from ${activeCwd}.`,
              }
            : {}),
        });
      }
    },
    [
      activeCwd,
      activeRepositoryRoot,
      openInPreferredEditor,
      opensSelectedTurnVersion,
      renderableFileEntries,
      selectedCheckpointFolder,
      threadRef,
    ],
  );
  const collapseDefaultsRef = useRef({ collapseScopeKey, defaultCollapsedDiffFileKeys });
  useLayoutEffect(() => {
    collapseDefaultsRef.current = { collapseScopeKey, defaultCollapsedDiffFileKeys };
  }, [collapseScopeKey, defaultCollapsedDiffFileKeys]);
  const toggleDiffFileCollapsed = useCallback((fileKey: string) => {
    const { collapseScopeKey, defaultCollapsedDiffFileKeys } = collapseDefaultsRef.current;
    setCollapsedDiffFiles((current) => {
      const next = new Set(
        current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
      );
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return { scopeKey: collapseScopeKey, fileKeys: next };
    });
  }, []);

  const toggleDiffFileCollapse = useCallback(() => {
    setCodeViewRevision((current) => current + 1);
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys;

      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(diffFileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, defaultCollapsedDiffFileKeys, diffFileKeys]);

  const selectTurn = (runId: RunId) => {
    if (!threadRef) return;
    useDiffPanelStore.getState().selectTurn(threadRef, runId);
  };
  const selectGitScope = (scope: "branch" | "unstaged") => {
    if (!threadRef) return;
    useDiffPanelStore.getState().selectGitScope(threadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!threadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(threadRef, baseRef);
  };
  // The scope menu has two radio groups: the top-level one treats the latest
  // turn as "latest", while the turn sub-menu keys every turn by id so the
  // latest turn is also marked there.
  const selectedTurnValue = selectedTurn ? `turn:${selectedTurn.runId}` : "";
  const selectedScopeValue =
    selectedRunId === null ? selectedGitScope : isLatestTurnSelected ? "latest" : selectedTurnValue;
  const selectScopeValue = (value: string) => {
    if (value === "unstaged" || value === "branch") {
      selectGitScope(value);
    } else if (value === "latest") {
      if (latestTurn) selectTurn(latestTurn.runId);
    } else {
      const turn = orderedTurnDiffSummaries.find((summary) => `turn:${summary.runId}` === value);
      if (turn) selectTurn(turn.runId);
    }
  };

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="secondary" />}
            className="max-w-full"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={selectedScopeValue} onValueChange={selectScopeValue}>
              <DropdownMenuRadioItem value="branch" closeOnClick>
                <span>Changes</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unstaged" closeOnClick>
                <span>Uncommitted</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="latest" closeOnClick>
                <span>Latest turn</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={selectedTurnValue} onValueChange={selectScopeValue}>
                  {orderedTurnDiffSummaries.map((summary) => {
                    const turnCount =
                      summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByRunId[summary.runId] ??
                      "?";
                    return (
                      <DropdownMenuRadioItem
                        key={summary.runId}
                        value={`turn:${summary.runId}`}
                        closeOnClick
                      >
                        <span className="flex items-center gap-2">
                          <span>Turn {turnCount}</span>
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {selectedRunId === null && selectedGitScope === "branch" && selectedGitSource?.baseRef && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={`Comparing ${selectedGitSource.headRef ?? "HEAD"} against ${selectedGitSource.baseRef}`}
          >
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0 items-center gap-2" />}>
                <span className="min-w-0 max-w-48 truncate">
                  {selectedGitSource.headRef ?? "HEAD"}
                </span>
                <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${selectedGitSource.headRef ?? "HEAD"} → ${selectedGitSource.baseRef}`}
              </TooltipPopup>
            </Tooltip>
            <Combobox
              items={baseRefItems}
              filteredItems={filteredBaseRefItems}
              value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
              onOpenChange={(open) => {
                if (!open) setBaseRefQuery("");
              }}
              onValueChange={(value) => {
                if (!value) return;
                selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
              }}
            >
              <ComboboxTrigger
                render={<Button variant="ghost-muted" size="xs" />}
                className="min-w-0 max-w-48"
                aria-label={`Change comparison target. Currently ${selectedGitSource.baseRef}`}
              >
                <span className="min-w-0 truncate">{selectedGitSource.baseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
              >
                <ComboboxSearchInput
                  placeholder="Search refs..."
                  value={baseRefQuery}
                  onChange={(event) => setBaseRefQuery(event.target.value)}
                />
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>Branch</span>
                    <span className="text-right">Remote</span>
                  </div>
                </div>
                <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">Automatic</span>
                  </ComboboxItem>
                  {baseRefChoices.map((choice) => {
                    const item = valueForBaseRefChoice(choice);
                    const hasBoth = choice.local !== null && choice.remote !== null;
                    const useRemote = choice.remote?.name === item;
                    return (
                      <ComboboxItem
                        key={choice.id}
                        className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                        value={item}
                      >
                        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                          <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                          {hasBoth ? (
                            <div
                              className="flex justify-end"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Switch
                                aria-label={`Use remote version of ${choice.label}`}
                                checked={useRemote}
                                className="[--thumb-size:--spacing(3)]"
                                onCheckedChange={(checked) => {
                                  const nextRef = checked
                                    ? choice.remote?.name
                                    : choice.local?.name;
                                  if (nextRef) selectBranchBaseRef(nextRef);
                                }}
                              />
                            </div>
                          ) : choice.remote ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="flex justify-end text-muted-foreground">
                                    <CheckIcon
                                      role="img"
                                      aria-label="Remote only"
                                      className="size-3"
                                    />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">Remote only</TooltipPopup>
                            </Tooltip>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {codeViewFiles.length > 0 || (!selectedTurn && selectedGitSource?.files?.length) ? (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-2xs"
            layout="inline"
          />
        ) : null}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={isRefreshingDiff ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshDiffFromUserAction}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshingDiff ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDiffFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[diffLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </>
  );

  const turnNotices =
    selectedRunId === null ? null : (
      <>
        {selectedTurn ? (
          <TurnProvenanceHeader
            turn={selectedTurn}
            turnCount={selectedCheckpointTurnCount}
            capturedOn={capturedOnMachine}
            servedBy={servingMachine}
          />
        ) : null}
        {selectedTurnAttribution ? (
          <DiffNotice>
            Edited by subagent {selectedTurnAttribution.title} in turn{" "}
            {selectedCheckpointTurnCount ?? "?"}
            {selectedTurnAttribution.running
              ? ". It was still running when this snapshot was taken, so the change may appear in a later turn."
              : ""}
          </DiffNotice>
        ) : null}
        {selectedPatchError && capturedElsewhere && capturedOnMachine ? (
          <DiffNotice tone="warning">
            This turn's snapshot was taken on {capturedOnMachine}
          </DiffNotice>
        ) : null}
        {isTurnPatchTruncated ? (
          <DiffNotice tone="warning">
            <p>Diff truncated at 10 MB</p>
            {filesBeyondSizeLimit.length > 0 ? (
              <ul
                className="mt-1 max-h-24 space-y-0.5 overflow-y-auto"
                aria-label="Files beyond the diff size limit"
              >
                {filesBeyondSizeLimit.map((path) => (
                  <li key={path} className="flex min-w-0">
                    <MiddleTruncate className="min-w-0 font-mono" value={path} />
                    <span className="shrink-0 whitespace-pre">: beyond the diff size limit</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </DiffNotice>
        ) : null}
        {linkedDiffFile?.matchedBy === "file_name" ? (
          <DiffNotice>
            <p className="min-w-0">
              Matched by file name:{" "}
              <MiddleTruncate className="align-bottom font-mono" value={linkedDiffFile.path} />
            </p>
          </DiffNotice>
        ) : null}
        {missingLinkedFile ? (
          <DiffNotice tone="warning">
            <p className="min-w-0">
              <MiddleTruncate className="align-bottom font-mono" value={missingLinkedFile.path} />{" "}
              is not in this diff: {missingDiffFileReasonText(missingLinkedFile.reason)}
              {missingLinkedFile.reason.kind === "whitespace" ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ms-2"
                  onClick={() => setDiffIgnoreWhitespace(false)}
                >
                  Show whitespace changes
                </Button>
              ) : null}
            </p>
          </DiffNotice>
        ) : null}
      </>
    );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedRunId !== null && turnStateMessage !== null ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {turnNotices}
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
            {turnStateMessage}
          </div>
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
          No completed turns yet.
        </div>
      ) : selectedRunId === null && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label="Checking file access..." />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground">
            {fileAccess.error ?? "This connection cannot read local diffs."}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {turnNotices}
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete.
                {selectedGitSource?.files ? " Totals include all changes." : ""}
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-2xs text-error-foreground">{selectedPatchError}</p>
              </div>
            )}
            {!renderablePatch && !lazySource ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    selectedTurn
                      ? "Loading checkpoint diff..."
                      : selectedGitScope === "unstaged"
                        ? "Loading uncommitted changes..."
                        : "Loading changes..."
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : lazySource || renderablePatch?.kind === "files" ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    for (const node of composedPath) {
                      if (!(node instanceof HTMLElement)) continue;
                      // Header controls keep their own actions. In particular, the chevron must
                      // not also trigger the row handler or the two toggles cancel each other.
                      if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                        return;
                      }
                    }
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent;
                    // The filename remains the explicit "open in editor" affordance.
                    if (filePath) {
                      openDiffFile(filePath);
                      return;
                    }
                    const header = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                    );
                    const headerFilePath = header?.querySelector("[data-title]")?.textContent;
                    if (!headerFilePath) return;
                    const file = codeViewFiles.find(
                      (candidate) => candidate.filePath === headerFilePath,
                    );
                    if (file) toggleDiffFileCollapsed(file.fileKey);
                  }}
                  onContextMenuCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    if (!filePath) return;
                    event.preventDefault();
                    // A stamped turn path is first made relative to today's workspace (D-19).
                    const stampedTarget = selectedCheckpointFolder?.cwd
                      ? resolveDiffFileTarget({
                          filePath,
                          activeCwd,
                          checkpoint: selectedCheckpointFolder,
                        })
                      : null;
                    onFileContextMenu(
                      stampedTarget
                        ? {
                            environmentId: activeThread?.environmentId ?? null,
                            filePath: stampedTarget.workspaceFilePath,
                            workspaceRoot: activeCwd,
                          }
                        : {
                            environmentId: activeThread?.environmentId ?? null,
                            filePath,
                            workspaceRoot: activeCwd,
                            repositoryRoot: activeRepositoryRoot,
                          },
                      event,
                    );
                  }}
                >
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={setCodeView}
                    codeViewKey={`${codeViewMountKey}:${lazySource ? filePatchScope : "preview"}`}
                    className="h-full min-h-0 overflow-auto"
                    files={codeViewFiles}
                    renderCodeViewFooter={renderLoadingBoundary}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    renderHeaderFilenameSuffix={(fileDiff) => {
                      const path = resolveFileDiffPath(fileDiff);
                      const state = fileStates.get(path);
                      return (
                        <DiffFileHeaderSuffix
                          filePath={path}
                          hasStat={fileStats.has(path)}
                          error={state?.error ?? false}
                          truncated={state?.truncated ?? false}
                          onRetry={retry}
                        />
                      );
                    }}
                    {...(lazySource
                      ? {
                          unsafeCSSExtra:
                            "[data-additions-count], [data-deletions-count] { display: none; }",
                          renderHeaderMetadata: (fileDiff: FileDiffMetadata) => {
                            const stat = fileStats.get(resolveFileDiffPath(fileDiff));
                            return stat ? (
                              <DiffStatLabel
                                additions={stat.additions}
                                deletions={stat.deletions}
                              />
                            ) : null;
                          },
                        }
                      : {})}
                    renderHeaderPrefix={(fileDiff, fileKey) => {
                      const unavailable = fileDiff.cacheKey?.endsWith(":pending") === true;
                      return (
                        <DiffFileCollapseToggle
                          filePath={resolveFileDiffPath(fileDiff)}
                          fileKey={fileKey}
                          collapsed={unavailable || collapsedDiffFileKeys.has(fileKey)}
                          unavailable={unavailable}
                          iconClassName={getDiffCollapseIconClassName(fileDiff)}
                          onToggle={toggleDiffFileCollapsed}
                        />
                      );
                    }}
                    options={{
                      diffStyle: diffLayout === "split" ? "split" : "unified",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {fileTreeOpen ? (
                  <aside className="flex w-[min(16rem,40%)] min-w-40 shrink-0 border-l border-border/60">
                    <DiffFileTree
                      ariaLabel={`${reviewSectionTitle} files`}
                      entries={fileTreeEntries}
                      selectedPath={revealFilePath}
                      revealRequestId={selectedFileRevealRequestId}
                      onSelectFile={revealDiffFile}
                    />
                  </aside>
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-2xs text-muted-foreground">
                    {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch?.kind === "raw" ? renderablePatch.text : null}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
