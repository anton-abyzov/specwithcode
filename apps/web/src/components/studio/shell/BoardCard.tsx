/**
 * One board card, in at most four parts: the number and title; one status row
 * with the meter, the task count, the pull requests and the card's one action;
 * what is stuck and why; the threads on it. The card itself always opens the
 * increment view; its thread lines, the pull request chip and the action keep
 * their own targets. A stuck card says what is stuck and why, never a bare word.
 */
import type { ProjectBoardCard } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useId } from "react";

import { viewPrimaryAction } from "../../../studio/boardIncrementModel";
import {
  BOARD_CARD_REASONS,
  BOARD_EDGE_MACHINES,
  boardBlockedChip,
  boardCardBlocked,
  boardCardMachines,
  boardCardTitle,
  boardEdgeLabel,
  boardOutOfReachNote,
  boardProgress,
  boardPullRequestChip,
  boardReasons,
  boardRestCanContinue,
  boardSourceLine,
  boardSourceTitle,
  incrementNumber,
  threadIsLive,
} from "../../../studio/projectBoardModel";
import { useTx } from "../../../i18n";
import { compactAge } from "../../../studio/shellModel";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { BoardThreadLines, type BoardThread } from "./BoardThreads";

export interface BoardCardProps {
  card: ProjectBoardCard;
  /** Its increment view is open. */
  open: boolean;
  threads: ReadonlyArray<BoardThread>;
  /** Every thread has said which increment it works on. */
  threadsAnswered: boolean;
  multiMachine: boolean;
  now: number;
  /** The id of the view region, for the card's `aria-controls`. */
  viewId: string;
  /** Under Blocked, the state the card left: "Active", "In review" or "Planned". */
  stateLabel?: string | undefined;
  /** What the project's threads say of a pull request, by URL: "Open", "Merged"… */
  pullRequestStates?: ReadonlyMap<string, string> | undefined;
  onOpen: (incrementId: string) => void;
  onOpenThread: (thread: EnvironmentThreadShell) => void;
  onOpenLink: (url: string) => void;
  onAsk?: ((prompt: string) => void) | undefined;
}

export function BoardCard({
  card,
  open,
  threads,
  threadsAnswered,
  multiMachine,
  now,
  viewId,
  stateLabel,
  pullRequestStates,
  onOpen,
  onOpenThread,
  onOpenLink,
  onAsk,
}: BoardCardProps) {
  const countId = useId();
  const tx = useTx();
  const progress = card.column === "done" ? null : boardProgress(card.tasks);
  const title = boardCardTitle(card);
  const number = incrementNumber(card.incrementId);
  // The edge takes the color of every machine the card's open work runs on;
  // finished work runs nowhere.
  const machines = boardCardMachines(threads);
  const colored =
    multiMachine || threads.some((entry) => entry.machine.moved && entry.tone !== "resolved");
  const edge = colored && card.column !== "done" ? machines : [];
  // One action, by the rule the increment view uses: a thread that can be
  // opened, else a request for the coordinator. Until the threads have
  // answered, a card with none is not known to be free. A thread on a machine
  // that cannot be reached may still hold the work, so the request names it
  // and asks the coordinator to check before starting anyone.
  const live = threads.find((entry) => threadIsLive(entry.tone));
  const primary = viewPrimaryAction({ card, abandoned: false, liveThreads: live ? 1 : 0 });
  const openThread = primary?.kind === "thread" && live ? live.thread : null;
  const ask =
    primary?.kind === "ask" && threadsAnswered && onAsk
      ? { ...primary, prompt: primary.prompt + boardOutOfReachNote(threads) }
      : null;
  const pulls = boardPullRequestChip(card.pullRequests);
  const chip = boardBlockedChip(card);
  const reasons = boardReasons(card);
  const shownReasons = reasons.slice(0, BOARD_CARD_REASONS);
  const moreReasons = reasons.length - shownReasons.length;
  // "Paused" over a line that starts "Paused:" would say it twice.
  const stuck = chip !== null && !(chip === "Paused" && reasons.length > 0) ? chip : null;
  const hasStatus = progress !== null || pulls !== null || ask !== null || openThread !== null;
  return (
    <article
      className="sws-board-card"
      data-increment={card.incrementId}
      data-blocked={boardCardBlocked(card) ? "" : undefined}
      data-open={open ? "" : undefined}
      data-edge={edge.length > 0 ? "" : undefined}
    >
      {edge.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="sws-board-card-edge" role="img" aria-label={boardEdgeLabel(edge)} />
            }
          >
            {edge.slice(0, BOARD_EDGE_MACHINES).map((machine) => (
              <span
                key={machine.id}
                data-machine-color={machine.color}
                data-machine={machine.name}
              />
            ))}
          </TooltipTrigger>
          <TooltipPopup side="right">{boardEdgeLabel(edge)}</TooltipPopup>
        </Tooltip>
      ) : null}
      <button
        type="button"
        className="sws-board-card-open"
        data-board-card={card.incrementId}
        aria-label={`Open ${number} ${title}`}
        aria-describedby={progress ? countId : undefined}
        aria-expanded={open}
        aria-controls={open ? viewId : undefined}
        onClick={() => onOpen(card.incrementId)}
      >
        <span className="sws-board-card-top">
          <strong className="sws-board-card-title">
            <span className="sws-board-card-id">{number}</span>
            {title}
          </strong>
          <span className="sws-board-card-aside">
            {stateLabel ? <span className="sws-board-card-state">{stateLabel}</span> : null}
            {card.updatedAt ? (
              <time className="sws-thread-age" dateTime={card.updatedAt}>
                {compactAge(card.updatedAt, now)}
              </time>
            ) : null}
          </span>
        </span>
      </button>
      {hasStatus ? (
        <div className="sws-board-card-status">
          {progress ? (
            <>
              <span className="sws-board-meter" aria-hidden>
                <span style={{ width: `${progress.percent}%` }} />
              </span>
              <span className="sws-board-card-count" id={countId}>
                {Math.min(card.tasks.done, card.tasks.total)}/{card.tasks.total}
                <span className="sr-only"> {card.tasks.total === 1 ? "task" : "tasks"} done</span>
              </span>
            </>
          ) : null}
          <span className="sws-board-card-fill" />
          {pulls?.kind === "one" ? (
            <button
              type="button"
              className="sws-chip"
              aria-label={`Open pull request ${pulls.label}`}
              onClick={() => onOpenLink(pulls.url)}
            >
              <PullRequestGlyph.pullRequest aria-hidden />
              {pulls.label}
            </button>
          ) : pulls ? (
            <Menu>
              <MenuTrigger
                render={<button type="button" className="sws-chip sws-board-chip-pulls" />}
                aria-label={`${pulls.label} on ${number}: choose one to open`}
              >
                <PullRequestGlyph.pullRequest aria-hidden />
                {pulls.label}
                <ChevronDownIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom" className="min-w-40">
                {pulls.items.map((item) => (
                  <MenuItem key={item.url} onClick={() => onOpenLink(item.url)}>
                    <span className="flex w-full items-center justify-between gap-6">
                      <span className="font-mono">{item.label}</span>
                      {pullRequestStates?.get(item.url) ? (
                        <span className="text-muted-foreground">
                          {pullRequestStates.get(item.url)}
                        </span>
                      ) : null}
                    </span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
          {openThread ? (
            <button
              type="button"
              className="sws-board-action"
              aria-label={`Open thread ${openThread.title} on ${number}`}
              onClick={() => onOpenThread(openThread)}
            >
              Open thread
            </button>
          ) : ask && onAsk ? (
            <button
              type="button"
              className="sws-board-action"
              aria-label={`${ask.label} ${number} ${title} with the coordinator`}
              onClick={() => onAsk(ask.prompt)}
            >
              {ask.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {card.source ? (
        <p className="sws-board-card-source" title={boardSourceTitle(tx)}>
          {boardSourceLine(card.source, tx)}
        </p>
      ) : null}
      {stuck !== null || shownReasons.length > 0 ? (
        <ul className="sws-board-reasons" aria-label="Why it is blocked">
          {stuck !== null ? (
            <li className="sws-board-stuck">
              <TriangleAlertIcon aria-hidden />
              <span>
                <span className="sws-board-chip-blocked">{stuck}</span>
                {boardRestCanContinue(card) ? (
                  <span className="sws-board-rest"> · rest can continue</span>
                ) : null}
              </span>
            </li>
          ) : null}
          {shownReasons.map((reason) => (
            <li key={reason.taskId ?? "paused"} className="sws-board-reason">
              <span className="sws-board-reason-text">
                <strong>{reason.taskId ?? "Paused:"}</strong> {reason.text}
              </span>
            </li>
          ))}
          {moreReasons > 0 ? (
            <li className="sws-board-reason-more">
              and {moreReasons} more, open the card to see {moreReasons === 1 ? "it" : "them"}
            </li>
          ) : null}
        </ul>
      ) : null}
      <BoardThreadLines threads={threads} showMachine={colored} onOpen={onOpenThread} />
    </article>
  );
}
