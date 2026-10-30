import type { MachineHandoffRetention } from "@specweave-studio/contracts";

/**
 * A large project's coordinator handoff carries the coordinator's newest
 * history and a summary of each worker chat (`context.retention`). An older
 * destination drops that summary and refuses the bundle, so it is checked
 * before the source is fenced.
 */
export const RETENTION_UPDATE_MESSAGE =
  "Update the other machine to move the coordinator of a project this large. Nothing moved; the coordinator stays here.";

/** What a bundle left on the source, or null when every transcript moved (or no context was read). */
export const retentionOf = (bundle: {
  readonly context?: { readonly retention?: MachineHandoffRetention | undefined } | undefined;
}): MachineHandoffRetention | null => bundle.context?.retention ?? null;

/** Whether a destination's folder copy capabilities accept a summarized handoff. */
export const acceptsRetention = (capabilities: unknown) =>
  typeof capabilities === "object" &&
  capabilities !== null &&
  (capabilities as { readonly contextRetention?: unknown }).contextRetention === 1;

/**
 * Whether everything the handoff left behind is on the machine it leaves. After
 * an earlier summarized handoff, older messages and worker chats can be on other
 * machines, the destination among them.
 */
export const allLeftOnSource = (retention: MachineHandoffRetention) =>
  (retention.machines?.length ?? 0) <= 1;

const count = (value: number, one: string, many: string) =>
  `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;

/** The Git dialog's review line for what moves. */
export function retentionReviewText(repositories: number, retention: MachineHandoffRetention) {
  const total = retention.coordinatorMessages + retention.omittedMessages;
  return (
    `${count(repositories, "repository", "repositories")}, the latest ` +
    `${retention.coordinatorMessages.toLocaleString("en-US")} of ${count(total, "coordinator message", "coordinator messages")} ` +
    `and a summary of ${retention.workers.length.toLocaleString("en-US")} of ${count(retention.totalThreads, "worker chat", "worker chats")}. ` +
    (allLeftOnSource(retention)
      ? "Older messages and worker transcripts stay here."
      : "Older messages and worker transcripts stay on the machines they were written on.")
  );
}

/** The folder copy's done line for a moved coordinator. */
export function retentionMovedText(
  retention: MachineHandoffRetention,
  sourceLabel: string,
  targetLabel: string,
) {
  return (
    `The coordinator moved with its latest ${count(retention.coordinatorMessages, "message", "messages")}. ` +
    `${count(retention.omittedMessages, "older message", "older messages")} and ` +
    `${count(retention.totalThreads, "worker chat", "worker chats")} stay on ` +
    `${allLeftOnSource(retention) ? sourceLabel : "the machines they were written on"}; ` +
    `${targetLabel} has a summary of the ${count(retention.workers.length, "most recent worker", "most recent workers")}.`
  );
}

/**
 * The Git review's warning for workers whose branch or worktree holds commits or
 * changes the handoff does not push, or could not be checked; null when every
 * worker's code is in the commits.
 */
export function unmergedWorkersText(retention: MachineHandoffRetention, sourceLabel: string) {
  const total = retention.unmergedWorkerCount ?? 0;
  if (total === 0) return null;
  return (
    `${count(total, "worker chat has", "worker chats have")} a branch or worktree with commits ` +
    `or changes these do not include, or one that could not be checked. That work stays only on ` +
    `${sourceLabel} until it is merged; merge it first to take it along.`
  );
}

/** A listed unmerged worker's line: its title and where its code is. */
export const unmergedWorkerLine = (
  worker: NonNullable<MachineHandoffRetention["unmergedWorkers"]>[number],
) => [worker.title, worker.branch ?? worker.worktreePath].filter(Boolean).join(" · ");
