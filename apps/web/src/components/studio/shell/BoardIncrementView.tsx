/**
 * The board's increment view: what a card click opens. One scroll, most
 * urgent first: header and actions, why it is stuck, why it sits in its
 * column, the threads on it, its tasks, criteria, pull requests and the
 * Problem. It opens at once with what the card and the thread list already
 * hold, then fills in from `projects.boardIncrement`; every missing part says
 * what is missing in one sentence. A labelled region, not a dialog: the board
 * beside it stays usable.
 */
import type {
  EnvironmentId,
  ProjectBoardBlocker,
  ProjectBoardCard,
  ProjectBoardIncrementResult,
  ProjectId,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  FileTextIcon,
  MessageSquareIcon,
  PauseIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import {
  BOARD_VIEW_REFRESH_MS,
  CRITERION_STATE_LABELS,
  TASK_STATUS_LABELS,
  blockerActions,
  columnWhy,
  criteriaSummary,
  criterionState,
  problemSummary,
  taskHolder,
  taskIsClosed,
  threadTaskLabel,
  threadsAtWork,
  viewCoordinatorPrompt,
  viewPrimaryAction,
  viewTaskOrder,
  viewThreadSections,
} from "../../../studio/boardIncrementModel";
import {
  BOARD_COLUMN_LABELS,
  boardCardPaused,
  boardCardTitle,
  boardNoteText,
  boardProgress,
  boardOutOfReachNote,
  incrementNumber,
  pullRequestLabel,
  threadIsLive,
} from "../../../studio/projectBoardModel";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import { THREAD_TONE_LABELS, compactAge } from "../../../studio/shellModel";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { BoardMachineMark, type BoardThread } from "./BoardThreads";

export interface BoardViewFile {
  readonly path: string;
  readonly name: string;
}

export interface BoardIncrementViewProps {
  /** The region's id; the open card points at it. */
  id: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  incrementId: string;
  /** The card as the board holds it; null when it is not among the cards on screen. */
  card: ProjectBoardCard | null;
  /** The serving machine answers the detail read; an older one does not. */
  supported: boolean;
  /** Its threads, not its files, put it in Active. */
  movedByThreads: boolean;
  threads: ReadonlyArray<BoardThread>;
  showMachine: boolean;
  /** "Merged", "Open"… for the pull requests the project's threads know. */
  pullRequestStates: ReadonlyMap<string, string>;
  now: number;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  onClose: () => void;
  /** The previous (-1) or next (1) card in board order; null when there is none. */
  onStep: { readonly previous: (() => void) | null; readonly next: (() => void) | null };
  onOpenThread: (thread: EnvironmentThreadShell) => void;
  onOpenLink: (url: string) => void;
  onOpenFiles: (files: ReadonlyArray<BoardViewFile>, path: string) => void;
  /** Puts a request in the coordinator's composer; absent when the person cannot send. */
  onAsk?: ((prompt: string) => void) | undefined;
}

const longDate = (iso: string) => {
  const time = Date.parse(iso);
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : iso;
};
const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return null;
  const age = compactAge(iso, now);
  return age === "" ? null : age === "now" ? "just now" : `${age} ago`;
};

function Section(props: {
  title: string;
  note?: string | null | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sws-board-view-section" aria-label={props.title}>
      <h4 className="sws-board-view-heading">
        <span>{props.title}</span>
        {props.note ? <span className="sws-board-view-heading-note">{props.note}</span> : null}
        {props.action ? (
          <span className="sws-board-view-heading-action">{props.action}</span>
        ) : null}
      </h4>
      {props.children}
    </section>
  );
}

export function BoardIncrementView(props: BoardIncrementViewProps) {
  const { incrementId, threads, now, onAsk } = props;
  const [includeDone, setIncludeDone] = useState(false);
  const [allThreads, setAllThreads] = useState(false);
  const [finishedThreads, setFinishedThreads] = useState(false);
  // Another card: its own done tasks and thread list start folded again.
  const [shownFor, setShownFor] = useState(incrementId);
  if (shownFor !== incrementId) {
    setShownFor(incrementId);
    setIncludeDone(false);
    setAllThreads(false);
    setFinishedThreads(false);
  }
  const { environmentId, projectId, supported } = props;
  const query = useEnvironmentQuery(
    useMemo(
      () =>
        supported
          ? projectWorkspace.boardIncrement({
              environmentId,
              input: { projectId, incrementId, ...(includeDone ? { includeDone: true } : {}) },
            })
          : null,
      [environmentId, includeDone, incrementId, projectId, supported],
    ),
  );
  // Asking for the done tasks starts a new read; keep the last answer for this
  // increment on screen until it lands.
  const [held, setHeld] = useState<ProjectBoardIncrementResult | null>(null);
  if (query.data && query.data !== held) setHeld(query.data);
  const answer = held !== null && held.incrementId === incrementId ? held : null;
  const detail = answer?.increment ?? null;
  const missing = answer !== null && answer.increment === null;
  const card = props.card ?? detail?.card ?? null;

  const refresh = query.refresh;
  const atWork = threadsAtWork(threads);
  // The board's own refresh brought a newer change for this card.
  const cardChangedAt = props.card?.updatedAt ?? null;
  const seen = useRef({ incrementId, cardChangedAt });
  useEffect(() => {
    const before = seen.current;
    seen.current = { incrementId, cardChangedAt };
    if (supported && before.incrementId === incrementId && before.cardChangedAt !== cardChangedAt)
      refresh();
  }, [cardChangedAt, incrementId, refresh, supported]);
  useEffect(() => {
    if (!supported || atWork === 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, BOARD_VIEW_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [atWork, refresh, supported]);

  const number = incrementNumber(incrementId);
  const title = card ? boardCardTitle(card) : boardCardTitle({ incrementId, title: null });
  const headingId = `${props.id}-title`;
  const tasks = detail?.tasks ?? [];
  const liveThreads = threads.filter((thread) => threadIsLive(thread.tone));
  const lead = liveThreads[0] ?? null;
  const abandoned = detail?.abandoned === true;
  const done = card?.column === "done";
  const paused = card !== null && boardCardPaused(card) && !done;
  // A removed increment has nothing left to start, resume or open.
  const primary =
    card && !missing
      ? viewPrimaryAction({ card, abandoned, liveThreads: liveThreads.length })
      : null;
  const progress = card ? boardProgress(card.tasks) : null;
  const criteria = detail?.criteria ?? [];
  const metCriteria = criteria.filter((entry) => entry.met).length;
  const blockers: ReadonlyArray<ProjectBoardBlocker> =
    done || missing ? [] : (detail?.blockers ?? card?.blockers ?? []);
  const why = card
    ? columnWhy({ card, movedByThreads: props.movedByThreads, threadsAtWork: atWork })
    : null;
  const sections = viewThreadSections(threads, allThreads);
  const summary = problemSummary(detail?.problem ?? null);
  const specPath = card?.specPath ?? null;
  const openSpec =
    specPath === null || missing
      ? null
      : () => props.onOpenFiles([{ path: specPath, name: `${number} spec.md` }], specPath);
  const reports = detail?.reports ?? [];
  const closedAt = detail?.closedAt ?? (done ? (card?.updatedAt ?? null) : null);
  const stateLine = abandoned
    ? closedAt
      ? `closed ${longDate(closedAt)}`
      : null
    : done
      ? closedAt
        ? `closed ${longDate(closedAt)}`
        : null
      : card?.updatedAt
        ? `updated ${ago(card.updatedAt, now)}`
        : null;

  const threadRow = (entry: BoardThread) => {
    const taskLabel = threadTaskLabel(entry, tasks, threads);
    const status = entry.status ?? THREAD_TONE_LABELS[entry.tone];
    const from = entry.machine.moved ? entry.machine.label.split(" → ")[0] : null;
    return (
      <li
        key={`${entry.thread.environmentId}:${entry.thread.id}`}
        className="sws-board-view-thread"
        data-machine-color={props.showMachine || entry.machine.moved ? entry.color : undefined}
      >
        <button
          type="button"
          className="sws-board-view-thread-open"
          data-tone={entry.tone}
          aria-label={`Open thread ${entry.thread.title}, ${THREAD_TONE_LABELS[entry.tone]}`}
          onClick={() => props.onOpenThread(entry.thread)}
        >
          <span className="sws-dot" data-tone={entry.tone} aria-hidden />
          <span className="sws-board-view-thread-text">
            <span className="sws-board-view-thread-title">{entry.thread.title}</span>
            <span className="sws-board-view-thread-meta">
              <span data-tone={entry.tone}>{status}</span>
              {supported && detail && taskLabel ? <span>{taskLabel}</span> : null}
              {from ? <span>moved from {from}</span> : null}
            </span>
          </span>
        </button>
        {props.showMachine || entry.machine.moved ? <BoardMachineMark thread={entry} /> : null}
      </li>
    );
  };

  return (
    <section className="sws-board-view" id={props.id} aria-labelledby={headingId}>
      <header className="sws-board-view-head">
        <div className="sws-board-view-top">
          <button type="button" className="sws-board-view-back" onClick={props.onClose}>
            <ChevronLeftIcon aria-hidden />
            Board
          </button>
          <span className="sws-board-card-id">{number}</span>
          {card ? (
            <span
              className="sws-chip sws-board-view-column"
              data-column={abandoned ? "abandoned" : card.column}
            >
              {abandoned ? "Abandoned" : BOARD_COLUMN_LABELS[card.column]}
            </span>
          ) : null}
          {stateLine ? <span className="sws-board-view-age">{stateLine}</span> : null}
          <span className="sws-board-view-nav">
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Previous card"
              disabled={props.onStep.previous === null}
              onClick={() => props.onStep.previous?.()}
            >
              <ChevronUpIcon aria-hidden />
            </button>
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Next card"
              disabled={props.onStep.next === null}
              onClick={() => props.onStep.next?.()}
            >
              <ChevronDownIcon aria-hidden />
            </button>
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Close the increment view"
              onClick={props.onClose}
            >
              <XIcon aria-hidden />
            </button>
          </span>
        </div>
        <h3 id={headingId} className="sws-board-view-title" tabIndex={-1} ref={props.headingRef}>
          {title}
        </h3>
        {progress ? (
          <div className="sws-board-view-progress">
            <span className="sws-board-meter" aria-hidden>
              <span style={{ width: `${progress.percent}%` }} />
            </span>
            <span className="sws-board-view-count">{progress.label}</span>
            {criteria.length > 0 ? (
              <span className="sws-board-view-count">
                {metCriteria}/{criteria.length} criteria
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="sws-board-view-actions">
          {primary?.kind === "thread" && lead ? (
            <button
              type="button"
              className="sws-board-view-button"
              data-primary=""
              onClick={() => props.onOpenThread(lead.thread)}
            >
              <MessageSquareIcon aria-hidden />
              Open thread
            </button>
          ) : null}
          {primary?.kind === "ask" && onAsk ? (
            <button
              type="button"
              className="sws-board-view-button"
              data-primary=""
              // A thread that cannot be reached may still hold the work: the request says so.
              onClick={() => onAsk(primary.prompt + boardOutOfReachNote(threads))}
            >
              {primary.label}
            </button>
          ) : null}
          {primary?.kind === "thread" && onAsk ? (
            <button
              type="button"
              className="sws-board-view-button"
              onClick={() => onAsk(viewCoordinatorPrompt(incrementId))}
            >
              Ask the coordinator
            </button>
          ) : null}
          {openSpec ? (
            <button type="button" className="sws-board-view-button" onClick={openSpec}>
              <FileTextIcon aria-hidden />
              Spec file
            </button>
          ) : null}
          {reports.length > 0 ? (
            <button
              type="button"
              className="sws-board-view-button"
              onClick={() => props.onOpenFiles(reports, reports[0]!.path)}
            >
              Reports
            </button>
          ) : null}
        </div>
        {summary ? <p className="sws-board-view-summary">{summary}</p> : null}
      </header>

      <div className="sws-board-view-body">
        {missing ? (
          <div className="sws-board-view-note" role="status">
            <strong>This increment is no longer on disk.</strong>
            <button type="button" className="sws-board-view-button" onClick={props.onClose}>
              Back to the board
            </button>
          </div>
        ) : null}
        {query.error && !missing && detail === null ? (
          <p className="sws-board-view-note" role="status">
            The increment could not be read: {query.error}
          </p>
        ) : null}
        {card === null && !missing && !query.error ? (
          <p className="sws-board-view-note" role="status">
            {supported
              ? "Reading the increment…"
              : "This increment is not on the board, and the machine that serves this project needs a newer SpecWithCode to read it."}
          </p>
        ) : null}

        {abandoned ? (
          <div className="sws-board-view-note">
            <strong>Abandoned</strong>
            <span>{detail?.abandonedReason ?? "No reason was recorded."}</span>
          </div>
        ) : null}
        {done && !abandoned && detail && (detail.verify || detail.review?.latest) ? (
          <p className="sws-board-view-why">
            {detail.verify
              ? `${detail.verify.ok ? "Verified" : "Verify failed"} on ${longDate(detail.verify.ranAt)}. `
              : ""}
            {detail.review?.latest
              ? `Reviewed by ${detail.review.latest.model ?? detail.review.latest.family}${
                  detail.review.latest.verdict ? `: ${detail.review.latest.verdict}` : ""
                }.`
              : ""}
          </p>
        ) : null}

        {paused && card && !missing ? (
          <div className="sws-board-view-blocker" data-kind="paused">
            <strong className="sws-board-view-blocker-title">
              <PauseIcon aria-hidden />
              Paused
            </strong>
            <p className="sws-board-view-blocker-reason">
              {boardNoteText(card.pausedReason ?? "") ||
                (card.paused === undefined
                  ? "The reason shows after the machine that serves this project updates SpecWithCode."
                  : "No reason was given.")}
            </p>
          </div>
        ) : null}
        {blockers.map((blocker) => {
          const actions = blockerActions({ incrementId, blocker, tasks, threads });
          const holder = actions.thread;
          const when = ago(blocker.at, now);
          return (
            <div className="sws-board-view-blocker" key={blocker.taskId} data-task={blocker.taskId}>
              <strong className="sws-board-view-blocker-title">
                <TriangleAlertIcon aria-hidden />
                {blocker.taskId} is blocked
              </strong>
              <p className="sws-board-view-blocker-reason">
                {boardNoteText(blocker.note ?? "") || "No reason was given."}
              </p>
              <p className="sws-board-view-blocker-meta">
                {[
                  blocker.title,
                  blocker.by ? `blocked by ${blocker.by}` : null,
                  holder ? `in ${holder.thread.title}` : null,
                  when,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="sws-board-view-actions">
                {onAsk ? (
                  <button
                    type="button"
                    className="sws-board-view-button"
                    onClick={() => onAsk(actions.unblock.prompt + boardOutOfReachNote(threads))}
                  >
                    {actions.unblock.label}
                  </button>
                ) : null}
                {holder ? (
                  <button
                    type="button"
                    className="sws-board-view-button"
                    onClick={() => props.onOpenThread(holder.thread)}
                  >
                    Open that thread
                  </button>
                ) : onAsk ? (
                  <button
                    type="button"
                    className="sws-board-view-button"
                    onClick={() => onAsk(actions.ask.prompt)}
                  >
                    {actions.ask.label}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {card && !done && !paused && !missing && card.blocked && blockers.length === 0 ? (
          <div className="sws-board-view-blocker">
            <strong className="sws-board-view-blocker-title">
              <TriangleAlertIcon aria-hidden />
              Blocked
            </strong>
            <p className="sws-board-view-blocker-reason">
              The reason shows after the machine that serves this project updates SpecWithCode.
            </p>
          </div>
        ) : null}

        {why ? (
          <p className="sws-board-view-why">
            In <strong>{why.column}</strong> because {why.because}. Its status file still says{" "}
            {why.status}.
          </p>
        ) : null}

        {card !== null || threads.length > 0 ? (
          <Section
            title="Threads"
            note={
              threads.length === 0
                ? "0"
                : sections.finished.length === threads.length
                  ? `${threads.length} finished`
                  : String(threads.length - sections.finished.length)
            }
          >
            {threads.length === 0 ? (
              <p className="sws-board-view-note">No thread works on this yet.</p>
            ) : (
              <ul className="sws-board-view-threads">
                {sections.shown.map(threadRow)}
                {sections.more > 0 ? (
                  <li>
                    <button
                      type="button"
                      className="sws-board-view-more"
                      onClick={() => setAllThreads(true)}
                    >
                      {sections.more} more
                    </button>
                  </li>
                ) : null}
                {finishedThreads || sections.shown.length === 0
                  ? sections.finished.map(threadRow)
                  : null}
                {sections.finished.length > 0 && sections.shown.length > 0 && !finishedThreads ? (
                  <li>
                    <button
                      type="button"
                      className="sws-board-view-more"
                      onClick={() => setFinishedThreads(true)}
                    >
                      {sections.finished.length} finished
                    </button>
                  </li>
                ) : null}
              </ul>
            )}
          </Section>
        ) : null}

        {!supported && card ? (
          <div className="sws-board-view-note">
            <strong>Tasks and criteria need a newer server</strong>
            <span>
              The machine that serves this project runs an older SpecWithCode. Update it to see
              tasks, criteria and blocker reasons here; the spec file still opens.
            </span>
          </div>
        ) : null}
        {supported && detail === null && card !== null && !missing && !query.error ? (
          <p className="sws-board-view-note" role="status">
            Reading tasks and criteria…
          </p>
        ) : null}

        {detail && card ? (
          <>
            <Section
              title="Tasks"
              note={
                tasks.length === 0 && detail.doneTasks === 0
                  ? null
                  : tasks.every(taskIsClosed)
                    ? `${detail.doneTasks} done`
                    : `${tasks.filter((task) => !taskIsClosed(task)).length} open`
              }
              action={
                detail.doneTasks > 0 ? (
                  <button
                    type="button"
                    className="sws-board-view-link"
                    aria-expanded={includeDone}
                    onClick={() => setIncludeDone((value) => !value)}
                  >
                    {includeDone ? "Hide done" : `Show ${detail.doneTasks} done`}
                  </button>
                ) : null
              }
            >
              {card.specPath === null ? (
                <p className="sws-board-view-note">
                  No spec yet: this increment has a folder and a title but no spec.md.
                </p>
              ) : tasks.length === 0 && detail.doneTasks === 0 ? (
                <p className="sws-board-view-note">
                  {detail.readable || card.tasks.total === 0
                    ? "The spec has no tasks yet."
                    : "The ledger could not be read, so task states are unknown."}
                </p>
              ) : tasks.length === 0 ? (
                <p className="sws-board-view-note">Every task is done or skipped.</p>
              ) : (
                <ul className="sws-board-view-tasks">
                  {viewTaskOrder(tasks).map((task) => {
                    const holder = taskHolder(task, threads);
                    return (
                      <li key={task.id} className="sws-board-view-task" data-status={task.status}>
                        <span className="sws-board-card-id">{task.id}</span>
                        <span className="sws-board-view-task-text">
                          <span className="sws-board-view-task-title">{task.title}</span>
                          {task.note && !taskIsClosed(task) ? (
                            <span className="sws-board-view-task-note">
                              {boardNoteText(task.note)}
                            </span>
                          ) : null}
                          {holder ? (
                            <button
                              type="button"
                              className="sws-board-view-holder"
                              data-machine-color={holder.color}
                              aria-label={`Open thread ${holder.thread.title}, which holds ${task.id}`}
                              onClick={() => props.onOpenThread(holder.thread)}
                            >
                              <MessageSquareIcon aria-hidden />
                              <span>{holder.thread.title}</span>
                            </button>
                          ) : null}
                          {task.status === "stale" && onAsk ? (
                            <button
                              type="button"
                              className="sws-board-view-link"
                              onClick={() =>
                                onAsk(
                                  `Increment ${incrementId}, task ${task.id}: its claim${
                                    task.owner ? ` by ${task.owner}` : ""
                                  } is older than two hours. Release it or pick it up.`,
                                )
                              }
                            >
                              Release with the coordinator
                            </button>
                          ) : null}
                        </span>
                        <span className="sws-board-view-task-status">
                          {TASK_STATUS_LABELS[task.status]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>

            {criteria.length > 0 ? (
              <Section title="Acceptance criteria" note={criteriaSummary(criteria)}>
                <ul className="sws-board-view-criteria">
                  {criteria.map((criterion) => {
                    const state = criterionState(criterion);
                    return (
                      <li key={criterion.id} data-state={state}>
                        <span className="sws-board-view-ac">{criterion.id}</span>
                        <span className="sws-board-view-ac-text">{criterion.text}</span>
                        <span className="sws-board-view-ac-state">
                          {CRITERION_STATE_LABELS[state]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            ) : null}
          </>
        ) : null}

        {card && card.pullRequests.length > 0 ? (
          <Section title="Pull requests" note={String(card.pullRequests.length)}>
            <div className="sws-board-view-pulls">
              {card.pullRequests.map((url) => {
                const state = props.pullRequestStates.get(url);
                return (
                  <button
                    type="button"
                    className="sws-chip"
                    key={url}
                    data-state={state?.toLowerCase()}
                    aria-label={`Open pull request ${pullRequestLabel(url)}${state ? `, ${state}` : ""}`}
                    onClick={() => props.onOpenLink(url)}
                  >
                    <PullRequestGlyph.pullRequest aria-hidden />
                    {pullRequestLabel(url)}
                    {state ? ` ${state}` : ""}
                  </button>
                );
              })}
            </div>
          </Section>
        ) : null}

        {detail?.problem ? (
          <Section
            title="Problem"
            action={
              openSpec ? (
                <button type="button" className="sws-board-view-link" onClick={openSpec}>
                  Open spec file
                </button>
              ) : null
            }
          >
            {detail.problem.split(/\n\s*\n/u).map((paragraph) => (
              <p className="sws-board-view-problem" key={paragraph}>
                {paragraph}
              </p>
            ))}
          </Section>
        ) : null}
      </div>
    </section>
  );
}
