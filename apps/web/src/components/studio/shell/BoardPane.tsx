/**
 * The project's Board tab: its SpecWeave increments as cards in Planned,
 * Active, In review and Done, read from the increment files by
 * `projects.board`. Side by side when the panel is wide, stacked with the
 * work in motion first when it is narrow. A card opens the increment view
 * (BoardIncrementView): beside the board in a wide panel, in its place in a
 * narrow one. Blocked is a state, not a column: a switch narrows every column
 * to its stuck cards. A project without SpecWeave gets the switch to turn the
 * board on instead of a hidden tab.
 */
import type { EnvironmentId, ProjectBoardCard, ProjectId } from "@specweave-studio/contracts";
import {
  PROJECT_BOARD_DONE_DEFAULT,
  PROJECT_BOARD_DONE_MAX,
  type ProjectBoardColumn,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { CheckIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useOpenLink } from "../../../browser/useOpenLink";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../../state/query";
import {
  BOARD_COLUMN_LABELS,
  BOARD_COLUMN_PAGE,
  BOARD_DONE_STEP,
  BOARD_STACK_ORDER,
  NO_BOARD_PROMOTIONS,
  PROJECT_BOARD_COLUMNS,
  boardBlockedCounts,
  boardCardBlocked,
  boardColumnMore,
  boardColumns,
  boardFilterLabel,
  boardIsEmpty,
  boardThreadEvidence,
  boardWithPromotions,
  nextBoardPromotions,
} from "../../../studio/projectBoardModel";
import { collectProjectPullRequests } from "../../../studio/projectPaneModel";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import { nowFromMinute } from "../../../studio/shellModel";
import { BoardCard } from "./BoardCard";
import { BoardIncrementView, type BoardViewFile } from "./BoardIncrementView";
import { useBoardThreads } from "./BoardThreads";
import { LibraryFileViewer } from "./LibraryFileViewer";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";

/** How often an open board asks again; the server re-reads only files that changed. */
const BOARD_REFRESH_MS = 30_000;
/**
 * The panel width from which the increment view sits beside the board. Below
 * it the view takes the panel: at min(500px, 45%) for the view, the list
 * would fall under the 320 px a card needs. Keep in step with board-view.css.
 */
export const BOARD_SPLIT_MIN_WIDTH = 1040;
export type BoardViewLayout = "split" | "full";

const PULL_REQUEST_STATE_WORDS: Record<string, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** Whether the panel is wide enough for the view beside the board; `named` skips measuring. */
function useBoardViewLayout(
  element: HTMLElement | null,
  named: BoardViewLayout | undefined,
): BoardViewLayout | null {
  // Null until the panel has been measured, so nothing acts on a guess.
  const [measured, setMeasured] = useState<BoardViewLayout | null>(null);
  useEffect(() => {
    if (named !== undefined || element === null) return;
    const measure = () =>
      setMeasured(element.clientWidth >= BOARD_SPLIT_MIN_WIDTH ? "split" : "full");
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, named]);
  return named ?? measured;
}

export interface BoardPaneProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  bar: ProjectPaneBarProps;
  /** The project plans with SpecWeave; false shows how to turn the board on. */
  specweave: boolean;
  /** The control that turns SpecWeave on, shown while the project has no board. */
  setup: ReactNode;
  /** The project's threads on every machine; a card lists the ones working on it. */
  threads: ReadonlyArray<EnvironmentThreadShell>;
  machineLabels?: ReadonlyMap<string, string> | undefined;
  onOpenThread: (thread: EnvironmentThreadShell) => void;
  /** Puts a request in the coordinator's composer; absent when the person cannot send. */
  onAsk?: ((prompt: string) => void) | undefined;
  /**
   * The increment whose view is open, from the page's navigation state, so
   * back closes it and a link can name it. Without `onOpenIncrement` the pane
   * keeps it itself.
   */
  openIncrement?: string | null | undefined;
  /** Opens a card's view, or closes it with null; `replace` when walking from card to card. */
  onOpenIncrement?:
    | ((incrementId: string | null, options?: { readonly replace?: boolean }) => void)
    | undefined;
  /** Names the view's layout instead of measuring the panel (tests, fixtures). */
  layout?: BoardViewLayout | undefined;
}

export function BoardPane(props: BoardPaneProps) {
  if (props.specweave) return <BoardCards {...props} />;
  return (
    <>
      <ProjectPaneBar {...props.bar} />
      <div
        className="sws-threads-body sws-board"
        id="sws-pane-board"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-board"
      >
        <section className="sws-board-setup" aria-labelledby="sws-board-setup-title">
          <h3 id="sws-board-setup-title">Start a board for this project</h3>
          <p>
            The board shows the project's work as cards in Planned, Active, In review and Done, each
            with its tasks, pull requests and the threads working on it. It is built from SpecWeave
            increments, so turn SpecWeave on to get one.
          </p>
          {props.setup}
        </section>
      </div>
    </>
  );
}

function BoardCards({
  environmentId,
  projectId,
  workspaceRoot,
  bar,
  threads,
  machineLabels,
  onOpenThread,
  onAsk,
  openIncrement,
  onOpenIncrement,
  layout: namedLayout,
}: BoardPaneProps) {
  const [filter, setFilter] = useState("");
  const [searched, setSearched] = useState("");
  const [doneLimit, setDoneLimit] = useState(PROJECT_BOARD_DONE_DEFAULT);
  const [shown, setShown] = useState<Partial<Record<ProjectBoardColumn, number>>>({});
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [opened, setOpened] = useState<{
    files: ReadonlyArray<BoardViewFile>;
    path: string;
  } | null>(null);
  useEffect(() => {
    const next = filter.trim();
    if (next === searched) return;
    const timer = window.setTimeout(() => {
      setSearched(next);
      // A new search starts each column at its first page again.
      setShown({});
      setDoneLimit(PROJECT_BOARD_DONE_DEFAULT);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filter, searched]);
  const query = useEnvironmentQuery(
    useMemo(
      () =>
        projectWorkspace.board({
          environmentId,
          input: {
            projectId,
            ...(searched === "" ? {} : { query: searched }),
            ...(doneLimit === PROJECT_BOARD_DONE_DEFAULT ? {} : { doneLimit }),
          },
        }),
      [doneLimit, environmentId, projectId, searched],
    ),
  );
  // A new search or a longer Done column starts a fresh query; keep the last
  // reply on screen until it lands, so the board does not blank.
  const [data, setData] = useState(query.data);
  if (query.data && query.data !== data) setData(query.data);
  const working = useBoardThreads({ environmentId, threads, machineLabels });

  // Planned cards a thread is at work on show in Active. Within one board
  // refresh a card only moves in; each refresh settles on the threads' state
  // then, so a thread that flips between working and idle does not move it.
  const [promotions, setPromotions] = useState(NO_BOARD_PROMOTIONS);
  const evidence = useMemo(
    () => boardThreadEvidence(data?.cards ?? [], working.byIncrement),
    [data, working.byIncrement],
  );
  const latestEvidence = useRef(evidence);
  useEffect(() => {
    latestEvidence.current = evidence;
    setPromotions((held) => nextBoardPromotions(held, held.revision, evidence));
  }, [evidence]);
  const settlePromotions = useCallback(
    () =>
      setPromotions((held) => nextBoardPromotions(held, held.revision + 1, latestEvidence.current)),
    [],
  );
  const threadsAnswered = working.answered;
  useEffect(() => {
    if (threadsAnswered) settlePromotions();
  }, [settlePromotions, threadsAnswered]);
  const refresh = query.refresh;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      settlePromotions();
      refresh();
    }, BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, settlePromotions]);

  const openLink = useOpenLink(null);
  const onOpenLink = useCallback(
    (url: string) => void openLink(url).catch(() => undefined),
    [openLink],
  );
  const now = nowFromMinute(useNowMinute());
  const board = useMemo(
    () => (data ? boardWithPromotions(data, promotions.ids) : null),
    [data, promotions.ids],
  );
  const columns = useMemo(() => boardColumns(board?.cards ?? []), [board]);
  const blockedCounts = useMemo(() => boardBlockedCounts(columns), [columns]);
  // A filter with nothing left to show would hide the whole board. It turns
  // itself off, so a card blocked later does not bring it back unasked.
  if (blockedOnly && board !== null && blockedCounts.all === 0) setBlockedOnly(false);
  const filtering = blockedOnly && blockedCounts.all > 0;
  const listed = useMemo(() => {
    const result = {} as Record<ProjectBoardColumn, ProjectBoardCard[]>;
    for (const column of PROJECT_BOARD_COLUMNS) {
      const held = filtering ? columns[column].filter(boardCardBlocked) : columns[column];
      result[column] = held.slice(0, shown[column] ?? BOARD_COLUMN_PAGE);
    }
    return result;
  }, [columns, filtering, shown]);
  const pullRequestStates = useMemo(
    () =>
      new Map(
        collectProjectPullRequests(threads).map((entry) => [
          entry.url,
          PULL_REQUEST_STATE_WORDS[entry.state] ?? entry.state,
        ]),
      ),
    [threads],
  );

  // The open increment: the page's navigation state when it gives one, else our own.
  const [ownOpen, setOwnOpen] = useState<string | null>(null);
  const openId = (onOpenIncrement ? (openIncrement ?? null) : ownOpen) || null;
  const openCard = useCallback(
    (incrementId: string | null, options?: { readonly replace?: boolean }) => {
      if (onOpenIncrement) onOpenIncrement(incrementId, options);
      else setOwnOpen(incrementId);
    },
    [onOpenIncrement],
  );
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const knownLayout = useBoardViewLayout(body, namedLayout);
  const layout = knownLayout ?? "full";
  const viewOpen = openId !== null && board !== null;
  const viewId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const openedCard = openId === null ? null : board?.cards.find((c) => c.incrementId === openId);
  const openedColumn = openedCard?.column ?? null;

  // With the view open the board is a stacked list: its cards in reading order.
  const walk = useMemo(
    () =>
      PROJECT_BOARD_COLUMNS.toSorted(
        (left, right) => BOARD_STACK_ORDER[left] - BOARD_STACK_ORDER[right],
      ).flatMap((column) => listed[column].map((card) => card.incrementId)),
    [listed],
  );
  const walkIndex = openId === null ? -1 : walk.indexOf(openId);
  const step = (offset: -1 | 1) => {
    // A card the search or the filter hid is not listed: start from the top.
    const next = walkIndex === -1 ? (offset === 1 ? walk[0] : undefined) : walk[walkIndex + offset];
    return next === undefined ? null : () => openCard(next, { replace: true });
  };

  // In the panel-filling layout the list is gone, so the keyboard goes to the
  // view. Beside the board, focus stays on the card: Up and Down keep walking.
  useEffect(() => {
    if (viewOpen && knownLayout === "full") heading.current?.focus();
  }, [knownLayout, openId, viewOpen]);
  // Closing hands the keyboard back to the card, or to its column's heading
  // when a search, the filter or a refresh took the card away.
  const closed = useRef<{ id: string; column: ProjectBoardColumn | null } | null>(null);
  useEffect(() => {
    if (openId !== null) {
      closed.current = { id: openId, column: openedColumn ?? closed.current?.column ?? null };
      return;
    }
    const last = closed.current;
    closed.current = null;
    if (last === null || body === null) return;
    const active = document.activeElement;
    // Only when the keyboard was here: never take it from the composer.
    if (active !== null && active !== document.body && !body.contains(active)) return;
    const target =
      [...body.querySelectorAll<HTMLElement>("[data-board-card]")].find(
        (node) => node.dataset.boardCard === last.id,
      ) ??
      body.querySelector<HTMLElement>(`[data-column="${last.column ?? ""}"] h3`) ??
      body.querySelector<HTMLElement>(".sws-board-column h3");
    target?.focus();
  }, [body, openId, openedColumn]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      if (!viewOpen || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      openCard(null, { replace: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // Arrows walk cards only from the card list: the search box, the pane's
    // buttons and everything inside the view keep them.
    const from = (event.target as HTMLElement).closest<HTMLElement>(".sws-board-card");
    const current = from?.querySelector<HTMLElement>("[data-board-card]") ?? null;
    if (current === null || body === null) return;
    const cards = [...body.querySelectorAll<HTMLElement>("[data-board-card]")]
      .map((node, index) => ({
        node,
        index,
        // Stacked, the columns are reordered by CSS; side by side they are not.
        order: Number(getComputedStyle(node.closest("[data-column]") ?? node).order) || 0,
      }))
      .toSorted((left, right) => left.order - right.order || left.index - right.index)
      .map((entry) => entry.node);
    const next = cards[cards.indexOf(current) + (event.key === "ArrowDown" ? 1 : -1)];
    event.preventDefault();
    if (next === undefined) return;
    next.focus();
    const id = next.dataset.boardCard;
    if (viewOpen && id) openCard(id, { replace: true });
  };

  return (
    <>
      <ProjectPaneBar {...bar} />
      <div
        className="sws-threads-body sws-board"
        id="sws-pane-board"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-board"
        data-view={viewOpen ? layout : undefined}
        ref={setBody}
        onKeyDown={onKeyDown}
      >
        <div className="sws-board-list">
          <div className="sws-board-tools">
            <label className="sws-find">
              <SearchIcon aria-hidden />
              <input
                type="search"
                aria-label="Find an increment"
                placeholder="Find an increment"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || filter === "") return;
                  event.stopPropagation();
                  setFilter("");
                }}
              />
            </label>
            {blockedCounts.all > 0 ? (
              <button
                type="button"
                className="sws-board-filter"
                aria-pressed={filtering}
                onClick={() => setBlockedOnly(!filtering)}
              >
                {filtering ? <CheckIcon aria-hidden /> : <TriangleAlertIcon aria-hidden />}
                {boardFilterLabel(blockedCounts.all)}
              </button>
            ) : null}
          </div>
          {filtering ? (
            <p className="sws-board-filter-note" role="status">
              Showing only the {blockedCounts.all === 1 ? "card that is" : "cards that are"} paused
              or have a blocked task.
              <button type="button" onClick={() => setBlockedOnly(false)}>
                Show all cards
              </button>
            </p>
          ) : null}
          {board === null ? (
            <p className="sws-empty sws-pane-empty" role="status">
              {query.error ? `The board could not be read: ${query.error}` : "Reading increments…"}
            </p>
          ) : boardIsEmpty(board) ? (
            <p className="sws-empty sws-pane-empty" role="status">
              {searched === ""
                ? "No increments yet. Plan one with specweave create-increment and it shows here."
                : `No increment matches "${searched}".`}
            </p>
          ) : (
            <div className="sws-board-columns">
              {PROJECT_BOARD_COLUMNS.map((column) => {
                const held = filtering ? columns[column].filter(boardCardBlocked) : columns[column];
                const limit = shown[column] ?? BOARD_COLUMN_PAGE;
                const more = boardColumnMore({
                  column,
                  held: held.length,
                  shown: limit,
                  // Older Done cards are never blocked: the filter has none to fetch.
                  total: filtering ? held.length : board.counts[column],
                });
                const headingId = `sws-board-${column}`;
                const blocked = blockedCounts[column];
                return (
                  <section
                    className="sws-board-column"
                    key={column}
                    data-column={column}
                    aria-labelledby={headingId}
                    style={{ order: BOARD_STACK_ORDER[column] }}
                  >
                    <div className="sws-board-column-head">
                      <h3 id={headingId} className="sws-pane-group-heading" tabIndex={-1}>
                        {BOARD_COLUMN_LABELS[column]}
                        <span className="sws-group-count">
                          {board.counts[column]}
                          <span className="sr-only"> increments</span>
                        </span>
                      </h3>
                      {blocked > 0 ? (
                        <button
                          type="button"
                          className="sws-board-column-blocked"
                          aria-pressed={filtering}
                          aria-label={`${blocked} blocked in ${BOARD_COLUMN_LABELS[column]}: show blocked cards only`}
                          onClick={() => setBlockedOnly(!filtering)}
                        >
                          {blocked} blocked
                        </button>
                      ) : null}
                    </div>
                    <div className="sws-board-cards">
                      {listed[column].map((card) => (
                        <BoardCard
                          key={card.incrementId}
                          card={card}
                          open={openId === card.incrementId}
                          threads={working.byIncrement.get(card.incrementId) ?? NO_THREADS}
                          threadsAnswered={working.answered}
                          multiMachine={working.multiMachine}
                          now={now}
                          viewId={viewId}
                          onOpen={openCard}
                          onOpenThread={onOpenThread}
                          onOpenLink={onOpenLink}
                          onAsk={onAsk}
                        />
                      ))}
                    </div>
                    {more ? (
                      <button
                        type="button"
                        className="sws-board-more"
                        disabled={more.kind === "older" && query.isPending}
                        onClick={() => {
                          const next = limit + BOARD_COLUMN_PAGE;
                          if (more.kind === "older") {
                            setDoneLimit((value) =>
                              Math.min(PROJECT_BOARD_DONE_MAX, value + BOARD_DONE_STEP),
                            );
                            setShown((value) => ({ ...value, done: limit + BOARD_DONE_STEP }));
                          } else {
                            setShown((value) => ({ ...value, [column]: next }));
                          }
                        }}
                      >
                        {more.label}
                      </button>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </div>
        {viewOpen && openId !== null ? (
          <BoardIncrementView
            id={viewId}
            environmentId={environmentId}
            projectId={projectId}
            incrementId={openId}
            card={openedCard ?? null}
            supported={board.detail === true}
            movedByThreads={
              promotions.ids.has(openId) &&
              data?.cards.find((card) => card.incrementId === openId)?.column === "planned"
            }
            threads={working.byIncrement.get(openId) ?? NO_THREADS}
            showMachine={working.multiMachine}
            pullRequestStates={pullRequestStates}
            now={now}
            headingRef={heading}
            onClose={() => openCard(null, { replace: true })}
            onStep={{ previous: step(-1), next: step(1) }}
            onOpenThread={onOpenThread}
            onOpenLink={onOpenLink}
            onOpenFiles={(files, path) => setOpened({ files, path })}
            onAsk={onAsk}
          />
        ) : null}
      </div>
      {working.loaders}
      {opened ? (
        <LibraryFileViewer
          environmentId={environmentId}
          workspaceRoot={workspaceRoot}
          files={opened.files}
          path={opened.path}
          onPath={(path) => setOpened({ files: opened.files, path })}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}

const NO_THREADS: ReadonlyArray<never> = [];
