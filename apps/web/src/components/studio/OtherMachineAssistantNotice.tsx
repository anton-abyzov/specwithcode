import { openCommandPalette } from "../../commandPaletteBus";
import { useTx } from "../../i18n";
import { PERSONAL_ASSISTANT_SHARED_LINE } from "../../studio/personalAssistant";

/**
 * On another machine's assistant that is not joined to the linked Percy: where it
 * lives, the one rule, and the way to this machine's own. A linked seat shows none
 * of this: its chats are in Percy's one list (1448 AC-20).
 */
export function OtherMachineAssistantNotice(props: { readonly machineName: string }) {
  const tx = useTx();
  return (
    <p className="project-notice" role="status" data-other-machine-assistant>
      {tx("This assistant lives on {name}.", { name: props.machineName })}{" "}
      {tx(PERSONAL_ASSISTANT_SHARED_LINE)}{" "}
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => openCommandPalette({ open: "new-assistant" })}
      >
        {tx("Open this machine's assistant")}
      </button>
    </p>
  );
}
