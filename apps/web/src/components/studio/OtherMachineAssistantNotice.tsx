import { openCommandPalette } from "../../commandPaletteBus";
import { useTx } from "../../i18n";
import { PERSONAL_ASSISTANT_PER_MACHINE_LINE } from "../../studio/personalAssistant";

/** On another machine's assistant: whose it is, why it cannot come here, and the way to this machine's own. */
export function OtherMachineAssistantNotice(props: { readonly machineName: string }) {
  const tx = useTx();
  return (
    <p className="project-notice" role="status" data-other-machine-assistant>
      {tx("This assistant lives on {name}.", { name: props.machineName })}{" "}
      {tx(PERSONAL_ASSISTANT_PER_MACHINE_LINE)}{" "}
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
