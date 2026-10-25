/**
 * Pure decisions for the Telegram channel: pairing, routing an incoming
 * message, which coordinator runs go back to the phone, and message chunking.
 *
 * @module telegramChannelLogic
 */
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

import type { TelegramMessage } from "./TelegramBotApi.ts";

/** What the host remembers about the channel; the bot token is stored separately. */
export const TelegramChannelState = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  projectId: Schema.NullOr(Schema.String),
  botId: Schema.NullOr(Schema.Number),
  botUsername: Schema.NullOr(Schema.String),
  chatId: Schema.NullOr(Schema.Number),
  chatLabel: Schema.NullOr(Schema.String),
  pairingCode: Schema.NullOr(Schema.String),
  pairingCodeExpiresAt: Schema.NullOr(Schema.String),
  /** The next `getUpdates` offset, so a restart does not replay handled updates. */
  updateOffset: Schema.NullOr(Schema.Number),
});
export type TelegramChannelState = typeof TelegramChannelState.Type;

export const EMPTY_TELEGRAM_CHANNEL_STATE: TelegramChannelState = {
  version: 1,
  enabled: false,
  projectId: null,
  botId: null,
  botUsername: null,
  chatId: null,
  chatLabel: null,
  pairingCode: null,
  pairingCodeExpiresAt: null,
  updateOffset: null,
};

export const PAIRING_CODE_TTL_MS = 30 * 60 * 1000;
/** Telegram rejects messages over 4096 characters; leave room for a part marker. */
export const TELEGRAM_CHUNK_LIMIT = 3900;

/** No 0/O or 1/I, so a code read off a screen types back correctly. */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const makePairingCode = (random: Uint8Array): string => {
  let code = "";
  for (let index = 0; index < 10; index += 1) {
    code += PAIRING_ALPHABET[(random[index] ?? 0) % PAIRING_ALPHABET.length];
  }
  return code;
};

/** Reads `/start CODE`, `/start@bot CODE` or a bare `CODE`. */
export const readPairingAttempt = (text: string): string | null => {
  const match = /^(?:\/start(?:@\w+)?\s+)?([A-Za-z0-9]{10})$/u.exec(text.trim());
  return match?.[1]?.toUpperCase() ?? null;
};

const chatLabelOf = (message: TelegramMessage): string => {
  const { first_name, last_name, username } = message.chat;
  const name = [first_name, last_name]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  if (name !== "" && username !== undefined) return `${name} (@${username})`;
  return name !== "" ? name : username !== undefined ? `@${username}` : "Telegram chat";
};

export type InboundAction =
  | { readonly type: "ignore" }
  | { readonly type: "pair"; readonly chatId: number; readonly chatLabel: string }
  | { readonly type: "pairing_hint"; readonly chatId: number }
  | { readonly type: "help"; readonly chatId: number }
  | { readonly type: "status"; readonly chatId: number }
  | { readonly type: "unsupported"; readonly chatId: number }
  | { readonly type: "forward"; readonly chatId: number; readonly text: string };

/**
 * Decides what one incoming message does. Only private chats count. Before
 * pairing, only the current unexpired code pairs; afterwards, every other chat
 * is ignored without an answer, so the bot reveals nothing to strangers.
 */
export const classifyInbound = (
  state: TelegramChannelState,
  message: TelegramMessage,
  nowMs: number,
): InboundAction => {
  if (message.chat.type !== "private") return { type: "ignore" };
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? "";
  if (state.chatId === null) {
    const attempt = readPairingAttempt(text);
    const expiresAt =
      state.pairingCodeExpiresAt === null ? 0 : Date.parse(state.pairingCodeExpiresAt);
    if (
      attempt !== null &&
      state.pairingCode !== null &&
      attempt === state.pairingCode &&
      expiresAt > nowMs
    ) {
      return { type: "pair", chatId, chatLabel: chatLabelOf(message) };
    }
    return { type: "pairing_hint", chatId };
  }
  if (chatId !== state.chatId) return { type: "ignore" };
  if (text === "") return { type: "unsupported", chatId };
  const command = /^\/(\w+)(?:@\w+)?\b/u.exec(text)?.[1]?.toLowerCase();
  if (command === "help" || command === "start") return { type: "help", chatId };
  if (command === "status") return { type: "status", chatId };
  return { type: "forward", chatId, text };
};

/**
 * A run goes back to the phone unless the person started it at a desk
 * (Studio web or mobile). Telegram messages, routines (even ones made at a
 * desk) and the wake runs that deliver worker results are all forwarded.
 */
export const shouldForwardRun = (
  userMessage:
    | Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource" | "scheduledTaskId">
    | undefined,
): boolean =>
  userMessage === undefined ||
  userMessage.scheduledTaskId !== undefined ||
  !(
    userMessage.createdBy === "user" &&
    (userMessage.creationSource === "web" || userMessage.creationSource === "mobile")
  );

/** The text sent for a finished run, or null when nothing should be sent. */
export const describeFinishedRun = (
  status: OrchestrationV2Run["status"],
  assistantText: string | null,
): string | null => {
  const text = assistantText?.trim() ?? "";
  if (status === "completed") return text === "" ? null : text;
  if (status === "failed") {
    return text === ""
      ? "The coordinator's turn failed. Open SpecWithCode for details."
      : `${text}\n\n(The turn ended with an error. Open SpecWithCode for details.)`;
  }
  return null;
};

/** Splits on paragraph, then line, then hard boundaries; numbers the parts. */
export const chunkTelegramText = (text: string, limit = TELEGRAM_CHUNK_LIMIT): string[] => {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") parts.push(rest);
  return parts.length <= 1
    ? parts
    : parts.map((part, index) => `${part}\n\n(${index + 1}/${parts.length})`);
};

export const HELP_TEXT = [
  "This chat talks to your SpecWithCode project's coordinator.",
  "",
  "Send any message and the coordinator works on it on your machine. Its answer comes back here, and so do your routines' results.",
  "",
  "/status shows the project and whether the coordinator is busy.",
  "Approvals and questions from agents still need SpecWithCode; this chat tells you when one is waiting.",
].join("\n");

export const PAIRING_HINT_TEXT =
  "This bot is not paired yet. Open SpecWithCode, go to Settings, Messaging, and send the pairing code shown there.";
