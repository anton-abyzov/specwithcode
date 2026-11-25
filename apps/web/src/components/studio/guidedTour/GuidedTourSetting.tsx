/** Settings > General > Guided tour: the button that starts the tour again (1486 AC-05). */
import { SignpostIcon } from "lucide-react";

import { useTx } from "../../../i18n";
import { Button } from "../../ui/button";
import { GUIDED_TOUR_START } from "./guidedTour.logic";
import { startGuidedTour } from "./guidedTourStore";

export function GuidedTourButton({ onStart }: { readonly onStart?: () => void }) {
  const tx = useTx();
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      data-guided-tour-start=""
      onClick={() => {
        onStart?.();
        startGuidedTour();
      }}
    >
      <SignpostIcon aria-hidden="true" />
      {tx(GUIDED_TOUR_START)}
    </Button>
  );
}
