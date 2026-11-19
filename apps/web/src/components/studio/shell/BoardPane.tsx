/**
 * The project's Board tab: its SpecWeave increments as cards in Blocked,
 * Active, In review, Planned and Done, read from the increment files by
 * `projects.board`. Blocked is every open card that is paused or has a
 * blocked task, shown first. Each group folds, and the fold is remembered
 * per project. Side by side when the panel is wide (Blocked as a band above
 * the columns), stacked when it is narrow. A "Runs on" legend says what a
 * card's colored edge means and narrows the board to one machine. A card
 * opens the increment view (BoardIncrementView): beside the board in a wide
 * panel, in its place in a narrow one. A project without SpecWeave, or with
 * plans written before it was set up, gets the setup in its place (BoardSetup,
 * through `setup`) instead of a hidden tab.
 */
import type {
  EnvironmentId,
  ProjectBoardCard,
  ProjectBoardResult,
  ProjectId,
} from "@specweave-studio/contracts";
import { PROJECT_BOARD_DONE_DEFAULT, PROJECT_BOARD_DONE_MAX } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { SearchIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useOpenLink } from "../../../browser/useOpenLink";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../../state/query";
import {
  BOARD_COLUMN_PAGE,
  BOARD_DONE_STEP,
  BOARD_GROUPS,
  BOARD_GROUPS_WIDE,
  BOARD_GROUP_LABELS,
  NO_BOARD_PROMOTIONS,
  boardCardGroup,
  boardCardOnMachine,
  boardColumnMore,
  boardGroupCounts,
  boardGroups,
  boardBehindLine,
  boardIsEmpty,
  boardNotDone,
  boardMachineOptions,
  boardPullRequestStates,
  boardStateLabel,
  boardThreadEvidence,
  boardWithPromotions,
  nextBoardPromotions,
  type BoardGroupId,
} from "../../../studio/projectBoardModel";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import { compactAge, nowFromMinute } from "../../../studio/shellModel";
import { useTx } from "../../../i18n";
import { Button } from "../../ui/button";
import { BOARD_EMPTY_ACTION, BOARD_EMPTY_PROMPT, BOARD_EMPTY_TEXT } from "../specweaveSetup.logic";
import { BoardCard } from "./BoardCard";
import { BoardGroupSection } from "./BoardGroupSection";
import { BoardIncrementView, type BoardViewFile } from "./BoardIncrementView";
import { BoardMachineLegend } from "./BoardMachineLegend";
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
/** The board's own width from which its groups sit side by side. */
export const BOARD_COLUMNS_MIN_WIDTH = 720;
export type BoardViewLayout = "split" | "full";

/** Folded groups by `environmentId:projectId`: boards differ in size from project to project. */
const FOLDED_STORAGE_KEY = "studio:project-board-folded:v1";
const FoldedSchema = Schema.Record(Schema.String, Schema.Array(Schema.String));
const NO_FOLDS: ReadonlyArray<string> = [];

interface BoardLayout {
  /** Where the increment view goes; null until the panel has been measured. */
  readonly view: BoardViewLayout | null;
  /** The board is wide enough for its groups side by side. */
  readonly columns: boolean;
}

/**
 * What the panel's width allows. Measured before paint, so the groups are in
 * the document in the order they are shown and never jump after the first
 * frame; `named` skips measuring (tests, fixtures).
 */
function useBoardLayout(
  element: HTMLElement | null,
  named: { view?: BoardViewLayout | undefined; columns?: boolean | undefined },
): BoardLayout {
  // Null until the panel has been measured, so nothing acts on a guess.
  const [measured, setMeasured] = useState<{ view: BoardViewLayout; columns: boolean } | null>(
    null,
  );
  const known = named.view !== undefined && named.columns !== undefined;
  useLayoutEffect(() => {
    if (known || element === null) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const inner =
        element.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0);
      const view = element.clientWidth >= BOARD_SPLIT_MIN_WIDTH ? "split" : "full";
      const columns = inner >= BOARD_COLUMNS_MIN_WIDTH;
      setMeasured((held) =>
        held !== null && held.view === view && held.columns === columns ? held : { view, columns },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, known]);
  return {
    view: named.view ?? measured?.view ?? null,
    columns: named.columns ?? measured?.columns ?? false,
  };
}

export interface BoardPaneProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  bar: ProjectPaneBarProps;
  /** The project plans with SpecWeave; false shows `setup` instead of the board. */
  specweave: boolean;
  /** The tab while the project has no board: SpecWeave off or unfinished (BoardSetup). */
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
  /** Names whether the groups sit side by side instead of measuring (tests, fixtures). */
  columns?: boolean | undefined;
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
        {props.setup}
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
  columns: namedColumns,
}: BoardPaneProps) {
  const [filter, setFilter] = useState("");
  const [searched, setSearched] = useState("");
  const [doneLimit, setDoneLimit] = useState(PROJECT_BOARD_DONE_DEFAULT);
  const [shown, setShown] = useState<Partial<Record<BoardGroupId, number>>>({});
  const [machineChoice, setMachineChoice] = useState<string | null>(null);
  const [foldedByProject, setFoldedByProject] = useLocalStorage<
    Readonly<Record<string, ReadonlyArray<string>>>,
    Readonly<Record<string, ReadonlyArray<string>>>
  >(FOLDED_STORAGE_KEY, {}, FoldedSchema);
  const foldKey = `${environmentId}:${projectId}`;
  const folds = foldedByProject[foldKey] ?? NO_FOLDS;
  const setGroupFolded = useCallback(
    (group: BoardGroupId, fold: boolean) =>
      setFoldedByProject((current) => {
        const { [foldKey]: held = NO_FOLDS, ...rest } = current;
        const next = held.filter((name) => name !== group);
        if (fold) next.push(group);
        return next.length === 0 ? rest : { ...rest, [foldKey]: next };
      }),
    [foldKey, setFoldedByProject],
  );
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
  const groups = useMemo(() => boardGroups(board?.cards ?? []), [board]);
  const counts = useMemo(
    () => (board ? boardGroupCounts(board.counts, groups.blocked) : null),
    [board, groups.blocked],
  );
  // The legend: shown whenever a card can carry a machine's color on its edge.
  const showMachines = useMemo(() => {
    if (working.multiMachine) return true;
    for (const threads of working.byIncrement.values())
      if (threads.some((entry) => entry.machine.moved && entry.tone !== "resolved")) return true;
    return false;
  }, [working.byIncrement, working.multiMachine]);
  const machineOptions = useMemo(
    () =>
      showMachines && board
        ? boardMachineOptions(board.cards, working.byIncrement, working.answered)
        : [],
    [board, showMachines, working.answered, working.byIncrement],
  );
  // A choice whose machine has no card left would hide the whole board. It
  // lets go, so a thread that starts there later does not narrow it unasked;
  // but only once the threads have answered, never on a half-read list. A
  // search that leaves the machine no match lets it go too: an empty board
  // would read as "not found" while the match sits on another machine.
  // While the threads are read again the choice holds, so the board does not
  // widen and narrow under the person. A choice stays valid as the only entry.
  const offered = machineOptions.some((option) => option.id === machineChoice);
  const machine = offered || !working.answered ? machineChoice : null;
  if (machineChoice !== null && !offered && board !== null && working.answered)
    setMachineChoice(null);
  // A search looks inside folded groups too; hiding a match would read as "not found".
  const searching = filter.trim() !== "" || searched !== "";
  const held = useMemo(() => {
    const result = {} as Record<BoardGroupId, ProjectBoardCard[]>;
    for (const group of BOARD_GROUPS)
      result[group] =
        machine === null
          ? groups[group]
          : groups[group].filter((card) =>
              boardCardOnMachine(
                card,
                working.byIncrement.get(card.incrementId) ?? NO_THREADS,
                machine,
              ),
            );
    return result;
  }, [groups, machine, working.byIncrement]);
  const isFolded = useCallback(
    (group: BoardGroupId) => !searching && folds.includes(group),
    [folds, searching],
  );
  const listed = useMemo(() => {
    const result = {} as Record<BoardGroupId, ProjectBoardCard[]>;
    for (const group of BOARD_GROUPS)
      result[group] = isFolded(group)
        ? []
        : held[group].slice(0, shown[group] ?? BOARD_COLUMN_PAGE);
    return result;
  }, [held, isFolded, shown]);
  const pullRequestStates = useMemo(() => boardPullRequestStates(threads), [threads]);

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
  const measured = useBoardLayout(body, { view: namedLayout, columns: namedColumns });
  const knownLayout = measured.view;
  const layout = knownLayout ?? "full";
  const viewOpen = openId !== null && board !== null;
  // Beside the open view the board is a stacked list, whatever the panel's width.
  const sideBySide = measured.columns && !viewOpen;
  const order = sideBySide ? BOARD_GROUPS_WIDE : BOARD_GROUPS;
  const viewId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const openedCard = openId === null ? null : board?.cards.find((c) => c.incrementId === openId);
  const openedGroup = openedCard ? boardCardGroup(openedCard) : null;

  // An increment opened by a link or by going back, in a folded group: the
  // group opens at once, so it never waits on a machine that does not answer.
  // One later move is followed, the threads' own: a planned card they find at
  // work goes to Active, so the fold it opened is given back and Active opens
  // instead. Any other change of group, while its view is open, unfolds
  // nothing; and once the person folds or unfolds by hand the card's group,
  // or the group a promotion would move it to, those are theirs: nothing is
  // followed or given back after that.
  const revealed = useRef<{
    id: string;
    group: BoardGroupId | null;
    opened: boolean;
    settled: boolean;
  } | null>(null);
  const openedColumn =
    openId === null ? null : data?.cards.find((card) => card.incrementId === openId)?.column;
  const openedPromoted = openId !== null && promotions.ids.has(openId);
  const groupSettled =
    openId !== null &&
    (openedColumn !== "planned" ||
      openedPromoted ||
      ((working.answered || working.cut) && !evidence.includes(openId)));
  useEffect(() => {
    if (openId === null) {
      revealed.current = null;
      return;
    }
    if (revealed.current?.id !== openId)
      revealed.current = { id: openId, group: null, opened: false, settled: false };
    const state = revealed.current;
    if (state.settled || openedGroup === null) return;
    if (state.group === null) {
      state.opened = folds.includes(openedGroup);
      if (state.opened) setGroupFolded(openedGroup, false);
      state.group = openedGroup;
    } else if (state.group !== openedGroup) {
      // The board moved the card. Only the threads' promotion is followed.
      if (openedPromoted && openedColumn === "planned") {
        if (state.opened) setGroupFolded(state.group, true);
        if (folds.includes(openedGroup)) setGroupFolded(openedGroup, false);
      }
      state.settled = true;
      return;
    }
    if (groupSettled) state.settled = true;
  }, [folds, groupSettled, openId, openedColumn, openedGroup, openedPromoted, setGroupFolded]);
  const toggleGroup = (group: BoardGroupId, folded: boolean) => {
    // The card's group, or the one the threads would move a planned card to.
    const follow = revealed.current;
    if (
      follow &&
      (follow.group === group ||
        (follow.group === "planned" && (group === "active" || group === "blocked")))
    )
      follow.settled = true;
    setGroupFolded(group, folded);
  };

  // The cards on screen in reading order; with the view open that is the stacked list.
  const walk = useMemo(
    () => BOARD_GROUPS.flatMap((group) => listed[group].map((card) => card.incrementId)),
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
  // Closing hands the keyboard back to the card, or to its group's heading
  // when a search, a fold, the filter or a refresh took the card away.
  const closed = useRef<{ id: string; group: BoardGroupId | null } | null>(null);
  useEffect(() => {
    if (openId !== null) {
      closed.current = { id: openId, group: openedGroup ?? closed.current?.group ?? null };
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
      body.querySelector<HTMLElement>(`[data-group="${last.group ?? ""}"] .sws-group-bar`) ??
      body.querySelector<HTMLElement>(".sws-board-group .sws-group-bar");
    target?.focus();
  }, [body, openId, openedGroup]);

  // A refresh can move or remove the card the keyboard is on. Focus then goes
  // to the card in its new place, or to the heading of the group it was in,
  // instead of falling to the page.
  const focused = useRef<{ id: string; group: string } | null>(null);
  useEffect(() => {
    const last = focused.current;
    if (last === null || body === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    focused.current = null;
    const target =
      [...body.querySelectorAll<HTMLElement>("[data-board-card]")].find(
        (node) => node.dataset.boardCard === last.id,
      ) ??
      body.querySelector<HTMLElement>(`[data-group="${last.group}"] .sws-group-bar`) ??
      body.querySelector<HTMLElement>(".sws-board-group .sws-group-bar");
    target?.focus();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    // A menu a card opened lives outside the pane; its keys are its own.
    if (body === null || !body.contains(event.target as Node)) return;
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
    if (current === null) return;
    // The groups are in the document in the order they are shown.
    const cards = [...body.querySelectorAll<HTMLElement>("[data-board-card]")];
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
        <div
          className="sws-board-list"
          onFocus={(event) => {
            const card = (event.target as HTMLElement).closest<HTMLElement>(".sws-board-card");
            const group = card?.closest<HTMLElement>("[data-group]")?.dataset.group;
            const id = card?.dataset.increment;
            focused.current = id && group ? { id, group } : null;
          }}
          onBlur={() => {
            focused.current = null;
          }}
        >
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
          </div>
          {board !== null && !boardIsEmpty(board) ? (
            <BoardSummary notDone={boardNotDone(board)} behind={board.behind} now={now} />
          ) : null}
          <BoardMachineLegend
            options={machineOptions}
            pick={machine}
            answered={working.answered}
            cut={working.cut}
            onPick={setMachineChoice}
          />
          {board === null ? (
            <p className="sws-empty sws-pane-empty" role="status">
              {query.error ? `The board could not be read: ${query.error}` : "Reading increments…"}
            </p>
          ) : boardIsEmpty(board) ? (
            searched === "" ? (
              <div className="sws-empty sws-pane-empty sws-board-empty" role="status">
                <p>{BOARD_EMPTY_TEXT}</p>
                {onAsk ? (
                  <Button size="sm" variant="outline" onClick={() => onAsk(BOARD_EMPTY_PROMPT)}>
                    {BOARD_EMPTY_ACTION}
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="sws-empty sws-pane-empty" role="status">
                {`No increment matches "${searched}".`}
              </p>
            )
          ) : (
            <div className="sws-board-columns" data-layout={sideBySide ? "columns" : "stack"}>
              {order.map((group) => {
                const total = counts?.[group] ?? 0;
                // No stuck card: no Blocked group. The columns always show, even empty.
                if (group === "blocked" && total === 0) return null;
                const folded = isFolded(group);
                const limit = shown[group] ?? BOARD_COLUMN_PAGE;
                // Finished work is not narrowed by machine: it runs nowhere, and
                // only its newest cards are loaded. Its count stays the whole count.
                const unsorted = group === "done" && machine !== null;
                const more = unsorted
                  ? null
                  : boardColumnMore({
                      column: group,
                      held: held[group].length,
                      shown: limit,
                      loaded: groups[group].length,
                      total: board.counts.done,
                    });
                return (
                  <BoardGroupSection
                    key={group}
                    group={group}
                    label={BOARD_GROUP_LABELS[group]}
                    count={machine === null || unsorted ? total : held[group].length}
                    folded={folded}
                    locked={searching}
                    onToggle={() => toggleGroup(group, !folded)}
                  >
                    <div className="sws-board-cards">
                      {listed[group].map((card) => (
                        <BoardCard
                          key={card.incrementId}
                          card={card}
                          open={openId === card.incrementId}
                          threads={working.byIncrement.get(card.incrementId) ?? NO_THREADS}
                          threadsAnswered={working.answered}
                          multiMachine={working.multiMachine}
                          now={now}
                          viewId={viewId}
                          stateLabel={boardStateLabel(card)}
                          pullRequestStates={pullRequestStates}
                          onOpen={openCard}
                          onOpenThread={onOpenThread}
                          onOpenLink={onOpenLink}
                          onAsk={onAsk}
                        />
                      ))}
                    </div>
                    {unsorted ? (
                      <p className="sws-board-group-note">
                        Finished work is not sorted by machine. Choose All to see it.
                      </p>
                    ) : null}
                    {more ? (
                      <button
                        type="button"
                        className="sws-board-more"
                        disabled={more.kind === "older" && query.isPending}
                        onClick={() => {
                          if (more.kind === "older") {
                            setDoneLimit((value) =>
                              Math.min(PROJECT_BOARD_DONE_MAX, value + BOARD_DONE_STEP),
                            );
                            setShown((value) => ({ ...value, done: limit + BOARD_DONE_STEP }));
                          } else {
                            setShown((value) => ({ ...value, [group]: limit + BOARD_COLUMN_PAGE }));
                          }
                        }}
                      >
                        {more.label}
                      </button>
                    ) : null}
                  </BoardGroupSection>
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

/**
 * The Board's summary line: how many increments are not done, and, when the
 * project folder lags its default branch, by how much.
 */
function BoardSummary(props: {
  readonly notDone: number;
  readonly behind: ProjectBoardResult["behind"];
  readonly now: number;
}) {
  const tx = useTx();
  const behind = boardBehindLine(
    props.behind,
    tx,
    props.behind?.fetchedAt ? compactAge(props.behind.fetchedAt, props.now) : "",
  );
  return (
    <p className="sws-board-summary" data-board-summary="">
      <span className="sws-board-not-done" data-not-done={props.notDone}>
        {tx("{count} not done", { count: props.notDone })}
      </span>
      {behind ? (
        <span className="sws-board-behind" title={behind.title}>
          {behind.text}
        </span>
      ) : null}
    </p>
  );
}
