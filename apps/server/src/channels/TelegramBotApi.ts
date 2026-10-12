/**
 * TelegramBotApi - the few Bot API calls the Telegram channel makes.
 *
 * The bot token is part of every request path, so this port never keeps the
 * HTTP client's error as a cause, turns the client's tracing off, and reports
 * failures by method and status only. `STUDIO_TELEGRAM_API_URL` points tests
 * and private relays at another Bot API server.
 *
 * @module TelegramBotApi
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export const DEFAULT_TELEGRAM_API_URL = "https://api.telegram.org";

export class TelegramBotApiError extends Schema.TaggedError<TelegramBotApiError>()(
  "TelegramBotApiError",
  {
    method: Schema.String,
    /** HTTP status when Telegram answered; absent for network failures and timeouts. */
    status: Schema.optional(Schema.Number),
    /** Telegram's own short description, e.g. "Unauthorized". Never request contents. */
    description: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `Telegram ${this.method} could not be reached.`
      : `Telegram ${this.method} failed with ${this.status}${this.description ? `: ${this.description}` : ""}.`;
  }
}

const TelegramChat = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  first_name: Schema.optional(Schema.String),
  last_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
});

const TelegramMessage = Schema.Struct({
  message_id: Schema.Number,
  chat: TelegramChat,
  text: Schema.optional(Schema.String),
});
export type TelegramMessage = typeof TelegramMessage.Type;

const TelegramUpdate = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(TelegramMessage),
});
export type TelegramUpdate = typeof TelegramUpdate.Type;

const TelegramBotUser = Schema.Struct({
  id: Schema.Number,
  username: Schema.optional(Schema.String),
  first_name: Schema.String,
});
export type TelegramBotUser = typeof TelegramBotUser.Type;

const TelegramEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
});
const decodeEnvelope = Schema.decodeUnknownEffect(TelegramEnvelope);
const decodeBotUser = Schema.decodeUnknownEffect(TelegramBotUser);
const decodeUpdates = Schema.decodeUnknownEffect(Schema.Array(TelegramUpdate));

export class TelegramBotApi extends Context.Service<
  TelegramBotApi,
  {
    readonly getMe: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<TelegramBotUser, TelegramBotApiError>;
    /** Long poll; resolves early when an update arrives. */
    readonly getUpdates: (input: {
      readonly token: Redacted.Redacted<string>;
      readonly offset: number | null;
      readonly timeoutSeconds: number;
    }) => Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramBotApiError>;
    readonly sendMessage: (input: {
      readonly token: Redacted.Redacted<string>;
      readonly chatId: number;
      readonly text: string;
    }) => Effect.Effect<void, TelegramBotApiError>;
    readonly sendTyping: (input: {
      readonly token: Redacted.Redacted<string>;
      readonly chatId: number;
    }) => Effect.Effect<void, TelegramBotApiError>;
  }
>()("studio/channels/TelegramBotApi") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = (process.env.STUDIO_TELEGRAM_API_URL ?? DEFAULT_TELEGRAM_API_URL).replace(
    /\/+$/u,
    "",
  );

  const call = (
    method: string,
    token: Redacted.Redacted<string>,
    body: Record<string, unknown>,
    timeout: Duration.Input,
  ) =>
    Effect.gen(function* () {
      const response = yield* client
        .execute(
          HttpClientRequest.post(`${baseUrl}/bot${Redacted.value(token)}/${method}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(
          // The request URL carries the bot token; keep it out of spans.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.timeout(timeout),
          Effect.mapError(() => new TelegramBotApiError({ method })),
        );
      const json = yield* response.json.pipe(
        Effect.mapError(() => new TelegramBotApiError({ method, status: response.status })),
      );
      const envelope = yield* decodeEnvelope(json).pipe(
        Effect.mapError(() => new TelegramBotApiError({ method, status: response.status })),
      );
      if (!envelope.ok || response.status >= 400) {
        return yield* new TelegramBotApiError({
          method,
          status: response.status,
          ...(envelope.description === undefined
            ? {}
            : { description: envelope.description.slice(0, 200) }),
        });
      }
      return envelope.result;
    });

  return TelegramBotApi.of({
    getMe: (token) =>
      call("getMe", token, {}, "15 seconds").pipe(
        Effect.flatMap((result) =>
          decodeBotUser(result).pipe(
            Effect.mapError(() => new TelegramBotApiError({ method: "getMe", status: 200 })),
          ),
        ),
      ),
    getUpdates: ({ token, offset, timeoutSeconds }) =>
      call(
        "getUpdates",
        token,
        {
          ...(offset === null ? {} : { offset }),
          timeout: timeoutSeconds,
          allowed_updates: ["message"],
        },
        Duration.seconds(timeoutSeconds + 15),
      ).pipe(
        Effect.flatMap((result) =>
          decodeUpdates(result).pipe(
            Effect.mapError(() => new TelegramBotApiError({ method: "getUpdates", status: 200 })),
          ),
        ),
      ),
    sendMessage: ({ token, chatId, text }) =>
      call(
        "sendMessage",
        token,
        { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
        "20 seconds",
      ).pipe(Effect.asVoid),
    sendTyping: ({ token, chatId }) =>
      call("sendChatAction", token, { chat_id: chatId, action: "typing" }, "10 seconds").pipe(
        Effect.asVoid,
      ),
  });
});

export const layer = Layer.effect(TelegramBotApi, make);
