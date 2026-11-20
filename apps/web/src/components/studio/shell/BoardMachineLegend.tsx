/**
 * "Runs on": what the colored edge of a card means, and the way to narrow the
 * board to one machine. Each entry shows the machine's color square (the one
 * the sidebar uses), its name and how many open cards it has. With two or
 * more entries they are toggles; with one there is nothing to narrow, so it
 * is only a legend. Until every thread has said which increment it works on
 * the cards of a machine are not all known, so nothing can be chosen.
 */
import { MachineDot } from "../../MachineDot";
import type { MachineColorId } from "@specweave-studio/contracts";
import { BOARD_NO_THREAD, type BoardMachineOption } from "../../../studio/projectBoardModel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

const describe = (option: BoardMachineOption) =>
  option.id === BOARD_NO_THREAD
    ? "Open increments with no thread, or only resolved ones"
    : `Open cards with a thread on ${option.name} carry this color on their left edge`;

export function BoardMachineLegend(props: {
  options: ReadonlyArray<BoardMachineOption>;
  /** The chosen entry, or null for every machine. */
  pick: string | null;
  /** Every thread has said which increment it works on; until then counts are not final. */
  answered: boolean;
  /** The project has more threads than are read: the counts never become final. */
  cut: boolean;
  onPick: (id: string | null) => void;
}) {
  const { options, pick, answered, cut } = props;
  // A choice can always be let go, also when its machine has no entry for now.
  if (options.length === 0 && pick === null) return null;
  // One entry is only a legend, unless it is the choice.
  const narrows = options.length > 1 || pick !== null;
  const entry = (option: BoardMachineOption) => (
    <>
      {option.color ? <MachineDot identity={{ color: option.color as MachineColorId }} /> : null}
      <span>{option.name}</span>
      {answered ? (
        <span className="sws-board-legend-count">
          {option.cards}
          <span className="sr-only"> {option.cards === 1 ? "card" : "cards"}</span>
        </span>
      ) : null}
    </>
  );
  return (
    <div className="sws-board-legend" role="group" aria-label="Machines the work runs on">
      <span className="sws-board-legend-label">Runs on</span>
      {narrows ? (
        <button
          type="button"
          className="sws-board-legend-entry"
          aria-pressed={pick === null}
          onClick={() => props.onPick(null)}
        >
          All
        </button>
      ) : null}
      {options.map((option) => (
        <Tooltip key={option.id}>
          <TooltipTrigger
            render={
              narrows ? (
                <button
                  type="button"
                  className="sws-board-legend-entry"
                  data-machine={option.id}
                  aria-pressed={pick === option.id}
                  // A choice already made can still be let go.
                  disabled={!answered && pick !== option.id}
                  onClick={() => props.onPick(pick === option.id ? null : option.id)}
                />
              ) : (
                <span className="sws-board-legend-entry" data-machine={option.id} />
              )
            }
          >
            {entry(option)}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{describe(option)}</TooltipPopup>
        </Tooltip>
      ))}
      {answered ? null : (
        <span className="sws-board-legend-note" role="status">
          {cut
            ? "This project has more threads than the board reads, so it cannot be narrowed by machine."
            : "Reading threads…"}
        </span>
      )}
    </div>
  );
}
