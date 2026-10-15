import { isProjectFolder } from "../../studio/projectMachineFolders";
import { requestExecutionLabel } from "../../studio/projectDomain";
import { useEnvironment } from "../../state/environments";
import {
  projectCoordinatorMessageDisplay,
  projectMessageAuthor,
  isWorkerCompletionWake,
  projectReportMessageIds,
  projectSystemNotice,
} from "../../studio/projectCoordinatorMessageDisplay";
import { ProjectWorkspaceAttachments } from "./ProjectWorkspaceAttachments";
import { ProjectMessageBody } from "./ProjectMessageBody";
import { CollapsibleReport } from "../chat/CollapsibleReport";
import { shouldCollapseReport } from "../chat/longReport";
import { ReportArtifact } from "../chat/ReportArtifact";
import { CoordinatorRunActivity } from "./CoordinatorRunActivity";
import { coordinatorConversationView, withFoldedReplies } from "../../studio/coordinatorActivity";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import {
  coordinatorTurnLayout,
  formatConversationSeparator,
} from "../../studio/projectCoordinatorTurns";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { type ThreadId } from "@specweave-studio/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useThreadProjection, useThreadHistory, useThreadStatus } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useClientSettings } from "../../hooks/useSettings";
import { prepareProjectMarkdown } from "../../studio/projectWorkspaceModel";
import { type CoordinatorAttention } from "../../studio/projectCoordinatorThreads";
import { ProjectThreadCard, ProjectThreadChip } from "./ProjectThreadCards";
import { RemoteWorkerCards } from "./RemoteWorkerCards";
import { linkedThreadIds, newThreadsByMessage } from "../../studio/projectThreadMentions";
import { resolveStudioThreadLink } from "../../studio/studioThreadLinks";
import { type CoordinatorTurnFailure } from "../../studio/coordinatorTurnState";
import ChatMarkdown from "../ChatMarkdown";
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
  environmentThreads: readonly EnvironmentThreadShell[];
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
  const history = useThreadHistory(ref);
  const status = useThreadStatus(ref);
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory);
  const end = useRef<HTMLDivElement>(null);
  const allMessages = thread?.projection.messages ?? [];
  // A worker finishing wakes the coordinator, but the person sees it on the
  // worker's status and in a notification that opens it, not as a card here.
  const messages = useMemo(
    () => allMessages.filter((message) => !isWorkerCompletionWake(message)),
    [allMessages],
  );
  const executionEnvironment = useEnvironment(project.environmentId);
  const working = progress !== null && failure === null;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, failure?.runId, working]);
  // A thread the coordinator started this turn is announced by a card under its message;
  // a thread that already existed is a link. Both open the thread in the right pane.
  const reportIds = useMemo(() => projectReportMessageIds(allMessages), [allMessages]);
  const prepared = messages.map((message) => {
    const notice = message.createdBy === "user" ? null : projectSystemNotice(message);
    const display = projectCoordinatorMessageDisplay(message, project, workers);
    const text = prepareProjectMarkdown(notice ?? display.text, workers, environmentThreads);
    return { message, notice, display, text };
  });
  const timelineDetail = useClientSettings((settings) => settings.timelineDetail);
  const turnItems = thread?.projection.turnItems;
  const runs = thread?.projection.runs;
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
    [messages, workers, turnItems, runs, timelineDetail],
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Separators, "Worked for" lines and action rows follow the messages that show.
  const turns = useMemo(
    () =>
      coordinatorTurnLayout(
        messages
          .filter((message) => !view.hiddenMessageIds.has(message.id))
          .map((message) => ({
            id: message.id,
            role: message.role,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            streaming: message.streaming,
            notice: message.createdBy !== "user" && projectSystemNotice(message) !== null,
          })),
      ),
    [messages, view],
  );
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id as string, message])),
    [messages],
  );
  const newThreads = newThreadsByMessage(
    prepared.map(({ message, notice, text }) => ({
      id: message.id,
      role: notice === null ? message.role : "system",
      linked: notice === null ? linkedThreadIds(text) : [],
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    workers,
  );
  // Every thread of this project a message names is a chip with its status dot,
  // including one a card below announces, and opens in the right pane.
  const workerChip = (
    target: EnvironmentThreadShell,
    label: string,
    announced: readonly ThreadId[],
  ) => (
    <ProjectThreadChip
      thread={target}
      label={label}
      className={announced.includes(target.id) ? "sws-thread-mention" : undefined}
      onOpen={() => onOpenThread(target.id)}
    />
  );
  const referenceRenderer =
    (announced: readonly ThreadId[]) =>
    (reference: { kind: string; contextId: string; label: string }) => {
      // `workers` holds no coordinator, so a link to it reads as its label.
      const target = workers.find((t) => t.id === reference.contextId);
      if (reference.kind !== "thread" || !target) return <span>{reference.label}</span>;
      return workerChip(target, reference.label, announced);
    };
  // A `studio://thread/` link to another project's thread, or to one that is gone,
  // falls back to the standard chip, which opens it elsewhere or says why it cannot.
  // A link to this coordinator reads as its label: the page already shows it.
  const threadLinkRenderer =
    (announced: readonly ThreadId[]) =>
    (link: { candidates: readonly string[]; label: string }) => {
      if (link.candidates.includes(coordinatorId)) return <span>{link.label}</span>;
      const resolved = resolveStudioThreadLink(
        workers,
        link.candidates,
        link.label,
        null,
        environmentThreads,
      );
      return resolved.kind === "thread" ? workerChip(resolved.shell, link.label, announced) : null;
    };
  return (
    <div
      className="project-conversation"
      aria-label="Coordinator conversation"
      data-conversation-find-scope=""
      aria-busy={status === "empty" || status === "synchronizing"}
    >
      {history.hasMoreHistory && (
        <Button
          variant="outline"
          size="sm"
          disabled={history.loading}
          onClick={() =>
            void load({ environmentId: project.environmentId, input: { threadId: coordinatorId } })
          }
        >
          {history.loading ? "Loading…" : "Load earlier messages"}
        </Button>
      )}
      {history.error && <p role="alert">{history.error}</p>}
      {!thread && (
        <p className="project-muted" role="status">
          Loading the retained coordinator…
        </p>
      )}
      {thread && messages.length === 0 && !history.hasMoreHistory ? empty : null}
      {prepared.map(({ message, notice, display, text }) => {
        if (view.hiddenMessageIds.has(message.id)) return null;
        // Concise: a reply that shows carries the cards and files of the replies it hides.
        const announced = withFoldedReplies(
          view,
          message.id,
          newThreads.get(message.id) ?? [],
          (id) => newThreads.get(id) ?? [],
        );
        const attachments = withFoldedReplies(
          view,
          message.id,
          message.attachments,
          (id) => messagesById.get(id)?.attachments ?? [],
        );
        const renderReference = referenceRenderer(announced);
        const renderThreadLink = threadLinkRenderer(announced);
        const turn = turns.get(message.id);
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
            <Fragment key={message.id}>
              {separator}
              <div className="project-inline-notice" role="status">
                <ChatMarkdown
                  formatDates={message.role === "assistant"}
                  text={text}
                  cwd={project.workspaceRoot}
                  threadRef={ref}
                  isStreaming={false}
                  renderContextReference={renderReference}
                  renderThreadLink={renderThreadLink}
                />
              </div>
            </Fragment>
          );
        const author = projectMessageAuthor(message);
        const runId = message.runId;
        return (
          <Fragment key={message.id}>
            {separator}
            <article className={`project-message project-message-${message.role}`}>
              <h3>{author}</h3>
              {turn?.workedFor ? (
                // The turn's tool calls live on the coordinator's page, like a folded turn.
                <button
                  type="button"
                  className="sws-turn-summary"
                  onClick={() =>
                    runId ? onOpenCoordinatorActivity(runId) : onOpenCoordinatorPage()
                  }
                >
                  <span>{turn.workedFor}</span>
                  <ChevronRightIcon aria-hidden />
                </button>
              ) : null}
              {message.createdBy === "user" || message.role === "assistant" ? (
                <p className="project-muted" data-request-execution>
                  {requestExecutionLabel(
                    message,
                    thread?.projection.runs ?? [],
                    executionEnvironment?.label ?? project.environmentId,
                  )}
                </p>
              ) : null}
              {author === "Message from a worker" && message.senderThreadId && (
                <MessageThreadLink
                  thread={workers.find((t) => t.id === message.senderThreadId)}
                  prefix="Sent by"
                  fallbackLabel="View sending thread"
                  onOpen={() => onOpenThread(message.senderThreadId!)}
                />
              )}
              {display.sourceThread && (
                <MessageThreadLink
                  thread={workers.find((t) => t.id === display.sourceThread!.id)}
                  prefix="From"
                  fallbackLabel={`From ${display.sourceThread.title}`}
                  fallbackAriaLabel={`Open source thread ${display.sourceThread.title}`}
                  onOpen={() => onOpenThread(display.sourceThread!.id)}
                />
              )}
              {author === "Message from a worker" &&
              reportIds.has(message.id) &&
              !message.streaming &&
              shouldCollapseReport(text) ? (
                <ReportArtifact
                  source={
                    message.senderThreadId
                      ? {
                          environmentId: project.environmentId,
                          projectId: project.id,
                          threadId: message.senderThreadId,
                        }
                      : null
                  }
                  text={text}
                  fallbackTitle={
                    workers.find((t) => t.id === message.senderThreadId)?.title ?? "Worker report"
                  }
                  renderMarkdown={(part) => (
                    <ChatMarkdown
                      formatDates={message.role === "assistant"}
                      text={part}
                      cwd={project.workspaceRoot}
                      threadRef={ref}
                      isStreaming={false}
                      renderContextReference={renderReference}
                      renderThreadLink={renderThreadLink}
                    />
                  )}
                >
                  <ChatMarkdown
                    formatDates={message.role === "assistant"}
                    text={text}
                    cwd={project.workspaceRoot}
                    threadRef={ref}
                    isStreaming={false}
                    renderContextReference={renderReference}
                    renderThreadLink={renderThreadLink}
                  />
                </ReportArtifact>
              ) : (
                <ProjectMessageBody text={display.text} collapsible={message.role === "user"}>
                  <CollapsibleReport
                    text={text}
                    streaming={message.streaming}
                    enabled={message.role !== "user" && reportIds.has(message.id)}
                    expandLabel="Show full message"
                  >
                    <ChatMarkdown
                      formatDates={message.role === "assistant"}
                      text={text}
                      cwd={project.workspaceRoot}
                      threadRef={ref}
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
                  {announced.map((id) => {
                    const thread = workers.find((t) => t.id === id)!;
                    return (
                      <li key={id}>
                        <ProjectThreadCard
                          thread={thread}
                          projectRoot={project.workspaceRoot}
                          canChange={canChange}
                          onOpen={() => onOpenThread(id)}
                          onCreatePullRequest={() => onCreatePullRequest(thread)}
                          onOpenPullRequest={onOpenPullRequest}
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <ProjectWorkspaceAttachments
                environmentId={project.environmentId}
                attachments={attachments}
              />
              {view.activityByMessageId.has(message.id) ? (
                <CoordinatorRunActivity
                  activity={view.activityByMessageId.get(message.id)!}
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
          </Fragment>
        );
      })}
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
        <div className="project-notice" role="status" data-coordinator-attention={attention.reason}>
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
      <div ref={end} data-coordinator-end="" />
    </div>
  );
}

/**
 * The thread a message came from, above the message: a chip with its status dot
 * when it is one of the project's threads, else the plain link it always was
 * (the coordinator is not one of `workers`, and opens as the main conversation).
 */
function MessageThreadLink({
  thread,
  prefix,
  fallbackLabel,
  fallbackAriaLabel,
  onOpen,
}: {
  thread: EnvironmentThreadShell | undefined;
  prefix: string;
  fallbackLabel: string;
  fallbackAriaLabel?: string;
  onOpen: () => void;
}) {
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
  current,
  checkouts,
  savedMachineMissing,
  onChoose,
}: {
  label: string;
  connected: boolean;
  current: string;
  checkouts: ReadonlyArray<{ key: string; machine: string; folder: string }>;
  savedMachineMissing: boolean;
  onChoose: ((key: string) => void) | null;
}) {
  const status = (
    <>
      <span className="sws-dot" data-tone={connected ? "resolved" : "failed"} aria-hidden />
      <span className="sws-host-name">{label}</span>
      <span className="sr-only">{connected ? ", connected" : ", disconnected"}</span>
      {connected ? null : <span aria-hidden> · Disconnected</span>}
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
