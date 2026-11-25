import type { OrchestrationV2ConversationMessage } from "@specweave-studio/contracts";

type SenderFields = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "creationSource" | "scheduledTaskId" | "senderThreadId" | "peerMessage"
>;

/**
 * Whether a person typed this message, on any of their devices (web, desktop,
 * phone, another machine's window). A message another agent sent or routed, a
 * routine's prompt and server text are not. Unknown senders count as not a
 * person, so actions only a person may take from chat fail closed.
 */
export function messageSentByPerson(message: SenderFields): boolean {
  return (
    message.createdBy === "user" &&
    message.scheduledTaskId === undefined &&
    message.senderThreadId === undefined &&
    message.peerMessage === undefined &&
    message.creationSource !== "mcp" &&
    message.creationSource !== "provider"
  );
}

// Providers read slash commands and `$skill` mentions from the start of a prompt.
const LEADING_COMMAND = /^\s*(?:\/|\$[A-Za-z0-9:_-]*[A-Za-z])/u;

function senderNote(message: SenderFields): string | undefined {
  if (message.createdBy === "agent" && message.senderThreadId !== undefined) {
    return `[SpecWithCode: the agent in thread ${JSON.stringify(message.senderThreadId)} sent this message, not the person using this chat.]`;
  }
  if (
    message.createdBy === "agent" &&
    message.peerMessage !== undefined &&
    message.peerMessage.direction === "incoming"
  ) {
    return `[SpecWithCode: the coordinator on linked machine ${JSON.stringify(message.peerMessage.fromEnvironmentId)} sent this message, not the person using this chat.]`;
  }
  if (message.scheduledTaskId !== undefined) {
    return `[SpecWithCode: routine ${JSON.stringify(message.scheduledTaskId)} sent this prompt on its schedule, not the person using this chat.]`;
  }
  if (message.createdBy === "agent" && message.creationSource === "mcp") {
    return "[SpecWithCode: a tool caller sent this message through SpecWithCode's tools, not the person using this chat.]";
  }
  return undefined;
}

/**
 * The provider text with one leading line naming who sent it, when an agent,
 * a routine or a tool caller did, so the model never takes it for the
 * person's own instruction. A person's message, and any text that starts with
 * a slash command or a `$skill` mention, is returned unchanged. Only the text
 * sent to the provider carries the note; the stored message keeps its words.
 */
export function withMessageSenderNote(message: SenderFields, text: string): string {
  const note = senderNote(message);
  if (note === undefined || LEADING_COMMAND.test(text)) return text;
  return text.length === 0 ? note : `${note}\n\n${text}`;
}
