/**
 * The project's Board tab: its SpecWeave increments as cards in Planned,
 * Active, In review and Done, read from the increment files by
 * `projects.board`. Side by side when the panel is wide, stacked with the
 * work in motion first when it is narrow. Every part of a card is clickable:
 * the card opens the thread working on it (its spec when several threads or
 * none do), each thread line opens that thread, a chip opens a pull request
 * or the spec, and an open card with no thread hands the coordinator a
 * request to start it. A project without SpecWeave gets the switch to turn
 * the board on instead of a hidden tab.
 */
import type { EnvironmentId, ProjectBoardCard, ProjectId } from "@specweave-studio/contracts";
import { PROJECT_BOARD_DONE_DEFAULT, PROJECT_BOARD_DONE_MAX } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { FileTextIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useOpenLink } from "../../../browser/useOpenLink";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../../state/query";
import {
  BOARD_COLUMN_LABELS,
  BOARD_COLUMN_PAGE,
  BOARD_DONE_STEP,
  BOARD_STACK_ORDER,
  PROJECT_BOARD_COLUMNS,
  boardAsk,
  boardCardTarget,
  boardCardTitle,
  boardColumnMore,
  boardColumns,
  boardIsEmpty,
  boardProgress,
  incrementNumber,
  pullRequestLabel,
} from "../../../studio/projectBoardModel";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import { compactAge, nowFromMinute } from "../../../studio/shellModel";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { BoardThreadLines, useBoardThreads } from "./BoardThreads";
import { LibraryFileViewer } from "./LibraryFileViewer";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";

/** How often an open board asks again; the server re-reads only files that changed. */
const BOARD_REFRESH_MS = 30_000;

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
            The board shows the project's work as cards in Planned, Active, In review and Done,
            each with its tasks, pull requests and the threads working on it. It is built from
            SpecWeave increments, so turn SpecWeave on to get one.
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
}: BoardPaneProps) {
  const [filter, setFilter] = useState("");
  const [searched, setSearched] = useState("");
  const [doneLimit, setDoneLimit] = useState(PROJECT_BOARD_DONE_DEFAULT);
  const [shown, setShown] = useState<Partial<Record<ProjectBoardCard["column"], number>>>({});
  const [opened, setOpened] = useState<{ path: string; name: string } | null>(null);
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
  const refresh = query.refresh;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const openLink = useOpenLink(null);
  const now = nowFromMinute(useNowMinute());
  const columns = useMemo(() => boardColumns(data?.cards ?? []), [data]);
  const working = useBoardThreads({ environmentId, threads, machineLabels });

  return (
    <>
      <ProjectPaneBar {...bar} />
      <div
        className="sws-threads-body sws-board"
        id="sws-pane-board"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-board"
      >
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
        {data === null ? (
          <p className="sws-empty sws-pane-empty" role="status">
            {query.error ? `The board could not be read: ${query.error}` : "Reading increments…"}
          </p>
        ) : boardIsEmpty(data) ? (
          <p className="sws-empty sws-pane-empty" role="status">
            {searched === ""
              ? "No increments yet. Plan one with specweave create-increment and it shows here."
              : `No increment matches "${searched}".`}
          </p>
        ) : (
          <div className="sws-board-columns">
            {PROJECT_BOARD_COLUMNS.map((column) => {
              const held = columns[column];
              const limit = shown[column] ?? BOARD_COLUMN_PAGE;
              const more = boardColumnMore({
                column,
                held: held.length,
                shown: limit,
                total: data.counts[column],
              });
              const headingId = `sws-board-${column}`;
              return (
                <section
                  className="sws-board-column"
                  key={column}
                  data-column={column}
                  aria-labelledby={headingId}
                  style={{ order: BOARD_STACK_ORDER[column] }}
                >
                  <h3 id={headingId} className="sws-pane-group-heading">
                    {BOARD_COLUMN_LABELS[column]}
                    <span className="sws-group-count">
                      {data.counts[column]}
                      <span className="sr-only"> increments</span>
                    </span>
                  </h3>
                  <div className="sws-board-cards">
                    {held.slice(0, limit).map((card) => {
                      const progress = boardProgress(card.tasks);
                      const title = boardCardTitle(card);
                      const specPath = card.specPath;
                      const number = incrementNumber(card.incrementId);
                      const cardThreads = working.byIncrement.get(card.incrementId) ?? [];
                      const lead = cardThreads[0];
                      const target = boardCardTarget({ threads: cardThreads.length, specPath });
                      // Until the threads have answered, an empty card is not known to be free.
                      const ask =
                        cardThreads.length === 0 && working.answered && onAsk
                          ? boardAsk(card)
                          : null;
                      const openSpec =
                        specPath === null
                          ? null
                          : () => setOpened({ path: specPath, name: `${number} spec.md` });
                      // The card's edge takes the color of the machine its work runs on.
                      const accent =
                        lead && lead.tone !== "resolved" && (working.multiMachine || lead.machine.moved)
                          ? lead.color
                          : undefined;
                      const body = (
                        <>
                          <span className="sws-board-card-top">
                            <span className="sws-board-card-id">
                              {incrementNumber(card.incrementId)}
                            </span>
                            {card.updatedAt ? (
                              <time className="sws-thread-age" dateTime={card.updatedAt}>
                                {compactAge(card.updatedAt, now)}
                              </time>
                            ) : null}
                          </span>
                          <strong className="sws-board-card-title">{title}</strong>
                          {progress && column !== "done" ? (
                            <span className="sws-board-meter" aria-hidden>
                              <span style={{ width: `${progress.percent}%` }} />
                            </span>
                          ) : null}
                        </>
                      );
                      return (
                        <article
                          className="sws-board-card"
                          key={card.incrementId}
                          data-increment={card.incrementId}
                          data-blocked={card.blocked ? "" : undefined}
                          data-machine-color={accent}
                        >
                          {target === "thread" && lead ? (
                            <button
                              type="button"
                              className="sws-board-card-open"
                              aria-label={`Open the thread working on ${number} ${title}`}
                              onClick={() => onOpenThread(lead.thread)}
                            >
                              {body}
                            </button>
                          ) : openSpec ? (
                            <button
                              type="button"
                              className="sws-board-card-open"
                              aria-label={`Open the spec of ${number} ${title}`}
                              onClick={openSpec}
                            >
                              {body}
                            </button>
                          ) : (
                            <div className="sws-board-card-open">{body}</div>
                          )}
                          <BoardThreadLines
                            threads={cardThreads}
                            showMachine={working.multiMachine}
                            onOpen={onOpenThread}
                          />
                          {progress ||
                          card.blocked ||
                          card.pullRequests.length > 0 ||
                          ask ||
                          (target === "thread" && openSpec) ? (
                            <div className="sws-board-card-chips">
                              {progress ? <span className="sws-chip">{progress.label}</span> : null}
                              {card.blocked ? (
                                <span className="sws-chip sws-board-chip-blocked">
                                  {card.status === "paused" ? "Paused" : "Blocked"}
                                </span>
                              ) : null}
                              {card.pullRequests.map((url) => (
                                <button
                                  type="button"
                                  className="sws-chip"
                                  key={url}
                                  aria-label={`Open pull request ${pullRequestLabel(url)}`}
                                  onClick={() => void openLink(url).catch(() => undefined)}
                                >
                                  <PullRequestGlyph.pullRequest aria-hidden />
                                  {pullRequestLabel(url)}
                                </button>
                              ))}
                              {target === "thread" && openSpec ? (
                                <button
                                  type="button"
                                  className="sws-chip"
                                  aria-label={`Open the spec of ${number} ${title}`}
                                  onClick={openSpec}
                                >
                                  <FileTextIcon aria-hidden />
                                  Spec
                                </button>
                              ) : null}
                              {ask && onAsk ? (
                                <button
                                  type="button"
                                  className="sws-chip sws-board-chip-ask"
                                  aria-label={`${ask.label} ${number} ${title} with the coordinator`}
                                  onClick={() => onAsk(ask.prompt)}
                                >
                                  {ask.label}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
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
      {working.loaders}
      {opened ? (
        <LibraryFileViewer
          environmentId={environmentId}
          workspaceRoot={workspaceRoot}
          files={[opened]}
          path={opened.path}
          onPath={() => undefined}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}
