/**
 * One board card. The card itself always opens the increment view; its thread
 * lines, pull request chips and the request for the coordinator keep their
 * own targets. A stuck card says what is stuck and why, never a bare word.
 */
import type { ProjectBoardCard } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { TriangleAlertIcon } from "lucide-react";

import {
  BOARD_CARD_REASONS,
  boardAsk,
  boardBlockedChip,
  boardCardBlocked,
  boardCardTitle,
  boardProgress,
  boardReasons,
  boardRestCanContinue,
  incrementNumber,
  pullRequestLabel,
  threadIsLive,
} from "../../../studio/projectBoardModel";
import { compactAge } from "../../../studio/shellModel";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
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
  onOpen,
  onOpenThread,
  onOpenLink,
  onAsk,
}: BoardCardProps) {
  const progress = boardProgress(card.tasks);
  const title = boardCardTitle(card);
  const number = incrementNumber(card.incrementId);
  const lead = threads[0];
  // Until the threads have answered, an empty card is not known to be free.
  const ask = threads.length === 0 && threadsAnswered && onAsk ? boardAsk(card) : null;
  // The card's edge takes the color of the machine its work runs on.
  const accent =
    lead && threadIsLive(lead.tone) && (multiMachine || lead.machine.moved)
      ? lead.color
      : undefined;
  const chip = boardBlockedChip(card);
  const reasons = boardReasons(card);
  const shownReasons = reasons.slice(0, BOARD_CARD_REASONS);
  const moreReasons = reasons.length - shownReasons.length;
  return (
    <article
      className="sws-board-card"
      data-increment={card.incrementId}
      data-blocked={boardCardBlocked(card) ? "" : undefined}
      data-open={open ? "" : undefined}
      data-machine-color={accent}
    >
      <button
        type="button"
        className="sws-board-card-open"
        data-board-card={card.incrementId}
        aria-label={`Open ${number} ${title}`}
        aria-expanded={open}
        aria-controls={open ? viewId : undefined}
        onClick={() => onOpen(card.incrementId)}
      >
        <span className="sws-board-card-top">
          <span className="sws-board-card-id">{number}</span>
          {card.updatedAt ? (
            <time className="sws-thread-age" dateTime={card.updatedAt}>
              {compactAge(card.updatedAt, now)}
            </time>
          ) : null}
        </span>
        <strong className="sws-board-card-title">{title}</strong>
        {progress && card.column !== "done" ? (
          <span className="sws-board-meter" aria-hidden>
            <span style={{ width: `${progress.percent}%` }} />
          </span>
        ) : null}
      </button>
      {shownReasons.length > 0 ? (
        <ul className="sws-board-reasons" aria-label="Why it is blocked">
          {shownReasons.map((reason) => (
            <li key={reason.taskId ?? "paused"} className="sws-board-reason">
              <TriangleAlertIcon aria-hidden />
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
      <BoardThreadLines threads={threads} showMachine={multiMachine} onOpen={onOpenThread} />
      {progress || chip || card.pullRequests.length > 0 || ask ? (
        <div className="sws-board-card-chips">
          {progress ? <span className="sws-chip">{progress.label}</span> : null}
          {chip ? <span className="sws-chip sws-board-chip-blocked">{chip}</span> : null}
          {boardRestCanContinue(card) ? (
            <span className="sws-board-rest">rest can continue</span>
          ) : null}
          {card.pullRequests.map((url) => (
            <button
              type="button"
              className="sws-chip"
              key={url}
              aria-label={`Open pull request ${pullRequestLabel(url)}`}
              onClick={() => onOpenLink(url)}
            >
              <PullRequestGlyph.pullRequest aria-hidden />
              {pullRequestLabel(url)}
            </button>
          ))}
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
}
