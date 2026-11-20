/**
 * What a plain send to another machine does, said for a screen reader and the
 * tooltip. Send never prints the machine; this sentence is where it is named.
 *
 * `startsThreads` is null for a thread that exists. A new draft has no thread
 * yet: its send starts one, or one per selected model. The sentence carries no
 * count, because a phrase has one form and a count needs several in some languages.
 */
export function machineSendLabel(
  tx: (phrase: string) => string,
  machine: string,
  startsThreads: number | null,
): string {
  const phrase =
    startsThreads === null
      ? tx("Send to this thread on {machine}")
      : startsThreads > 1
        ? tx("Start one thread per model on {machine}")
        : tx("Start a thread on {machine}");
  // The machine is a name a person gave it: put in as it is, never as a pattern.
  return phrase.replace("{machine}", () => machine);
}

/**
 * The folded phone box's Send. A plain send to another machine wears that
 * machine's color and says where it goes, as the open box's Send does. Resume,
 * a send with credits and a running turn keep the label and color they have.
 */
export function foldedMachineSend(input: {
  /** The label without a machine: resume, credits or a plain send. */
  readonly label: string;
  /** The button sends the draft as it is: not resume, not credits, no turn running. */
  readonly plainSend: boolean;
  readonly target: { readonly name: string; readonly color: string } | null;
  readonly startsThreads: number | null;
  readonly tx: (phrase: string) => string;
}): {
  readonly label: string;
  readonly className: string | null;
  readonly attributes: { readonly "data-machine-color"?: string; readonly "data-send-target"?: "" };
} {
  if (!input.plainSend || input.target === null)
    return { label: input.label, className: null, attributes: {} };
  return {
    label: machineSendLabel(input.tx, input.target.name, input.startsThreads),
    className: "machine-send",
    attributes: { "data-machine-color": input.target.color, "data-send-target": "" },
  };
}
