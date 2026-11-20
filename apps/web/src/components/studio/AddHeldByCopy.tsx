/**
 * What "Add to another machine…" shows while a copy or a move to another machine is not
 * finished: the project keeps one such copy at a time, so Add starts none and leaves that
 * one as it is. The button opens it, which is a separate choice.
 *
 * @module AddHeldByCopy
 */
import { useTx } from "../../i18n";
import { Button } from "../ui/button";

export function AddHeldByCopy({
  machine,
  onOpen,
}: {
  /** The machine the unfinished copy goes to, as the window names it; null when unknown. */
  readonly machine: string | null;
  readonly onOpen: () => void;
}) {
  const tx = useTx();
  return (
    <div className="flex flex-col items-start gap-3 text-sm" data-slot="add-held" role="status">
      <p>
        {machine
          ? tx(
              "A copy to {machine} is not finished. Finish or cancel it, then add another machine.",
              { machine },
            )
          : tx("A copy is not finished. Finish or cancel it, then add another machine.")}
      </p>
      <Button variant="outline" onClick={onOpen}>
        {tx("Open the unfinished copy")}
      </Button>
    </div>
  );
}
