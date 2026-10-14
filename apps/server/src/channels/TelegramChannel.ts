/**
 * TelegramChannel - talk to one project's coordinator from Telegram.
 *
 * The host long-polls the Bot API, so nothing is exposed to the internet.
 * Pairing binds exactly one private chat: the one that sends the code Studio
 * shows. Messages from that chat become user messages in the project's
 * coordinator thread (queued, never steering). When a coordinator run that
 * the person did not start at a desk finishes, its last answer goes back to
 * the chat; so do routine results and notices about waiting approvals.
 * Approvals themselves are never answered from Telegram.
 *
 * The bot token lives in the server secret store and is never returned to
 * clients. Channel state lives next to it as `telegram-channel-state`.
 *
 * @module TelegramChannel
 */
import {
  CommandId,
  MessageId,
  ProjectId,
  TelegramChannelError,
  type OrchestrationV2Run,
  type RuntimeRequestId,
  type TelegramChannelConfigureInput,
  type TelegramChannelPollingState,
  type TelegramChannelStatus,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  isTerminalRunStatus,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as TelegramBotApi from "./TelegramBotApi.ts";
import {
  chunkTelegramText,
  classifyInbound,
  describeFinishedRun,
  EMPTY_TELEGRAM_CHANNEL_STATE,
  HELP_TEXT,
  makePairingCode,
  PAIRING_CODE_TTL_MS,
  PAIRING_HINT_TEXT,
  shouldForwardRun,
  TelegramChannelState,
} from "./telegramChannelLogic.ts";

export const TELEGRAM_TOKEN_SECRET = "telegram-bot-token";
export const TELEGRAM_STATE_SECRET = "telegram-channel-state";

const LONG_POLL_SECONDS = 25;
const RECENT_LIMIT = 500;

const decodeState = Schema.decodeUnknownExit(Schema.fromJsonString(TelegramChannelState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(TelegramChannelState));

export class TelegramChannel extends Context.Service<
  TelegramChannel,
  {
    readonly status: Effect.Effect<TelegramChannelStatus>;
    /** Saves the token (checked with Telegram), the project and the on/off switch. */
    readonly configure: (
      input: TelegramChannelConfigureInput,
    ) => Effect.Effect<TelegramChannelStatus, TelegramChannelError>;
    /** Forgets the paired chat and shows a fresh pairing code. */
    readonly unpair: Effect.Effect<TelegramChannelStatus, TelegramChannelError>;
    /** Deletes the token and all channel state. */
    readonly remove: Effect.Effect<TelegramChannelStatus, TelegramChannelError>;
    /** Starts the poller and the reply forwarder; both run for the server's lifetime. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("specweave-studio/channels/TelegramChannel") {}

/** Remembers the last few ids so one run or request is announced once. */
const makeRecent = <A>() => {
  const seen = new Set<A>();
  return (id: A): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > RECENT_LIMIT) {
      const oldest = seen.values().next();
      if (oldest.done !== true) seen.delete(oldest.value);
    }
    return true;
  };
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const api = yield* TelegramBotApi.TelegramBotApi;
  // Telegram keeps unread updates, so a held service reads them after the update.
  const updateHold = yield* ServiceUpdateHold.optional;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagementService;
  const writes = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const initialState = yield* secrets.get(TELEGRAM_STATE_SECRET).pipe(
    Effect.map((stored) => {
      if (Option.isNone(stored)) return EMPTY_TELEGRAM_CHANNEL_STATE;
      const decoded = decodeState(textDecoder.decode(stored.value));
      return Exit.isSuccess(decoded) ? decoded.value : EMPTY_TELEGRAM_CHANNEL_STATE;
    }),
    Effect.orElseSucceed(() => EMPTY_TELEGRAM_CHANNEL_STATE),
  );
  const initialToken = yield* secrets.get(TELEGRAM_TOKEN_SECRET).pipe(
    Effect.map(Option.map((bytes) => Redacted.make(textDecoder.decode(bytes)))),
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
  );

  const stateRef = yield* Ref.make(initialState);
  const tokenRef = yield* Ref.make(initialToken);
  const healthRef = yield* Ref.make<{
    readonly polling: TelegramChannelPollingState;
    readonly lastError: string | null;
  }>({ polling: "stopped", lastError: null });
  const announcedRuns = makeRecent<string>();
  const announcedRequests = makeRecent<RuntimeRequestId>();

  const saveState = (state: TelegramChannelState) =>
    secrets.set(TELEGRAM_STATE_SECRET, textEncoder.encode(encodeState(state))).pipe(
      Effect.mapError(
        (cause) =>
          new TelegramChannelError({ detail: "Could not save the Telegram channel.", cause }),
      ),
      Effect.andThen(Ref.set(stateRef, state)),
    );

  const freshPairing = (state: TelegramChannelState) =>
    Effect.gen(function* () {
      const random = yield* crypto
        .randomBytes(10)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TelegramChannelError({ detail: "Could not make a pairing code.", cause }),
          ),
        );
      const now = yield* Clock.currentTimeMillis;
      return {
        ...state,
        chatId: null,
        chatLabel: null,
        pairingCode: makePairingCode(random),
        pairingCodeExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + PAIRING_CODE_TTL_MS)),
      } satisfies TelegramChannelState;
    });

  const isLive = (expiresAt: string | null, now: number) =>
    expiresAt !== null && Date.parse(expiresAt) > now;

  const status: TelegramChannel["Service"]["status"] = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const token = yield* Ref.get(tokenRef);
    const health = yield* Ref.get(healthRef);
    const now = yield* Clock.currentTimeMillis;
    const codeLive =
      state.chatId === null &&
      state.pairingCode !== null &&
      isLive(state.pairingCodeExpiresAt, now);
    return {
      configured: Option.isSome(token),
      enabled: state.enabled,
      botUsername: state.botUsername,
      projectId: state.projectId === null ? null : ProjectId.make(state.projectId),
      paired: state.chatId !== null,
      chatLabel: state.chatLabel,
      pairingCode: codeLive ? state.pairingCode : null,
      pairingCodeExpiresAt: codeLive ? state.pairingCodeExpiresAt : null,
      polling: health.polling,
      lastError: health.lastError,
    };
  });

  const afterChange = Queue.offer(wake, undefined).pipe(Effect.andThen(status));

  const configure: TelegramChannel["Service"]["configure"] = (input) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const project = yield* projects
          .get(input.projectId)
          .pipe(
            Effect.mapError(
              (cause) => new TelegramChannelError({ detail: "Could not read the project.", cause }),
            ),
          );
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return yield* new TelegramChannelError({ detail: "That project no longer exists." });
        }
        let state = yield* Ref.get(stateRef);
        if (input.botToken !== undefined) {
          const token = Redacted.make(input.botToken);
          const bot = yield* api.getMe(token).pipe(
            Effect.mapError(
              (error) =>
                new TelegramChannelError({
                  detail:
                    error.status === undefined
                      ? "Could not reach Telegram to check the bot token."
                      : "Telegram did not accept this bot token.",
                }),
            ),
          );
          yield* secrets
            .set(TELEGRAM_TOKEN_SECRET, textEncoder.encode(input.botToken))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TelegramChannelError({ detail: "Could not save the bot token.", cause }),
              ),
            );
          yield* Ref.set(tokenRef, Option.some(token));
          // Another bot means another chat history: pair again from the start.
          if (state.botId !== bot.id) {
            state = yield* freshPairing({ ...state, updateOffset: null });
          }
          state = { ...state, botId: bot.id, botUsername: bot.username ?? null };
        } else if (Option.isNone(yield* Ref.get(tokenRef))) {
          return yield* new TelegramChannelError({
            detail: "Paste the bot token from @BotFather.",
          });
        }
        if (
          state.chatId === null &&
          !isLive(state.pairingCodeExpiresAt, yield* Clock.currentTimeMillis)
        ) {
          state = yield* freshPairing(state);
        }
        yield* saveState({ ...state, enabled: input.enabled, projectId: input.projectId });
        return yield* afterChange;
      }),
    );

  const unpair: TelegramChannel["Service"]["unpair"] = writes.withPermits(1)(
    Effect.gen(function* () {
      yield* saveState(yield* freshPairing(yield* Ref.get(stateRef)));
      return yield* afterChange;
    }),
  );

  const remove: TelegramChannel["Service"]["remove"] = writes.withPermits(1)(
    Effect.gen(function* () {
      yield* Effect.all(
        [secrets.remove(TELEGRAM_TOKEN_SECRET), secrets.remove(TELEGRAM_STATE_SECRET)],
        {
          discard: true,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TelegramChannelError({ detail: "Could not remove the Telegram channel.", cause }),
        ),
      );
      yield* Ref.set(tokenRef, Option.none());
      yield* Ref.set(stateRef, EMPTY_TELEGRAM_CHANNEL_STATE);
      return yield* afterChange;
    }),
  );

  /** Sends to the paired chat; delivery failures are logged, never fatal. */
  const send = (chatId: number, text: string) =>
    Effect.gen(function* () {
      const token = yield* Ref.get(tokenRef);
      if (Option.isNone(token)) return;
      for (const part of chunkTelegramText(text)) {
        yield* api.sendMessage({ token: token.value, chatId, text: part });
      }
    }).pipe(
      Effect.catchTags({
        TelegramBotApiError: (error) =>
          Effect.logWarning("telegram message not delivered", {
            method: error.method,
            status: error.status,
          }),
      }),
    );

  const activeProject = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (!state.enabled || state.chatId === null || state.projectId === null) return null;
    const project = yield* projects.get(ProjectId.make(state.projectId)).pipe(Effect.option);
    if (Option.isNone(project) || Option.isNone(project.value)) return null;
    const row = project.value.value;
    if (row.deletedAt !== null) return null;
    return { state, chatId: state.chatId, project: row };
  });

  const statusText = Effect.gen(function* () {
    const active = yield* activeProject;
    if (active === null) return "The channel is off or the project no longer exists.";
    const coordinatorThreadId = active.project.workspaceSettings?.coordinatorThreadId ?? null;
    const lines = [`Project: ${active.project.title}`];
    if (active.project.workspaceSettings?.paused === true) lines.push("The project is paused.");
    if (coordinatorThreadId === null) {
      lines.push("The coordinator has not started yet. Open the project in Studio once.");
      return lines.join("\n");
    }
    const records = yield* threads
      .getProjectThreadRecords(
        { projectId: active.project.projectId, threadId: coordinatorThreadId },
        ["runs"],
      )
      .pipe(Effect.option);
    const runs = Option.isSome(records) ? records.value.runs : [];
    const busy = runs.some((run) => !isTerminalRunStatus(run.status) && run.status !== "queued");
    const queued = runs.filter((run) => run.status === "queued").length;
    lines.push(busy ? "The coordinator is working." : "The coordinator is idle.");
    if (queued > 0) lines.push(`${queued} message${queued === 1 ? "" : "s"} waiting.`);
    return lines.join("\n");
  });

  const forward = (chatId: number, text: string, updateId: number) =>
    Effect.gen(function* () {
      const active = yield* activeProject;
      if (active === null) return yield* send(chatId, "The channel is off in Studio.");
      const coordinatorThreadId = active.project.workspaceSettings?.coordinatorThreadId ?? null;
      if (coordinatorThreadId === null) {
        return yield* send(
          chatId,
          `“${active.project.title}” has no coordinator yet. Open the project in Studio once so it starts.`,
        );
      }
      const token = yield* Ref.get(tokenRef);
      if (Option.isSome(token)) {
        yield* api.sendTyping({ token: token.value, chatId }).pipe(Effect.ignore);
      }
      const key = `${active.state.botId ?? 0}:${updateId}`;
      const result = yield* threads
        .sendToThread({
          projectId: active.project.projectId,
          threadId: coordinatorThreadId,
          commandId: CommandId.make(`telegram:${key}`),
          messageId: MessageId.make(`telegram-message:${key}`),
          text,
          attachments: [],
          // A phone message never interrupts work in progress.
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause);
        yield* Effect.logWarning("telegram message refused by the coordinator thread", {
          reason: error instanceof Error ? error.name : "unknown",
        });
        return yield* send(
          chatId,
          `Studio did not take the message: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      if (result.value.delivery === "queued") {
        yield* send(chatId, "Queued. The coordinator will pick it up after its current work.");
      }
    });

  const handleUpdate = (update: TelegramBotApi.TelegramUpdate) =>
    Effect.gen(function* () {
      const message = update.message;
      if (message === undefined) return;
      const state = yield* Ref.get(stateRef);
      const action = classifyInbound(state, message, yield* Clock.currentTimeMillis);
      switch (action.type) {
        case "ignore":
          return;
        case "pair": {
          const project =
            state.projectId === null
              ? Option.none()
              : yield* projects
                  .get(ProjectId.make(state.projectId))
                  .pipe(Effect.orElseSucceed(() => Option.none()));
          yield* writes.withPermits(1)(
            Ref.get(stateRef).pipe(
              Effect.flatMap((current) =>
                saveState({
                  ...current,
                  chatId: action.chatId,
                  chatLabel: action.chatLabel,
                  pairingCode: null,
                  pairingCodeExpiresAt: null,
                }),
              ),
            ),
          );
          const title = Option.isSome(project) ? project.value.title : "your project";
          return yield* send(
            action.chatId,
            `Paired. Messages here go to the coordinator of “${title}”.\n\n${HELP_TEXT}`,
          );
        }
        case "pairing_hint":
          return yield* send(action.chatId, PAIRING_HINT_TEXT);
        case "help":
          return yield* send(action.chatId, HELP_TEXT);
        case "status":
          return yield* send(action.chatId, yield* statusText);
        case "unsupported":
          return yield* send(action.chatId, "Only text messages work here for now.");
        case "forward":
          return yield* forward(action.chatId, action.text, update.update_id);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("telegram update not handled", { cause: Cause.pretty(cause) }),
      ),
    );

  const setHealth = (polling: TelegramChannelPollingState, lastError: string | null) =>
    Ref.set(healthRef, { polling, lastError });

  const waitForChange = (timeout: "5 seconds" | "60 seconds") =>
    Queue.take(wake).pipe(Effect.timeoutOption(timeout), Effect.asVoid);

  let failures = 0;
  const pollOnce = Effect.gen(function* () {
    if (yield* updateHold.isHeld) return yield* waitForChange("5 seconds");
    const state = yield* Ref.get(stateRef);
    const token = yield* Ref.get(tokenRef);
    if (!state.enabled || Option.isNone(token) || state.projectId === null) {
      yield* setHealth("stopped", null);
      return yield* waitForChange("60 seconds");
    }
    const polled = yield* Effect.raceFirst(
      api
        .getUpdates({
          token: token.value,
          offset: state.updateOffset,
          timeoutSeconds: LONG_POLL_SECONDS,
        })
        .pipe(Effect.asSome),
      // A configuration change abandons the poll so the next one uses it.
      Queue.take(wake).pipe(Effect.as(Option.none())),
    ).pipe(Effect.exit);
    if (Exit.isFailure(polled)) {
      failures += 1;
      const error = Cause.squash(polled.cause);
      yield* setHealth(
        "error",
        error instanceof Error ? error.message : "Telegram polling failed.",
      );
      // Back off up to a minute; a change in Settings retries at once.
      return yield* waitForChange(failures > 3 ? "60 seconds" : "5 seconds");
    }
    failures = 0;
    yield* setHealth("running", null);
    if (Option.isNone(polled.value)) return;
    for (const update of polled.value.value) {
      yield* handleUpdate(update);
      yield* writes.withPermits(1)(
        Ref.get(stateRef).pipe(
          Effect.flatMap((current) =>
            current.updateOffset !== null && current.updateOffset > update.update_id
              ? Effect.void
              : saveState({ ...current, updateOffset: update.update_id + 1 }),
          ),
          Effect.catchTags({
            TelegramChannelError: (error) =>
              Effect.logWarning("telegram offset not saved", { detail: error.detail }),
          }),
        ),
      );
    }
  });

  const onRunFinished = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const active = yield* activeProject;
      if (active === null) return;
      if (active.project.workspaceSettings?.coordinatorThreadId !== run.threadId) return;
      if (!announcedRuns(run.id)) return;
      const key = { projectId: active.project.projectId, threadId: run.threadId };
      const userMessages = yield* threads.getProjectThreadRecords(key, ["messages"], {
        messageIds: [run.userMessageId],
      });
      if (!shouldForwardRun(userMessages.messages[0])) return;
      const answers = yield* threads.getProjectThreadRecords(key, ["messages"], {
        messageRunIds: [run.id],
        messageRoles: ["assistant"],
      });
      const last = answers.messages.at(-1);
      const text = describeFinishedRun(run.status, last?.text ?? null);
      if (text !== null) yield* send(active.chatId, text);
    });

  const onPendingRequest = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    Effect.gen(function* () {
      const active = yield* activeProject;
      if (active === null) return;
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.projectId !== active.project.projectId) return;
      if (!announcedRequests(requestId)) return;
      const title = shell.title.trim() === "" ? "A thread" : `“${shell.title.trim()}”`;
      yield* send(
        active.chatId,
        `${title} in ${active.project.title} is waiting for your approval or answer in Studio.`,
      );
    });

  const start: TelegramChannel["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(Effect.forever(pollOnce));
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          Effect.gen(function* () {
            if (event.type === "run.updated" && isTerminalRunStatus(event.payload.status)) {
              yield* onRunFinished(event.payload);
            } else if (
              event.type === "runtime-request.updated" &&
              event.payload.status === "pending"
            ) {
              yield* onPendingRequest(event.threadId, event.payload.id);
            }
          }).pipe(
            // One unreadable thread must not stop forwarding for the rest.
            Effect.catchCause((cause) =>
              Effect.logWarning("telegram reply not forwarded", { cause: Cause.pretty(cause) }),
            ),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("telegram reply forwarding stopped", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
    });

  return TelegramChannel.of({ status, configure, unpair, remove, start });
});

export const layer = Layer.effect(TelegramChannel, make);
