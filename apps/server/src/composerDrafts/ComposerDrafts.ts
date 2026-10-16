import {
  COMPOSER_DRAFT_MAX_ATTACHMENT_BYTES,
  ComposerDraftError,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsComposerDraftsRpcGroup,
  type ComposerDraftGetResult,
  type ComposerDraftKey,
  type ComposerDraftKeyInput,
  type ComposerDraftPutInput,
  type ComposerDraftPutResult,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import { listDrafts, putDraft, readDraftWithData, removeDraft } from "./draftFiles.ts";

/** A new-chat draft nobody returned to in this long is dropped. */
const NEW_CHAT_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const failWith = (detail: string) => (cause: unknown) => new ComposerDraftError({ detail, cause });

const decodeBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

/** The drafts kept in `dir`, as the RPC handlers and the cleanup use them. */
export const makeComposerDrafts = (dir: string) => {
  const get = (
    input: ComposerDraftKeyInput,
  ): Effect.Effect<ComposerDraftGetResult, ComposerDraftError> =>
    Effect.tryPromise({
      try: () => readDraftWithData(dir, input.key),
      catch: failWith("Could not read the saved draft."),
    }).pipe(
      Effect.map((draft) => ({
        draft:
          draft === null
            ? null
            : {
                key: input.key,
                prompt: draft.prompt,
                editedAt: draft.editedAt,
                revision: draft.revision,
                attachments: draft.attachments.map((attachment) => ({
                  ...attachment,
                  dataBase64: Buffer.from(draft.data.get(attachment.id)!).toString("base64"),
                })),
              },
      })),
    );

  const put = (
    input: ComposerDraftPutInput,
  ): Effect.Effect<ComposerDraftPutResult, ComposerDraftError> =>
    Effect.gen(function* () {
      const attachments = input.attachments.map(({ dataBase64, ...meta }) => ({
        ...meta,
        ...(dataBase64 === undefined ? {} : { data: decodeBase64(dataBase64) }),
      }));
      const oversized = attachments.find(
        (attachment) => (attachment.data?.byteLength ?? 0) > COMPOSER_DRAFT_MAX_ATTACHMENT_BYTES,
      );
      if (oversized) {
        return yield* new ComposerDraftError({
          detail: `"${oversized.name}" is too large to keep with the draft.`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: () => putDraft(dir, { ...input, attachments }, now),
        catch: failWith("Could not save the draft."),
      });
    });

  const remove = (input: ComposerDraftKeyInput): Effect.Effect<{}, ComposerDraftError> =>
    Effect.tryPromise({
      try: () => removeDraft(dir, input.key),
      catch: failWith("Could not remove the saved draft."),
    }).pipe(Effect.as({}));

  return { get, put, remove };
};

/**
 * The `composerDrafts.*` handlers, registered apart from the rest of the
 * WebSocket API (see `WsComposerDraftsRpcGroup`).
 */
export const layerRpcHandlers = WsComposerDraftsRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const drafts = makeComposerDrafts((yield* ServerConfig.ServerConfig).composerDraftsDir);
    return {
      [WS_METHODS.composerDraftsGet]: drafts.get,
      [WS_METHODS.composerDraftsPut]: drafts.put,
      [WS_METHODS.composerDraftsDelete]: drafts.remove,
    };
  }),
);

/**
 * Drops drafts whose thread or project is gone: at once when a thread is
 * deleted, and in an hourly sweep that also catches deletions made while the
 * host was down. New-chat drafts expire after 30 days.
 */
export const layerCleanup = Layer.effectDiscard(
  Effect.gen(function* () {
    const { composerDraftsDir: dir } = yield* ServerConfig.ServerConfig;
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const drafts = makeComposerDrafts(dir);

    const isStale = (key: string, updatedAt: number, now: number) =>
      Effect.gen(function* () {
        const separator = key.indexOf(":");
        const kind = key.slice(0, separator);
        const id = key.slice(separator + 1);
        if (kind === "draft") return now - updatedAt > NEW_CHAT_DRAFT_TTL_MS;
        if (kind === "thread") {
          return (yield* projections.getThreadShell(ThreadId.make(id))) === null;
        }
        if (kind === "coordinator") {
          return Option.isNone(yield* projects.get(ProjectId.make(id)));
        }
        return false;
      }).pipe(Effect.orElseSucceed(() => false));

    const sweep = Effect.gen(function* () {
      const stored = yield* Effect.promise(() => listDrafts(dir));
      const now = yield* Clock.currentTimeMillis;
      for (const draft of stored) {
        if (yield* isStale(draft.key, draft.updatedAt, now)) {
          yield* drafts.remove({ key: draft.key as ComposerDraftKey });
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Composer draft sweep failed", { cause })),
    );

    yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.asVoid));
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.deleted"
          ? drafts
              .remove({ key: `thread:${event.payload.id}` as ComposerDraftKey })
              .pipe(Effect.ignore)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Composer draft cleanup event stream failed", { cause }),
        ),
      ),
    );
  }),
);
