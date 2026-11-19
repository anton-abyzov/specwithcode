/**
 * What a plain send to another machine does, said for a screen reader and the
 * tooltip. Send never prints the machine; this sentence is where it is named.
 *
 * `startsThreads` is null for a thread that exists. A new draft has no thread
 * yet: its send starts one, or one per selected model.
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
        ? tx("Start {count} threads on {machine}")
        : tx("Start a thread on {machine}");
  // The machine is a name a person gave it: put in as it is, never as a pattern.
  return phrase.replace(/\{(count|machine)\}/gu, (_place, name: string) =>
    name === "count" ? String(startsThreads) : machine,
  );
}
