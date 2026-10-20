import { ArtifactCards } from "../chat/ThreadArtifacts";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import { requestExecutionLabel } from "../../studio/projectDomain";
import { limitContinuationNote } from "../../studio/runIdentity";
import { modelLabel, shortMachineName } from "../../studio/shellModel";
import { useEnvironment } from "../../state/environments";
import { useProviderEntries } from "./shell/ModelBadge";
import {
  projectCoordinatorMessageDisplay,
  projectMessageAuthor,
  type RoutedFrom,
  isWorkerCompletionWake,
  projectReportMessageIds,
  projectSystemNotice,
  returnedFollowUpIds,
} from "../../studio/projectCoordinatorMessageDisplay";
import { ProjectWorkspaceAttachments } from "./ProjectWorkspaceAttachments";
import { ProjectMessageBody } from "./ProjectMessageBody";
import { CollapsibleReport } from "../chat/CollapsibleReport";
import { shouldCollapseReport } from "../chat/longReport";
import { ReportArtifact } from "../chat/ReportArtifact";
import { CoordinatorRunActivity } from "./CoordinatorRunActivity";
import {
  coordinatorConversationView,
  withFoldedReplies,
  type RunActivity,
} from "../../studio/coordinatorActivity";
import {
  createContext,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDownIcon, ChevronRightIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import {
  coordinatorTurnLayout,
  formatConversationSeparator,
  type CoordinatorTurnLayout,
} from "../../studio/projectCoordinatorTurns";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { viewerIso } from "../../viewerDate";
import type { ChatAttachment, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import type { ThreadLinkTarget } from "@specweave-studio/client-runtime/state/threads";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  useThreadProjection,
  useThreadHistory,
  useThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { ShellRunTargetContext, type ShellRunTarget } from "../chat/InlineShellRun";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useClientSettings } from "../../hooks/useSettings";
import { useTimelineDetail } from "../../timelineDetail";
import { prepareProjectMarkdown } from "../../studio/projectWorkspaceModel";
import { type CoordinatorAttention } from "../../studio/projectCoordinatorThreads";
import { ProjectThreadCard, ProjectThreadChip } from "./ProjectThreadCards";
import { RemoteWorkerCards } from "./RemoteWorkerCards";
import { forgetReadingPlaces, useConversationFollow } from "./useConversationFollow";
import { JumpToLatestButton } from "../chat/JumpToLatestButton";
import { linkedThreadIds, newThreadsByMessage } from "../../studio/projectThreadMentions";
import { resolveStudioThreadLink } from "../../studio/studioThreadLinks";
import { type CoordinatorTurnFailure } from "../../studio/coordinatorTurnState";
import ChatMarkdown, {
  type ChatMarkdownContextReference,
  type ChatMarkdownThreadLink,
} from "../ChatMarkdown";
import { useConversationFindQuery } from "../find/conversationFindStore";
import { useStructuralValue } from "../../hooks/useStructuralValue";
import { formatProgressElapsed, type CoordinatorProgress } from "../../studio/coordinatorProgress";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button, InlineButton } from "../ui/button";

type CoordinatorMessage = NonNullable<
  ReturnType<typeof useThreadProjection>
>["projection"]["messages"][number];

const EMPTY_MESSAGES: readonly CoordinatorMessage[] = [];
const EMPTY_IDS: readonly ThreadId[] = [];

/**
 * How many of the latest messages a conversation mounts at first, and how many
 * more each step up reveals. A long coordinator otherwise mounts its whole
 * history, every message a Markdown tree, in one commit whenever it opens.
 */
export const COORDINATOR_MESSAGE_WINDOW = 30;
const COORDINATOR_MESSAGE_WINDOW_STEP = 40;
/** How many messages each coordinator conversation mounted, for the page's lifetime. */
const keptMessageWindows = new Map<string, number>();

/** Forgets every conversation's kept window and place, as a fresh page load would. */
export function forgetCoordinatorPlaces(): void {
  keptMessageWindows.clear();
  forgetReadingPlaces();
}

/**
 * The project's threads by ID, for the chips, cards and links inside messages.
 * They follow a thread's status from here, so a status change renders them and
 * leaves every message's Markdown as it was.
 */
const CoordinatorThreadsContext = createContext<ReadonlyMap<string, EnvironmentThreadShell>>(
  new Map(),
);

function CoordinatorContexts({
  workers,
  shellRunTarget,
  children,
}: {
  workers: ReadonlyMap<string, EnvironmentThreadShell>;
  shellRunTarget: ShellRunTarget;
  children: React.ReactNode;
}) {
  return (
    <CoordinatorThreadsContext.Provider value={workers}>
      <ShellRunTargetContext value={shellRunTarget}>{children}</ShellRunTargetContext>
    </CoordinatorThreadsContext.Provider>
  );
}

/**
 * The same threads with the same IDs, titles and dates, in any order: all a
 * message's links resolve by. Order is ignored because a status change moves a
 * thread between the list's groups, and links find threads by ID or unique title.
 */
function sameLinkThreads(
  kept: readonly EnvironmentThreadShell[],
  next: readonly EnvironmentThreadShell[],
): boolean {
  if (kept.length !== next.length) return false;
  const byId = new Map(kept.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]));
  return next.every((other) => {
    const thread = byId.get(`${other.environmentId}:${other.id}`);
    return (
      thread !== undefined &&
      thread.projectId === other.projectId &&
      thread.title === other.title &&
      thread.deletedAt === other.deletedAt &&
      thread.createdAt === other.createdAt
    );
  });
}

/**
 * Puts the reader back where they were, measured from the conversation's end,
 * after older messages mounted above them. Chromium keeps that place itself by
 * scroll anchoring, but never from the very top, and a browser without scroll
 * anchoring never does: the conversation would show the oldest of the new
 * messages, and its marker at the top would mount the next ones at once.
 */
function keepDistanceFromEnd(scroller: HTMLElement, fromEnd: number): void {
  const anchored =
    scroller.scrollTop > 0 &&
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("overflow-anchor", "auto");
  if (!anchored) scroller.scrollTop = scroller.scrollHeight - fromEnd;
}

export function CoordinatorConversation({
  project,
  coordinatorId,
  workers,
  environmentThreads,
  onOpenThread,
  canChange,
  onCreatePullRequest,
  onOpenPullRequest,
  attention,
  onOpenCoordinatorPage,
  onOpenCoordinatorActivity,
  failure,
  onRetry,
  retrying,
  retryDisabled,
  progress,
  empty,
}: {
  project: EnvironmentProject;
  coordinatorId: ThreadId;
  workers: readonly EnvironmentThreadShell[];
  /** Every thread of the project's environment, live or deleted, that a link may name. */
  environmentThreads: readonly ThreadLinkTarget[];
  onOpenThread: (id: ThreadId) => void;
  /** Source control can be changed on this host, and it is connected. */
  canChange: boolean;
  onCreatePullRequest: (thread: EnvironmentThreadShell) => void;
  onOpenPullRequest: (url: string) => void;
  /** What the coordinator waits on the person for; native controls open inside this pane. */
  attention: CoordinatorAttention | null;
  /** Opens the coordinator's native review controls inside the main pane. */
  onOpenCoordinatorPage: () => void;
  onOpenCoordinatorActivity: (runId: string) => void;
  /** The coordinator's latest run failed; the host keeps that on the run, not as a message. */
  failure: CoordinatorTurnFailure | null;
  onRetry: () => void;
  retrying: boolean;
  retryDisabled: boolean;
  /** What the coordinator is doing while its turn runs; null when it is idle. */
  progress: CoordinatorProgress | null;
  /** What to say before the first message. */
  empty: React.ReactNode;
}) {
  const ref = useMemo(
    () => scopeThreadRef(project.environmentId, coordinatorId),
    [project.environmentId, coordinatorId],
  );
  const thread = useThreadProjection(ref);
  const coordinatorShell = useThreadShell(ref);
  const history = useThreadHistory(ref);
  const status = useThreadStatus(ref);
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory);
  const allMessages = thread?.projection.messages ?? EMPTY_MESSAGES;
  // A worker finishing wakes the coordinator, but the person sees it on the
  // worker's status and in a notification that opens it, not as a card here.
  const messages = useMemo(
    () => allMessages.filter((message) => !isWorkerCompletionWake(message)),
    [allMessages],
  );
  const executionEnvironment = useEnvironment(project.environmentId);
  // A command in the coordinator's reply runs on the project's host, in its folder.
  const coordinatorRuntimeMode = coordinatorShell?.runtimeMode ?? null;
  const shellRunTarget = useMemo<ShellRunTarget>(
    () => ({
      environmentId: project.environmentId,
      threadId: coordinatorId,
      cwd: project.workspaceRoot,
      worktreePath: null,
      runtimeMode: coordinatorRuntimeMode,
    }),
    [coordinatorId, coordinatorRuntimeMode, project.environmentId, project.workspaceRoot],
  );
  const executionProviders = useProviderEntries(project.environmentId);
  const working = progress !== null && failure === null;
  // A thread the coordinator started this turn is announced by a card under its message;
  // a thread that already existed is a link. Both open the thread in the right pane.
  const reportIds = useMemo(() => projectReportMessageIds(allMessages), [allMessages]);
  // Links resolve by IDs and titles only, so a status change or a resend keeps
  // this list, and with it every message's text and Markdown.
  const linkWorkers = useStructuralValue(workers, sameLinkThreads);
  const workersById = useMemo(
    () => new Map(workers.map((worker) => [worker.id as string, worker])),
    [workers],
  );
  const runs = thread?.projection.runs;
  const turnItems = thread?.projection.turnItems;
  const machineLabel = executionEnvironment?.label ?? project.environmentId;
  const prepared = useMemo(() => {
    const describeRun = (selection: { instanceId: string; model: string }) =>
      modelLabel(
        executionProviders.get(selection.instanceId) ?? null,
        selection.instanceId,
        selection.model,
      );
    return messages.map((message) => {
      // A request the usage-limit rule resent reads as one line, not a second copy of it.
      const notice =
        message.createdBy === "user"
          ? limitContinuationNote(message, runs ?? [], describeRun)
          : projectSystemNotice(message);
      const display = projectCoordinatorMessageDisplay(message, project, linkWorkers);
      const text = prepareProjectMarkdown(notice ?? display.text, linkWorkers, environmentThreads);
      const executionLabel =
        message.createdBy === "user" || message.role === "assistant"
          ? requestExecutionLabel(message, runs ?? [], machineLabel, executionProviders)
          : null;
      return { message, notice, display, text, executionLabel };
    });
  }, [messages, runs, executionProviders, project, linkWorkers, environmentThreads, machineLabel]);
  const timelineDetail = useTimelineDetail(scopedThreadKey(ref));
  // Linear in the history, and only rebuilt when it or the level changes.
  const view = useMemo(
    () =>
      coordinatorConversationView({
        messages: messages.map((message) => ({
          ...message,
          notice: message.createdBy !== "user" && projectSystemNotice(message) !== null,
        })),
        turnItems: turnItems ?? [],
        runs: runs ?? [],
        detail: timelineDetail,
      }),
    [messages, turnItems, runs, timelineDetail],
  );
  // A follow-up the coordinator only passed back to its own worker is left out with its reply.
  const hidden = useMemo(() => {
    const returned = returnedFollowUpIds(messages, project, linkWorkers);
    return returned.size === 0
      ? view.hiddenMessageIds
      : new Set([...view.hiddenMessageIds, ...returned]);
  }, [messages, project, linkWorkers, view]);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Separators, "Worked for" lines and action rows follow the messages that show.
  const turns = useMemo(
    () =>
      coordinatorTurnLayout(
        messages
          .filter((message) => !hidden.has(message.id))
          .map((message) => ({
            id: message.id,
            role: message.role,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            streaming: message.streaming,
            notice: message.createdBy !== "user" && projectSystemNotice(message) !== null,
          })),
      ),
    [messages, hidden],
  );
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id as string, message])),
    [messages],
  );
  const newThreads = useMemo(
    () =>
      newThreadsByMessage(
        prepared.map(({ message, notice, text }) => ({
          id: message.id,
          role: notice === null ? message.role : "system",
          linked: notice === null ? linkedThreadIds(text) : [],
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        })),
        linkWorkers,
      ),
    [prepared, linkWorkers],
  );
  // Concise: a reply that shows carries the cards and files of the replies it hides.
  const rows = useMemo(
    () =>
      prepared
        .filter(({ message }) => !hidden.has(message.id))
        .map((row) => ({
          ...row,
          announcedKey: withFoldedReplies(
            view,
            row.message.id,
            newThreads.get(row.message.id) ?? EMPTY_IDS,
            (id) => newThreads.get(id) ?? EMPTY_IDS,
          ).join("\n"),
          attachments: withFoldedReplies(
            view,
            row.message.id,
            row.message.attachments,
            (id) => messagesById.get(id)?.attachments ?? [],
          ),
          senderTitle: row.message.senderThreadId
            ? (linkWorkers.find((t) => t.id === row.message.senderThreadId)?.title ?? null)
            : null,
        })),
    [prepared, view, hidden, newThreads, messagesById, linkWorkers],
  );
  // Only the latest messages mount; scrolling up or "Show earlier" mounts more.
  // A find in this conversation mounts them all, so every match can be found, and
  // they stay mounted once it closes: the match it went to stays where it is.
  const [scope, setScope] = useState<HTMLDivElement | null>(null);
  // Follows the end only while the reader is there; a reader further up stays put.
  const lastMessage = messages.at(-1);
  const ownSend = messages.findLast(
    (message) =>
      message.createdBy === "user" &&
      message.creationSource === "web" &&
      message.role === "user" &&
      !message.senderThreadId &&
      !message.scheduledTaskId,
  );
  const placeKey = `${project.environmentId}:${coordinatorId}`;
  const latest = useConversationFollow(scope, {
    contentKey: `${messages.length}:${lastMessage?.id}:${lastMessage?.updatedAt}:${working}:${failure?.runId}:${attention?.reason}`,
    ownSendKey: ownSend?.id ?? null,
    resetKey: placeKey,
  });
  const findQuery = useConversationFindQuery(scope);
  // A page unmounted after the reader went further back mounts as many again,
  // so the message they were reading is there to return to.
  const [windowSize, setWindowSize] = useState(
    () => keptMessageWindows.get(placeKey) ?? COORDINATOR_MESSAGE_WINDOW,
  );
  // A reader further up keeps every message mounted: what arrives grows the
  // window instead of pushing the oldest out from above the message they read.
  const [mountedRows, setMountedRows] = useState(rows.length);
  if (rows.length !== mountedRows) {
    setMountedRows(rows.length);
    if (latest.away && rows.length > mountedRows)
      setWindowSize(windowSize + rows.length - mountedRows);
  }
  useEffect(() => {
    keptMessageWindows.set(placeKey, windowSize);
  }, [placeKey, windowSize]);
  if (findQuery && windowSize < rows.length) setWindowSize(rows.length);
  const firstShown = findQuery ? 0 : Math.max(0, rows.length - windowSize);
  // Where the reader was, measured from the end, while older messages are on their
  // way, and how many messages the window held when they were asked for.
  const keptPlace = useRef<{ fromEnd: number; windowSize: number } | null>(null);
  const showEarlier = useCallback(() => {
    if (scope !== null)
      keptPlace.current = {
        fromEnd: scope.scrollHeight - scope.scrollTop,
        windowSize: keptPlace.current?.windowSize ?? windowSize,
      };
    startTransition(() => setWindowSize((size) => size + COORDINATOR_MESSAGE_WINDOW_STEP));
  }, [scope, windowSize]);
  useEffect(() => {
    if (scope === null) return;
    const track = () => {
      const kept = keptPlace.current;
      // A hidden page's conversation reads as scrolled to the top.
      if (scope.clientHeight === 0) return;
      if (kept !== null)
        keptPlace.current = { ...kept, fromEnd: scope.scrollHeight - scope.scrollTop };
    };
    scope.addEventListener("scroll", track, { passive: true });
    return () => scope.removeEventListener("scroll", track);
  }, [scope]);
  // Older messages mounted above the reader: keep the reader's place.
  useLayoutEffect(() => {
    const kept = keptPlace.current;
    if (kept === null || scope === null || windowSize <= kept.windowSize) return;
    keptPlace.current = null;
    keepDistanceFromEnd(scope, kept.fromEnd);
  }, [windowSize, scope]);
  const hasEarlier = firstShown > 0;
  // Scrolling near the top mounts the next older messages. The marker is keyed by
  // the window, so each step observes it afresh and keeps going while the top stays
  // in view. The conversation is the scroller: the margin reaches above its own
  // top only when it is the observer's root.
  const observeEarlier = useCallback(
    (sentinel: HTMLDivElement) => {
      if (typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        (entries) => {
          // A page kept hidden for another project reads as scrolled to its top;
          // mounting older messages then would push the reader back on return.
          if (sentinel.parentElement?.clientHeight === 0) return;
          if (entries.some((entry) => entry.isIntersecting)) showEarlier();
        },
        { root: sentinel.parentElement, rootMargin: "400px 0px 0px 0px" },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    },
    [showEarlier],
  );
  return (
    <CoordinatorContexts workers={workersById} shellRunTarget={shellRunTarget}>
      <div
        ref={setScope}
        className="project-conversation"
        aria-label="Coordinator conversation"
        data-conversation-find-scope=""
        aria-busy={status === "empty" || status === "synchronizing"}
      >
        {hasEarlier ? (
          <div key={firstShown} ref={observeEarlier} data-coordinator-earlier="">
            <Button variant="outline" size="sm" onClick={showEarlier}>
              {firstShown === 1 ? "Show 1 earlier message" : `Show ${firstShown} earlier messages`}
            </Button>
          </div>
        ) : history.hasMoreHistory ? (
          <Button
            variant="outline"
            size="sm"
            disabled={history.loading}
            onClick={() =>
              void load({
                environmentId: project.environmentId,
                input: { threadId: coordinatorId },
              })
            }
          >
            {history.loading ? "Loading…" : "Load earlier messages"}
          </Button>
        ) : null}
        {history.error && <p role="alert">{history.error}</p>}
        {!thread && (
          <p className="project-muted" role="status">
            Loading the retained coordinator…
          </p>
        )}
        {thread && messages.length === 0 && !history.hasMoreHistory ? empty : null}
        {rows.slice(firstShown).map((row) => (
          <CoordinatorMessageRow
            key={row.message.id}
            message={row.message}
            notice={row.notice}
            text={row.text}
            displayText={row.display.text}
            sourceThreadId={row.display.sourceThread?.id ?? null}
            sourceThreadTitle={row.display.sourceThread?.title ?? null}
            routedFrom={row.display.routedFrom}
            senderTitle={row.senderTitle}
            executionLabel={row.executionLabel}
            announcedKey={row.announcedKey}
            attachments={row.attachments}
            turn={turns.get(row.message.id)}
            activity={view.activityByMessageId.get(row.message.id)}
            isReport={reportIds.has(row.message.id)}
            timestampFormat={timestampFormat}
            environmentId={project.environmentId}
            projectId={project.id}
            workspaceRoot={project.workspaceRoot}
            threadRef={ref}
            coordinatorId={coordinatorId}
            linkWorkers={linkWorkers}
            linkTargets={environmentThreads}
            canChange={canChange}
            onOpenThread={onOpenThread}
            onCreatePullRequest={onCreatePullRequest}
            onOpenPullRequest={onOpenPullRequest}
            onOpenCoordinatorPage={onOpenCoordinatorPage}
            onOpenCoordinatorActivity={onOpenCoordinatorActivity}
          />
        ))}
        <RemoteWorkerCards environmentId={project.environmentId} projectId={project.id} />
        {view.liveActivity && working ? (
          <CoordinatorRunActivity
            live
            activity={view.liveActivity}
            onOpenCoordinatorPage={onOpenCoordinatorActivity}
          />
        ) : null}
        {working && <CoordinatorWorking progress={progress} />}
        {attention && attention.reason !== "failed" && (
          <div
            className="project-notice"
            role="status"
            data-coordinator-attention={attention.reason}
          >
            <p>
              <strong>{attention.message}</strong>
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={onOpenCoordinatorPage}>
              {attention.action}
            </Button>
          </div>
        )}
        {failure && (
          <div
            className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm"
            role="alert"
            data-coordinator-failure=""
          >
            <div className="flex items-start gap-3">
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
                aria-hidden
              />
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <p className="font-medium">The coordinator did not answer.</p>
                  <p className="mt-1 leading-relaxed text-muted-foreground">{failure.message}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={retryDisabled || retrying}
                  aria-busy={retrying}
                  onClick={onRetry}
                >
                  <RotateCcwIcon aria-hidden />
                  {retrying ? "Retrying…" : "Retry last message"}
                </Button>
                <details className="text-muted-foreground">
                  <summary className="w-fit cursor-pointer rounded-sm text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                    Error details
                  </summary>
                  <dl className="mt-2 grid gap-1 text-xs">
                    <dt className="font-medium">Run</dt>
                    <dd className="break-all font-mono">{failure.runId}</dd>
                  </dl>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs">{failure.message}</p>
                </details>
              </div>
            </div>
          </div>
        )}
        {latest.away ? (
          <div className="project-conversation-latest" data-coordinator-latest="">
            <JumpToLatestButton unseen={latest.unseen} onJump={latest.jumpToLatest} />
          </div>
        ) : null}
      </div>
    </CoordinatorContexts>
  );
}

/**
 * One message of the conversation. Its props are the message and plain values
 * derived from it, so a keystroke, a send or another thread's update leaves it,
 * and the Markdown inside it, as it was.
 */
const CoordinatorMessageRow = memo(function CoordinatorMessageRow({
  message,
  notice,
  text,
  displayText,
  sourceThreadId,
  sourceThreadTitle,
  routedFrom,
  senderTitle,
  executionLabel,
  announcedKey,
  attachments,
  turn,
  activity,
  isReport,
  timestampFormat,
  environmentId,
  projectId,
  workspaceRoot,
  threadRef,
  coordinatorId,
  linkWorkers,
  linkTargets,
  canChange,
  onOpenThread,
  onCreatePullRequest,
  onOpenPullRequest,
  onOpenCoordinatorPage,
  onOpenCoordinatorActivity,
}: {
  readonly message: CoordinatorMessage;
  /** The one line a resent or system message reads as, instead of its text. */
  readonly notice: string | null;
  readonly text: string;
  /** The text as written, before thread links were resolved. */
  readonly displayText: string;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceThreadTitle: string | null;
  /** Set when the personal assistant routed this request here from its own conversation. */
  readonly routedFrom: RoutedFrom | null;
  readonly senderTitle: string | null;
  readonly executionLabel: string | null;
  /** The threads this message announces with cards, one ID per line. */
  readonly announcedKey: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly turn: CoordinatorTurnLayout | undefined;
  readonly activity: RunActivity | undefined;
  readonly isReport: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly environmentId: EnvironmentProject["environmentId"];
  readonly projectId: EnvironmentProject["id"];
  readonly workspaceRoot: string;
  readonly threadRef: ScopedThreadRef;
  readonly coordinatorId: ThreadId;
  /** The project's threads as links resolve them: IDs and titles, not live state. */
  readonly linkWorkers: readonly EnvironmentThreadShell[];
  readonly linkTargets: readonly ThreadLinkTarget[];
  readonly canChange: boolean;
  readonly onOpenThread: (id: ThreadId) => void;
  readonly onCreatePullRequest: (thread: EnvironmentThreadShell) => void;
  readonly onOpenPullRequest: (url: string) => void;
  readonly onOpenCoordinatorPage: () => void;
  readonly onOpenCoordinatorActivity: (runId: string) => void;
}) {
  const announced = useMemo(
    () => (announcedKey === "" ? EMPTY_IDS : (announcedKey.split("\n") as ThreadId[])),
    [announcedKey],
  );
  // Every thread of this project a message names is a chip with its status dot,
  // including one a card below announces, and opens in the right pane.
  const renderReference = useCallback(
    (reference: ChatMarkdownContextReference) => (
      <CoordinatorReferenceChip
        reference={reference}
        announced={announced}
        onOpenThread={onOpenThread}
      />
    ),
    [announced, onOpenThread],
  );
  // A `studio://thread/` link to another project's thread, or to one that is gone,
  // falls back to the standard chip, which opens it elsewhere or says why it cannot.
  // A link to this coordinator reads as its label: the page already shows it.
  const renderThreadLink = useCallback(
    (link: ChatMarkdownThreadLink) => {
      if (link.candidates.includes(coordinatorId)) return <span>{link.label}</span>;
      const resolved = resolveStudioThreadLink(
        linkWorkers,
        link.candidates,
        link.label,
        null,
        linkTargets,
      );
      return resolved.kind === "thread" ? (
        <CoordinatorWorkerChip
          threadId={resolved.id}
          label={link.label}
          announced={announced.includes(resolved.id)}
          onOpenThread={onOpenThread}
        />
      ) : null;
    },
    [announced, coordinatorId, linkWorkers, linkTargets, onOpenThread],
  );
  // A centered time line where the conversation picks up after a pause.
  const separator = turn?.separatorAt ? (
    <p className="sws-turn-separator">
      <time dateTime={turn.separatorAt}>
        {formatConversationSeparator(turn.separatorAt, (iso) =>
          formatShortTimestamp(iso, timestampFormat),
        )}
      </time>
    </p>
  ) : null;
  if (notice !== null)
    return (
      <>
        {separator}
        <div className="project-inline-notice" role="status" data-follow-anchor={message.id}>
          <ChatMarkdown
            formatDates={message.role === "assistant"}
            text={text}
            cwd={workspaceRoot}
            threadRef={threadRef}
            isStreaming={false}
            renderContextReference={renderReference}
            renderThreadLink={renderThreadLink}
          />
        </div>
      </>
    );
  const author = projectMessageAuthor(message);
  const runId = message.runId;
  return (
    <>
      {separator}
      <article
        className={`project-message project-message-${message.role}`}
        data-follow-anchor={message.id}
      >
        <h3>{author}</h3>
        {turn?.workedFor ? (
          // The turn's tool calls live on the coordinator's page, like a folded turn.
          <button
            type="button"
            className="sws-turn-summary"
            onClick={() => (runId ? onOpenCoordinatorActivity(runId) : onOpenCoordinatorPage())}
          >
            <span>{turn.workedFor}</span>
            <ChevronRightIcon aria-hidden />
          </button>
        ) : null}
        {executionLabel !== null ? (
          <p className="project-muted" data-request-execution>
            {executionLabel}
          </p>
        ) : null}
        {author === "Message from a worker" && message.senderThreadId && (
          <MessageThreadLink
            threadId={message.senderThreadId}
            prefix="Sent by"
            fallbackLabel="View sending thread"
            onOpen={() => onOpenThread(message.senderThreadId!)}
          />
        )}
        {routedFrom !== null && (
          <p className="project-muted" data-routed-from>
            Routed by {routedFrom.assistantTitle}
            {routedFrom.note ? ` · ${routedFrom.note}` : ""}
          </p>
        )}
        {sourceThreadId !== null && (
          <MessageThreadLink
            threadId={sourceThreadId}
            prefix="From"
            fallbackLabel={`From ${sourceThreadTitle}`}
            fallbackAriaLabel={`Open source thread ${sourceThreadTitle}`}
            onOpen={() => onOpenThread(sourceThreadId)}
          />
        )}
        {author === "Message from a worker" &&
        isReport &&
        !message.streaming &&
        shouldCollapseReport(text) ? (
          <ReportArtifact
            createdAt={viewerIso(message.createdAt) ?? undefined}
            source={
              message.senderThreadId
                ? { environmentId, projectId, threadId: message.senderThreadId }
                : null
            }
            text={text}
            fallbackTitle={senderTitle ?? "Worker report"}
            renderMarkdown={(part) => (
              <ChatMarkdown
                formatDates={message.role === "assistant"}
                text={part}
                cwd={workspaceRoot}
                threadRef={threadRef}
                isStreaming={false}
                renderContextReference={renderReference}
                renderThreadLink={renderThreadLink}
              />
            )}
            renderAttachments={() => (
              <ArtifactCards threadRef={threadRef} cwd={workspaceRoot} text={text} />
            )}
          >
            <ChatMarkdown
              formatDates={message.role === "assistant"}
              text={text}
              cwd={workspaceRoot}
              threadRef={threadRef}
              isStreaming={false}
              renderContextReference={renderReference}
              renderThreadLink={renderThreadLink}
            />
          </ReportArtifact>
        ) : (
          <ProjectMessageBody
            text={displayText}
            // A worker's answer follows the report rule, not the fold for the person's own prompts.
            collapsible={message.role === "user" && author !== "Message from a worker"}
          >
            <CollapsibleReport
              text={text}
              streaming={message.streaming}
              enabled={message.role !== "user" && isReport}
              expandLabel="Show full message"
            >
              <ChatMarkdown
                formatDates={message.role === "assistant"}
                text={text}
                cwd={workspaceRoot}
                threadRef={threadRef}
                isStreaming={message.streaming}
                lineBreaks={message.role === "user"}
                parseRawHtml={message.role !== "user"}
                renderContextReference={renderReference}
                renderThreadLink={renderThreadLink}
              />
            </CollapsibleReport>
          </ProjectMessageBody>
        )}
        {announced.length > 0 ? (
          <ul className="sws-thread-cards" aria-label="Threads started">
            {announced.map((id) => (
              <AnnouncedThreadCard
                key={id}
                threadId={id}
                projectRoot={workspaceRoot}
                canChange={canChange}
                onOpenThread={onOpenThread}
                onCreatePullRequest={onCreatePullRequest}
                onOpenPullRequest={onOpenPullRequest}
              />
            ))}
          </ul>
        ) : null}
        <ProjectWorkspaceAttachments environmentId={environmentId} attachments={attachments} />
        {activity ? (
          <CoordinatorRunActivity
            activity={activity}
            onOpenCoordinatorPage={onOpenCoordinatorActivity}
          />
        ) : null}
        {turn?.endsTurn ? (
          <div className="sws-turn-actions">
            <MessageCopyButton text={text} variant="ghost" size="icon-xs" />
            {turn.settledAt ? (
              <Tooltip>
                <TooltipTrigger render={<time dateTime={turn.settledAt} tabIndex={0} />}>
                  {formatShortTimestamp(turn.settledAt, timestampFormat)}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(turn.settledAt, timestampFormat)}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </article>
    </>
  );
});

/** A thread of this project a message names: a chip with its live status dot. */
function CoordinatorWorkerChip({
  threadId,
  label,
  announced,
  onOpenThread,
}: {
  threadId: ThreadId;
  label: string;
  /** A card below this message announces the thread too. */
  announced: boolean;
  onOpenThread: (id: ThreadId) => void;
}) {
  const thread = useContext(CoordinatorThreadsContext).get(threadId);
  if (!thread) return <span>{label}</span>;
  return (
    <ProjectThreadChip
      thread={thread}
      label={label}
      className={announced ? "sws-thread-mention" : undefined}
      onOpen={() => onOpenThread(thread.id)}
    />
  );
}

/** A `studio-context://` reference: a chip for one of this project's threads, else its label. */
function CoordinatorReferenceChip({
  reference,
  announced,
  onOpenThread,
}: {
  reference: ChatMarkdownContextReference;
  announced: readonly ThreadId[];
  onOpenThread: (id: ThreadId) => void;
}) {
  // `workers` holds no coordinator, so a link to it reads as its label.
  const thread = useContext(CoordinatorThreadsContext).get(reference.contextId);
  if (reference.kind !== "thread" || !thread) return <span>{reference.label}</span>;
  return (
    <ProjectThreadChip
      thread={thread}
      label={reference.label}
      className={announced.includes(thread.id) ? "sws-thread-mention" : undefined}
      onOpen={() => onOpenThread(thread.id)}
    />
  );
}

/** The card under the message that started a thread, with that thread's live state. */
function AnnouncedThreadCard({
  threadId,
  projectRoot,
  canChange,
  onOpenThread,
  onCreatePullRequest,
  onOpenPullRequest,
}: {
  threadId: ThreadId;
  projectRoot: string;
  canChange: boolean;
  onOpenThread: (id: ThreadId) => void;
  onCreatePullRequest: (thread: EnvironmentThreadShell) => void;
  onOpenPullRequest: (url: string) => void;
}) {
  const thread = useContext(CoordinatorThreadsContext).get(threadId);
  if (!thread) return null;
  return (
    <li>
      <ProjectThreadCard
        thread={thread}
        projectRoot={projectRoot}
        canChange={canChange}
        onOpen={() => onOpenThread(threadId)}
        onCreatePullRequest={() => onCreatePullRequest(thread)}
        onOpenPullRequest={onOpenPullRequest}
      />
    </li>
  );
}

/**
 * The thread a message came from, above the message: a chip with its status dot
 * when it is one of the project's threads, else the plain link it always was
 * (the coordinator is not one of `workers`, and opens as the main conversation).
 */
function MessageThreadLink({
  threadId,
  prefix,
  fallbackLabel,
  fallbackAriaLabel,
  onOpen,
}: {
  threadId: ThreadId;
  prefix: string;
  fallbackLabel: string;
  fallbackAriaLabel?: string;
  onOpen: () => void;
}) {
  const thread = useContext(CoordinatorThreadsContext).get(threadId);
  if (thread)
    return (
      <span className="project-message-source">
        {prefix}{" "}
        <ProjectThreadChip
          thread={thread}
          label={thread.title.trim() || "Untitled thread"}
          onOpen={onOpen}
        />
      </span>
    );
  return (
    <InlineButton aria-label={fallbackAriaLabel} onClick={onOpen}>
      {fallbackLabel}
    </InlineButton>
  );
}

/** The coordinator's live line: what it is doing and for how long, counting every second. */
function CoordinatorWorking({ progress }: { progress: CoordinatorProgress }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="sws-coordinator-working" role="status" aria-live="polite">
      <span className="sws-dot" data-tone={progress.waiting ? "waiting" : "working"} aria-hidden />
      <span className="sws-coordinator-working-label">{progress.label}…</span>
      {progress.since === null ? null : (
        <span className="sws-coordinator-working-time" aria-hidden>
          {formatProgressElapsed(progress.since, now)}
        </span>
      )}
    </div>
  );
}

/**
 * The machine this coordinator runs on. Its server starts the coordinator and
 * workers with that machine's providers and sign-ins, so with the project on
 * more than one machine the name opens a choice that is saved for the project.
 */
export function CoordinatorMachine({
  label,
  connected,
  disconnectedLabel = "Disconnected",
  current,
  checkouts,
  savedMachineMissing,
  onChoose,
}: {
  label: string;
  connected: boolean;
  disconnectedLabel?: string;
  current: string;
  checkouts: ReadonlyArray<{ key: string; machine: string; folder: string }>;
  savedMachineMissing: boolean;
  onChoose: ((key: string) => void) | null;
}) {
  const status = (
    <>
      <span className="sws-dot" data-tone={connected ? "resolved" : "failed"} aria-hidden />
      <span className="sws-host-name" title={label}>
        {shortMachineName(label)}
      </span>
      <span className="sr-only">
        {connected ? ", connected" : `, ${disconnectedLabel.toLowerCase()}`}
      </span>
      {connected ? null : <span aria-hidden> · {disconnectedLabel}</span>}
      {savedMachineMissing ? <span aria-hidden> · Saved machine offline</span> : null}
    </>
  );
  if (checkouts.length < 2 || !onChoose)
    return <span className="project-muted sws-host">{status}</span>;
  // Two checkouts on one machine need their folders to tell them apart.
  const savedCheckouts = checkouts.filter((checkout) => isProjectFolder(checkout.folder));
  const machines = savedCheckouts.map((checkout) => checkout.machine);
  const ambiguous = (machine: string) =>
    machines.indexOf(machine) !== machines.lastIndexOf(machine);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="xs"
                  className="project-muted sws-host sws-host-pick"
                  aria-label={`Coordinator runs on ${label}. Choose the machine`}
                />
              }
            />
          }
        >
          {status}
          <ChevronDownIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {savedMachineMissing
            ? "The saved machine is not connected, so this is another machine's coordinator"
            : "Choose which machine runs this project's coordinator"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Coordinator machine</MenuGroupLabel>
          <MenuRadioGroup value={current} onValueChange={(value) => onChoose(value as string)}>
            {savedCheckouts.map((checkout) => (
              <MenuRadioItem key={checkout.key} value={checkout.key}>
                <span className="flex items-center justify-between gap-6">
                  {ambiguous(checkout.machine)
                    ? `${checkout.machine} · ${checkout.folder}`
                    : checkout.machine}
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
