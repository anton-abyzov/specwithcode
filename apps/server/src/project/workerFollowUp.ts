/**
 * A message typed in a worker's thread is stored on the coordinator with this
 * one-line wrapper. It names the message so the coordinator can forward it
 * unchanged with studio_thread_send forwardMessageId.
 */
export function workerFollowUpPrefix(sourceThreadId: string, messageId: string): string {
  return `User follow-up from selected worker ${sourceThreadId}, message ${messageId}. Review that thread and decide whether to reuse it or route elsewhere.\n\n`;
}

/** Wrappers stored before messages named their own ID. */
function legacyWorkerFollowUpPrefix(sourceThreadId: string): string {
  return `User follow-up from selected worker ${sourceThreadId}. Review that thread and decide whether to reuse it or route elsewhere.\n\n`;
}

/** The user's own words, or null when the text does not carry this message's wrapper. */
export function workerFollowUpText(message: {
  readonly id: string;
  readonly text: string;
  readonly senderThreadId?: string | undefined;
}): string | null {
  if (!message.senderThreadId) return null;
  for (const prefix of [
    workerFollowUpPrefix(message.senderThreadId, message.id),
    legacyWorkerFollowUpPrefix(message.senderThreadId),
  ])
    if (message.text.startsWith(prefix)) return message.text.slice(prefix.length);
  return null;
}
