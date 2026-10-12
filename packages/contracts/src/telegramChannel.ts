import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * Telegram channel: talk to one project's coordinator from a phone.
 *
 * The Studio host long-polls the Telegram Bot API, so nothing on the host is
 * exposed to the internet. Exactly one private chat is accepted, the one that
 * sent the pairing code Studio showed. The bot token is kept in the host's
 * secret store and never sent back to clients.
 */

/** Telegram deep-link `start` parameters allow `[A-Za-z0-9_-]`, up to 64 characters. */
export const TELEGRAM_PAIRING_CODE_PATTERN = /^[A-Z2-9]{10}$/u;

/** Bot tokens look like `123456789:AA...`; anything else is not sent to Telegram. */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{30,80}$/u;

export const TelegramChannelPollingState = Schema.Literals(["stopped", "running", "error"]);
export type TelegramChannelPollingState = typeof TelegramChannelPollingState.Type;

export const TelegramChannelStatus = Schema.Struct({
  /** A bot token is saved on this host. */
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  /** The bot's @username, read from Telegram when the token was saved. */
  botUsername: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  /** A private chat is paired; only that chat reaches the coordinator. */
  paired: Schema.Boolean,
  /** The paired person's Telegram name, for display only. */
  chatLabel: Schema.NullOr(Schema.String),
  /** Shown until a chat pairs; sent to the bot as `/start <code>`. */
  pairingCode: Schema.NullOr(Schema.String),
  pairingCodeExpiresAt: Schema.NullOr(Schema.String),
  polling: TelegramChannelPollingState,
  /** The last failure talking to Telegram, without request contents. */
  lastError: Schema.NullOr(Schema.String),
});
export type TelegramChannelStatus = typeof TelegramChannelStatus.Type;

export const TelegramChannelConfigureInput = Schema.Struct({
  /** Omit to keep the saved token. */
  botToken: Schema.optionalKey(Schema.String.check(Schema.isPattern(TELEGRAM_BOT_TOKEN_PATTERN))),
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type TelegramChannelConfigureInput = typeof TelegramChannelConfigureInput.Type;

export class TelegramChannelError extends Schema.TaggedError<TelegramChannelError>()(
  "TelegramChannelError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
