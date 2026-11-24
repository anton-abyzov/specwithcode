/**
 * The sidebar's assistant offer (1448 AC-11). "Use my Percy on <machine>"
 * opens the machine's switch in Settings > General while it is off and an
 * assistant exists elsewhere; "Set up" makes the first assistant.
 *
 * @module AssistantOfferRow
 */
import {
  PERSONAL_ASSISTANT_DESCRIPTION,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { ConciergeBellIcon } from "lucide-react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { usePrimarySettings } from "../../../hooks/useSettings";
import { useTx } from "../../../i18n";
import {
  PERSONAL_ASSISTANT_SHARED_LINE,
  personalAssistantSidebarOffer,
  USE_MY_PERCY_PHRASE,
} from "../../../studio/personalAssistant";
import { PERCY_SHARED_SETTING_ID } from "../../../studio/personalShare";
import { Tip } from "./Tip";

export function AssistantOfferRow(props: {
  readonly assistants: Parameters<typeof personalAssistantSidebarOffer>[0]["assistants"];
  readonly ownEnvironmentId: string | null;
  readonly ownMachineLabel: string | null;
  readonly machineCount: number;
  readonly onOpen: () => void;
}) {
  const tx = useTx();
  const sharedHere = usePrimarySettings(
    (settings) => settings.personalAssistantShared?.enabled === true,
  );
  const offer = personalAssistantSidebarOffer({
    assistants: props.assistants,
    ownEnvironmentId: props.ownEnvironmentId,
    ownMachineLabel: props.ownMachineLabel,
    machineCount: props.machineCount,
    sharedHere,
  });
  if (offer === null) return null;
  const tip = `${tx(PERSONAL_ASSISTANT_DESCRIPTION)} ${tx(PERSONAL_ASSISTANT_SHARED_LINE)}`;
  if (offer.kind === "share") {
    return (
      <Tip side="right" label={tip}>
        <Link
          to="/settings/general"
          hash={PERCY_SHARED_SETTING_ID}
          className="sws-side-row sws-side-row-quiet"
          data-assistant-offer="share"
          onClick={props.onOpen}
        >
          <ConciergeBellIcon aria-hidden />
          <span className="sws-side-row-label">
            {tx(USE_MY_PERCY_PHRASE, { machine: offer.machine })}
          </span>
        </Link>
      </Tip>
    );
  }
  return (
    <Tip side="right" label={tip}>
      <button
        type="button"
        className="sws-side-row sws-side-row-quiet"
        data-assistant-offer="create"
        onClick={() => {
          props.onOpen();
          openCommandPalette({ open: "new-assistant" });
        }}
      >
        <ConciergeBellIcon aria-hidden />
        <span className="sws-side-row-label">{tx(PERSONAL_ASSISTANT_LABEL)}</span>
        <span className="sws-side-row-hint">{tx(offer.label)}</span>
      </button>
    </Tip>
  );
}
