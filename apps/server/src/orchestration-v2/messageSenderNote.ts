import type { OrchestrationV2ConversationMessage } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { questionAnswerRequestId } from "./questionAnswerText.ts";

type SenderFields = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "creationSource" | "scheduledTaskId" | "senderThreadId" | "peerMessage"
> & { readonly attachments?: ReadonlyArray<unknown> };

/**
 * A bare `/compact` without attachments, in any case: the app compacts the
 * conversation itself (RunExecutionService) instead of sending a turn, so a
 * note would turn it into an ordinary prompt.
 */
function isAppCompaction(message: SenderFields, text: string): boolean {
  return (message.attachments?.length ?? 0) === 0 && text.trim().toLowerCase() === "/compact";
}

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

/** The slash commands and skills the thread's provider instance lists, without `/` or `$`. */
export interface KnownProviderCommands {
  readonly slash: ReadonlySet<string>;
  readonly skills: ReadonlySet<string>;
}

const LEADING_SLASH_COMMAND = /^\s*\/([^\s/]+)(?:\s|$)/u;
const LEADING_SKILL = /^\s*\$([A-Za-z0-9:_-]*[A-Za-z])(?:\s|$)/u;

/**
 * Whether the text starts with a command or skill the provider lists, which a
 * leading note would stop it from reading. A path such as `/tmp` or any word
 * the provider does not list is ordinary text. Names match exactly, as the
 * providers resolve them: `/Review` is not `/review`.
 */
function startsWithKnownCommand(text: string, known: KnownProviderCommands | undefined): boolean {
  if (known === undefined) return false;
  const slash = LEADING_SLASH_COMMAND.exec(text)?.[1];
  if (slash !== undefined) return known.slash.has(slash);
  const skill = LEADING_SKILL.exec(text)?.[1];
  return skill !== undefined && known.skills.has(skill);
}

function senderNote(message: SenderFields): string | undefined {
  // An agent's message, or one it forwarded under the person's name.
  if (message.senderThreadId !== undefined) {
    return `[SpecWithCode: the agent in thread ${JSON.stringify(message.senderThreadId)} sent this message, not the person using this chat.]`;
  }
  if (message.peerMessage !== undefined && message.peerMessage.direction === "incoming") {
    return `[SpecWithCode: the coordinator on linked machine ${JSON.stringify(message.peerMessage.fromEnvironmentId)} sent this message, not the person using this chat.]`;
  }
  if (message.scheduledTaskId !== undefined) {
    return `[SpecWithCode: routine ${JSON.stringify(message.scheduledTaskId)} sent this prompt on its schedule, not the person using this chat.]`;
  }
  if (message.creationSource === "mcp") {
    return "[SpecWithCode: a tool caller sent this message through SpecWithCode's tools, not the person using this chat.]";
  }
  return undefined;
}

/**
 * The provider text with one leading line naming who sent it, when an agent,
 * a routine or a tool caller did, so the model never takes it for the
 * person's own instruction. A person's message, the app's own `/compact`, and
 * text that starts with a slash command or `$skill` the provider lists, is
 * returned unchanged; when the
 * provider's list cannot be read, every such message is noted. Only the text
 * sent to the provider carries the note; the stored message keeps its words.
 */
export function withMessageSenderNote(
  message: SenderFields,
  text: string,
  known?: KnownProviderCommands,
): string {
  const note = senderNote(message);
  if (note === undefined || isAppCompaction(message, text) || startsWithKnownCommand(text, known)) {
    return text;
  }
  return text.length === 0 ? note : `${note}\n\n${text}`;
}

/**
 * Whether a person answered the ask_user card this message answers. The
 * answer is dispatched as the person's message even when an agent answered
 * it through SpecWithCode's tools; the card records that agent. A card that
 * cannot be read, or holds no answer, counts as not a person. Any other
 * message is the person's.
 */
export const answeredCardByPerson = (
  projections: Pick<ProjectionStoreV2Shape, "getRuntimeResponseContext">,
  message: Pick<OrchestrationV2ConversationMessage, "id" | "threadId" | "role">,
) =>
  Effect.gen(function* () {
    const requestId = message.role === "user" ? questionAnswerRequestId(message.id) : null;
    if (requestId === null) return true;
    const context = yield* projections
      .getRuntimeResponseContext(message.threadId, requestId)
      .pipe(Effect.orElseSucceed(() => undefined));
    const item = context?.item;
    return (
      item?.type === "user_input_request" &&
      item.questionAnswer !== undefined &&
      item.questionAnswer.answeredByThreadId === undefined
    );
  });
