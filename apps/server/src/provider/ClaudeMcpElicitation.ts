/**
 * MCP servers asking the person for input in a Claude thread.
 *
 * The Agent SDK hands every `elicitation/create` from a server the thread
 * loads to the `onElicitation` option, and declines it when the option is
 * missing. This module is that option: a form becomes an `mcp-elicitation`
 * card whose turn item carries the server's form, and the person's Submit,
 * Decline or Cancel goes back as the server's `accept` (with the content),
 * `decline` or `cancel`.
 *
 * - URL mode shows the link on its own card (`ClaudeMcpUrlElicitation.ts`, 1498):
 *   only the person's press opens it, and a tool call that retries the
 *   request shows one card, not one per retry.
 * - A form the card cannot show is cancelled with a note.
 * - A form that asks for a password, token or other secret is declined with a
 *   note and never shown.
 * - Every form needs the person, even one without fields: the card offers no
 *   Approve, so Full access never presses it, and the orchestrator refuses an
 *   answer that is not the person's own (`ClaudeFormResponses.ts`).
 * - The person's raw answers arrive through an in-process hand-off; the
 *   thread's records keep only which fields were answered.
 * - Stopping the turn closes the card as cancelled. When the SDK stops waiting
 *   on its own (the server gave up), the card closes too, and a note says the
 *   server stopped waiting. The adapter marks a process's open cards when it
 *   ends their calls itself (Stop, steer, closing the CLI) or the CLI's output
 *   ends, so the abort that follows shows no note.
 * - A thread nobody watches (a delegated worker, a routine) cancels the card
 *   after {@link UNATTENDED_MCP_ELICITATION_TIMEOUT_MS}.
 *
 * Exactly one side settles a card: the person's answer, the turn's stop or
 * the timer. Only the side that settles it first is used, and the card is
 * closed here only when the app did not already close it.
 *
 * The SDK runs `Elicitation` hooks before this option, and a hook that answers
 * wins. The app installs none; a hook in the user's or project's own Claude
 * settings (`settingSources`) can still answer first.
 *
 * @module ClaudeMcpElicitation
 */
import type {
  ElicitationRequest,
  ElicitationResult,
  OnElicitation,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2McpElicitation,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderTurnId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
} from "@specweave-studio/contracts";
import { ProviderDriverKind } from "@specweave-studio/contracts";
import {
  findMcpElicitationSecretField,
  parseMcpElicitationSchema,
  validateMcpElicitationContent,
  type McpElicitationField,
} from "@specweave-studio/shared/mcpElicitationForm";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import {
  beginClosingClaudeForm,
  claudeFormCommitOutcome,
  type ClaudeFormCommitOutcome,
  dropClaudeFormAnswers,
  onClaudeFormCommitOutcome,
  REDACTED_FORM_ANSWER,
  takeClaudeFormAnswers,
} from "../orchestration-v2/ClaudeFormResponses.ts";
import type * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import type * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import {
  isClaudeTurnWithoutPerson,
  makeClaudeUrlAnswers,
  planClaudeUrlElicitation,
  urlElicitationResult,
} from "./ClaudeMcpUrlElicitation.ts";

/**
 * How long a card in a thread nobody watches waits before it is cancelled.
 * The shortest deadline no server signals (1495 probe): over HTTP without SSE
 * keepalives, Claude Code drops the call's stream after about 356 seconds of
 * silence and the answer is lost. A server's own timeout (60 seconds in the MCP
 * TypeScript SDK) arrives as the SDK's abort instead, with its own note.
 */
export const UNATTENDED_MCP_ELICITATION_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * How long an abort waits for the adapter's mark before it is read as the
 * server giving up. When the CLI exits, the SDK aborts its pending requests
 * about 2 ms before its output ends (1495 probe, `crash.sh`).
 */
export const ABORT_SETTLE_MS = 2_000;

/** How long the timer waits for an answer the app recorded but has not delivered yet. */
export const ANSWER_IN_FLIGHT_GRACE_MS = 2 * 60 * 1_000;

const DRIVER = ProviderDriverKind.make("claudeAgent");

/** The parts of the adapter's active turn this module reads. */
export interface ClaudeElicitationTurnContext {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly heldRootFrames: ReadonlyArray<unknown>;
  /** The turn's running tool calls, keyed by the CLI's tool use id. */
  readonly toolCalls?: ReadonlyMap<string, { readonly toolName: string }>;
}

interface ApprovalArtifacts {
  readonly node: OrchestrationV2ExecutionNode;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly turnItem: OrchestrationV2TurnItem;
}

export interface ClaudeMcpElicitationDeps<C extends ClaudeElicitationTurnContext, E> {
  readonly activeTurn: Effect.Effect<C | null>;
  readonly buildApprovalRequestArtifacts: (input: {
    readonly context: C;
    readonly nativeItemId: string;
    readonly nativeRequestId: string;
    readonly requestKind: "mcp-elicitation";
    readonly prompt?: string;
  }) => Effect.Effect<ApprovalArtifacts, E>;
  readonly emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
  readonly releaseHeldRootFrames: (context: C) => Effect.Effect<void>;
  readonly resolveItemOrdinal: (context: C, nativeItemId: string) => Effect.Effect<number>;
  readonly idAllocator: Pick<IdAllocator.IdAllocatorV2Shape, "derive">;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
  /** Waits out the unattended timeout; tests pass their own. */
  readonly unattendedTimer?: Effect.Effect<void>;
  /** Waits out {@link ANSWER_IN_FLIGHT_GRACE_MS}; tests pass their own. */
  readonly answerInFlightGrace?: Effect.Effect<void>;
  /** Waits out {@link ABORT_SETTLE_MS}; tests pass their own. */
  readonly abortSettle?: Effect.Effect<void>;
  /** Bounds the wait for a commit still running after the grace; tests pass their own. */
  readonly commitOutcomeLimit?: Effect.Effect<void>;
}

/** The forms of one CLI process: its `onElicitation` and the adapter's marks on its cards. */
export interface ClaudeQueryForms {
  readonly onElicitation: OnElicitation;
  /**
   * The adapter is ending this process's open calls itself (Stop, steer, a
   * close): the aborts that follow are not the server's. Run it before the
   * interrupt, the steer or the close. A card the SDK aborted already keeps
   * the server's cause, even when the close then ends the output.
   */
  readonly endedHere: Effect.Effect<void>;
  /** The CLI's output ended: every abort of this process's cards, even just before, was the exit's. */
  readonly outputEnded: Effect.Effect<void>;
}

export interface ClaudeMcpElicitations {
  /** A new process's forms. */
  readonly forQuery: () => ClaudeQueryForms;
  /** Answers a card raised here; false when the request is not one of them. */
  readonly respond: (
    input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<boolean>;
  /**
   * The turn is ending (a result, success or error, or the CLI's exit): a card
   * the server just gave up on shows its note now, before the turn's end,
   * instead of waiting out the settle. A card the adapter marked shows none.
   */
  readonly settleAborted: Effect.Effect<void>;
}

type Answer =
  | {
      readonly by: "person";
      readonly decision: ProviderApprovalDecision;
      readonly answers?: ProviderUserInputAnswers;
      /** Only the redacted summary arrived; the answer itself is gone. */
      readonly lost?: true;
    }
  | { readonly by: "stop" }
  | { readonly by: "timeout" };

interface PendingCard {
  readonly answer: Deferred.Deferred<Answer>;
  /** The process that asked: the adapter's marks reach only its cards. */
  readonly owner: object;
  readonly signal: AbortSignal;
  /** Why the SDK stopped waiting, decided once: the adapter's own end, or the server. */
  readonly abortCause: Deferred.Deferred<"here" | "server">;
  /** The SDK aborted the call; its note may still be on the way. */
  aborted: boolean;
  /** The call ended, its notes shown. */
  readonly done: Deferred.Deferred<void>;
}

const CANCEL: ElicitationResult = { action: "cancel" };
const DECLINE: ElicitationResult = { action: "decline" };

/**
 * A card's generic choices. Submit lives on the form itself, and "I'm done,
 * continue" on the link card, never here, so Full access and the generic
 * approval actions cannot accept either.
 */
export const ELICITATION_CARD_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
];

/** The person cannot be expected to answer: the thread is a worker's or a routine's. */
export function isUnattendedClaudeTurn(input: ProviderAdapter.ProviderAdapterV2TurnInput): boolean {
  return input.appThread.createdBy !== "user" || input.message.scheduledTaskId !== undefined;
}

export const unreadableFormNotice = (serverName: string) =>
  `${serverName} asked for input in a form SpecWithCode can't show yet; it was cancelled.`;
export const unattendedTimeoutNotice = (serverName: string) =>
  `No one answered ${serverName}'s question in 5 minutes; it was cancelled.`;
export const stoppedWaitingNotice = (serverName: string) =>
  `${serverName} stopped waiting for an answer.`;
export const secretFieldNotice = (serverName: string, fieldTitle: string) =>
  `${serverName} asked for a password or secret ("${fieldTitle}"). SpecWithCode doesn't send those through forms, so it was declined.`;
export const undeliveredAnswerNotice = (serverName: string) =>
  `The answer to ${serverName}'s question didn't reach it in time; it was cancelled.`;
export const invalidAnswerNotice = (serverName: string) =>
  `The answer to ${serverName}'s question didn't fit its form; it was cancelled.`;

/** What the server gets for the person's choice, or null when the content does not fit. */
export function elicitationResultForDecision(
  fields: ReadonlyArray<McpElicitationField>,
  decision: ProviderApprovalDecision,
  answers: ProviderUserInputAnswers | undefined,
): ElicitationResult | null {
  switch (decision) {
    case "decline":
      return DECLINE;
    case "cancel":
      return CANCEL;
    case "accept":
    case "acceptForSession":
    case "acceptAlways": {
      const checked = validateMcpElicitationContent(fields, answers ?? {});
      if (!checked.ok) return null;
      return { action: "accept", content: checked.content as ElicitationResult["content"] };
    }
  }
}

/** A server name as Claude Code writes it in tool names (`mcp__<name>__<tool>`). */
export function claudeToolServerName(serverName: string): string {
  const name = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Claude Code 2.1.332 also folds runs of `_` in claude.ai connector names.
  return serverName.startsWith("claude.ai ")
    ? name.replace(/_+/g, "_").replace(/^_|_$/g, "")
    : name;
}

/**
 * One key per tool call for a server's requests in this turn. The SDK's
 * request carries no tool use id, and each retry of a URL request (`-32042`)
 * comes with a new request id and elicitation id (1495 probe), so the call is
 * found among the turn's running tool calls: `mcp__<server>__<tool>`. With no
 * single such call (two calls of the server run at once), the request keys
 * itself, so no call's note replaces another's.
 */
export function claudeElicitationCallKey(
  context: ClaudeElicitationTurnContext,
  serverName: string,
  sdkRequestId: string,
): string {
  const prefix = `mcp__${claudeToolServerName(serverName)}__`;
  const calls = [...(context.toolCalls?.entries() ?? [])].filter(([, call]) =>
    call.toolName.startsWith(prefix),
  );
  return calls.length === 1
    ? `${serverName}:call:${calls[0]![0]}`
    : `${serverName}:request:${sdkRequestId}`;
}

const abortEffect = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const abort = () => resume(Effect.void);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

const commitOutcome = (requestId: RuntimeRequestId) =>
  Effect.callback<ClaudeFormCommitOutcome>((resume) => {
    const now = claudeFormCommitOutcome(requestId);
    if (now !== "pending") {
      resume(Effect.succeed(now));
      return Effect.void;
    }
    const stop = onClaudeFormCommitOutcome(requestId, (outcome) => resume(Effect.succeed(outcome)));
    return Effect.sync(stop);
  });

export function makeClaudeMcpElicitations<C extends ClaudeElicitationTurnContext, E>(
  deps: ClaudeMcpElicitationDeps<C, E>,
): ClaudeMcpElicitations {
  const pending = new Map<string, PendingCard>();
  // Cards this module closed itself; a late answer to one is ignored.
  const closed = new Set<string>();
  const urlAnswers = makeClaudeUrlAnswers();
  const remember = (id: string) => {
    closed.add(id);
    if (closed.size > 200) closed.delete(closed.values().next().value as string);
  };
  const timer =
    deps.unattendedTimer ?? Effect.sleep(Duration.millis(UNATTENDED_MCP_ELICITATION_TIMEOUT_MS));
  const grace =
    deps.answerInFlightGrace ?? Effect.sleep(Duration.millis(ANSWER_IN_FLIGHT_GRACE_MS));
  const settle = deps.abortSettle ?? Effect.sleep(Duration.millis(ABORT_SETTLE_MS));
  // The server gave up: the adapter marked no end of the call by the time the
  // settle ran out, or the turn finished on its own meanwhile.
  const serverGaveUp = (card: PendingCard) =>
    Effect.raceFirst(
      Deferred.await(card.abortCause),
      settle.pipe(Effect.as("server" as const)),
    ).pipe(Effect.map((cause) => cause === "server"));
  // Every dispatch settles its answer as it ends (1493); this only guards a
  // dispatch that never ends, and then leaves the card as the record says.
  const outcomeLimit =
    deps.commitOutcomeLimit ?? Effect.sleep(Duration.millis(ANSWER_IN_FLIGHT_GRACE_MS));

  const notice = (context: C, nativeItemId: string, message: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* deps.emitProviderEvent({
        type: "turn_item.updated",
        driver: DRIVER,
        turnItem: {
          id: deps.idAllocator.derive.turnItemFromProviderItem({ driver: DRIVER, nativeItemId }),
          threadId: context.input.threadId,
          runId: context.input.runId,
          nodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: { driver: DRIVER, nativeId: nativeItemId, strength: "strong" },
          parentItemId: null,
          ordinal: yield* deps.resolveItemOrdinal(context, nativeItemId),
          type: "system_notice",
          status: "completed",
          title: message,
          message,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    });

  const closeCard = (artifacts: ApprovalArtifacts) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* deps.emitProviderEvent({
        type: "runtime_request.updated",
        driver: DRIVER,
        runtimeRequest: {
          ...artifacts.request,
          status: "cancelled",
          resolvedAt: now,
          decision: "cancel",
        },
      });
      yield* deps.emitProviderEvent({
        type: "node.updated",
        driver: DRIVER,
        node: { ...artifacts.node, status: "cancelled", completedAt: now },
      });
      yield* deps.emitProviderEvent({
        type: "turn_item.updated",
        driver: DRIVER,
        turnItem: { ...artifacts.turnItem, status: "cancelled", completedAt: now, updatedAt: now },
      });
    });

  const ask = (
    owner: object,
    request: ElicitationRequest,
    signal: AbortSignal,
    sdkRequestId: string,
  ) =>
    Effect.gen(function* () {
      const context = yield* deps.activeTurn;
      if (context === null) {
        yield* Effect.logWarning("Declined an MCP elicitation without an active Claude turn.", {
          serverName: request.serverName,
        });
        return DECLINE;
      }
      const nativeRequestId = `mcp-elicitation:${request.serverName}:${sdkRequestId}`;
      const callKey = claudeElicitationCallKey(context, request.serverName, sdkRequestId);
      if (request.mode === "url") {
        const plan = planClaudeUrlElicitation(request, {
          unattended: isClaudeTurnWithoutPerson(context.input),
          remembered: urlAnswers.get(callKey, request),
        });
        if (plan.type === "card")
          return yield* showCard(context, request, signal, owner, nativeRequestId, {
            elicitation: plan.elicitation,
            resultFor: (decision) => urlElicitationResult(decision),
            remember: (result) => urlAnswers.remember(callKey, request, result),
          });
        // Keyed by the tool call, so a retried request replaces its own note.
        if (plan.notice !== undefined)
          yield* notice(context, `mcp-elicitation:${callKey}:url-notice`, plan.notice);
        return plan.result;
      }
      const form = parseMcpElicitationSchema(request.requestedSchema);
      if (!form.ok) {
        yield* Effect.logWarning("Cancelled an MCP elicitation whose form cannot be shown.", {
          serverName: request.serverName,
          reason: form.reason,
        });
        yield* notice(
          context,
          `${nativeRequestId}:notice`,
          unreadableFormNotice(request.serverName),
        );
        return CANCEL;
      }
      const secret = findMcpElicitationSecretField(form.fields);
      if (secret !== undefined) {
        yield* notice(
          context,
          `${nativeRequestId}:notice`,
          secretFieldNotice(request.serverName, secret.title),
        );
        return DECLINE;
      }
      return yield* showCard(context, request, signal, owner, nativeRequestId, {
        elicitation: {
          serverName: request.serverName,
          mode: "form",
          message: request.message,
          ...(request.requestedSchema === undefined
            ? {}
            : { requestedSchema: request.requestedSchema }),
        },
        resultFor: (decision, answers) =>
          elicitationResultForDecision(form.fields, decision, answers),
      });
    });

  /** A form's or a link's card, open until the person, a stop or the timer settles it. */
  const showCard = (
    context: C,
    request: ElicitationRequest,
    signal: AbortSignal,
    owner: object,
    nativeRequestId: string,
    shown: {
      readonly elicitation: OrchestrationV2McpElicitation;
      /** What the server gets for the person's answer; null when it does not fit. */
      readonly resultFor: (
        decision: ProviderApprovalDecision,
        answers: ProviderUserInputAnswers | undefined,
      ) => ElicitationResult | null;
      /** Keeps the person's answer for a retry of the same call. */
      readonly remember?: (result: ElicitationResult) => void;
    },
  ) =>
    Effect.gen(function* () {
      const { elicitation } = shown;
      // The CLI waits on this answer, so output held for the prompt echo goes
      // on now, as it does for a tool approval.
      if (context.heldRootFrames.length > 0) yield* deps.releaseHeldRootFrames(context);

      const built = yield* deps.buildApprovalRequestArtifacts({
        context,
        nativeItemId: nativeRequestId,
        nativeRequestId,
        requestKind: "mcp-elicitation",
        prompt: request.message,
      });
      // The request belongs to no tool node the app knows, so it hangs off the turn's root.
      const node = { ...built.node, parentNodeId: context.input.rootNodeId };
      const turnItem =
        built.turnItem.type === "approval_request"
          ? {
              ...built.turnItem,
              appName: request.serverName,
              options: [...ELICITATION_CARD_OPTIONS],
              elicitation,
            }
          : built.turnItem;
      const artifacts: ApprovalArtifacts = { node, request: built.request, turnItem };
      const id = String(artifacts.request.id);
      const answer = yield* Deferred.make<Answer>();
      const card: PendingCard = {
        answer,
        owner,
        signal,
        abortCause: yield* Deferred.make<"here" | "server">(),
        aborted: false,
        done: yield* Deferred.make<void>(),
      };
      pending.set(id, card);

      return yield* Effect.gen(function* () {
        yield* deps.emitProviderEvent({ type: "node.updated", driver: DRIVER, node });
        yield* deps.emitProviderEvent({
          type: "runtime_request.updated",
          driver: DRIVER,
          runtimeRequest: artifacts.request,
        });
        yield* deps.emitProviderEvent({ type: "turn_item.updated", driver: DRIVER, turnItem });

        const unattended = isUnattendedClaudeTurn(context.input);
        const raced = yield* Effect.raceFirst(
          Deferred.await(answer),
          Effect.raceFirst(
            abortEffect(signal).pipe(Effect.as({ by: "stop" } as const)),
            unattended ? timer.pipe(Effect.as({ by: "timeout" } as const)) : Effect.never,
          ),
        );
        // The app may already have recorded the person's answer while its
        // delivery is still on the way. Stop and the timer then wait a little
        // for it and pass it on, so the server gets what the record says, and
        // neither overwrites the recorded answer as cancelled. Otherwise the
        // form is marked closing first, so an answer that comes in before the
        // cancelled card lands is refused, never recorded (1493).
        if (raced.by === "stop") card.aborted = true;
        const committed = raced.by !== "person" && !beginClosingClaudeForm(artifacts.request.id);
        // A failed commit means no answer is on the way: the grace ends with it.
        const commitFailed = commitOutcome(artifacts.request.id).pipe(
          Effect.flatMap((outcome) => (outcome === "failed" ? Effect.void : Effect.never)),
        );
        const awaited = committed
          ? yield* Effect.raceFirst(
              Deferred.await(answer),
              Effect.raceFirst(grace, commitFailed).pipe(Effect.as(raced)),
            )
          : raced;
        // The first to settle the card wins; a person's answer that came in
        // at the same moment as a stop or the timer is kept.
        const won = awaited.by === "person" ? true : yield* Deferred.succeed(answer, awaited);
        const settled = won ? awaited : yield* Deferred.await(answer);
        if (settled.by === "person") {
          const result =
            settled.lost === true && settled.decision !== "decline" && settled.decision !== "cancel"
              ? null
              : shown.resultFor(settled.decision, settled.answers);
          if (result !== null) {
            shown.remember?.(result);
            return result;
          }
          yield* notice(
            context,
            `${nativeRequestId}:invalid`,
            invalidAnswerNotice(request.serverName),
          );
          return CANCEL;
        }
        remember(id);
        if (committed) {
          // The answer never arrived: the call ends, and the note says so.
          // Its commit may still be running, so the call waits for it and
          // closes the card itself if nothing was recorded, while its events
          // still reach the thread; a recorded one stays (1493, 1481 D-11).
          const outcome = yield* Effect.raceFirst(
            commitOutcome(artifacts.request.id),
            outcomeLimit.pipe(Effect.as("pending" as const)),
          );
          if (outcome === "failed" && beginClosingClaudeForm(artifacts.request.id))
            yield* closeCard(artifacts);
          // Nothing was recorded and the server gave up first: that is the news.
          if (outcome === "failed" && settled.by === "stop" && (yield* serverGaveUp(card)))
            yield* notice(
              context,
              `${nativeRequestId}:stopped`,
              stoppedWaitingNotice(request.serverName),
            );
          else
            yield* notice(
              context,
              `${nativeRequestId}:undelivered`,
              undeliveredAnswerNotice(request.serverName),
            );
          return CANCEL;
        }
        yield* closeCard(artifacts);
        if (settled.by === "timeout")
          yield* notice(
            context,
            `${nativeRequestId}:timeout`,
            unattendedTimeoutNotice(request.serverName),
          );
        // The SDK aborted on its own, not for the adapter's end of the call: say so.
        else if (yield* serverGaveUp(card))
          yield* notice(
            context,
            `${nativeRequestId}:stopped`,
            stoppedWaitingNotice(request.serverName),
          );
        return CANCEL;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
            dropClaudeFormAnswers(artifacts.request.id);
          }).pipe(Effect.andThen(Deferred.succeed(card.done, undefined))),
        ),
      );
    });

  // The app's own end decides every open card of the process: one the SDK
  // already aborted was the server's, the rest are the app's. An output end
  // the app did not start counts every card, aborted or not, as the exit's.
  const markHere = (owner: object, intentional: boolean) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...pending.values()].filter((card) => card.owner === owner),
        (card) =>
          Deferred.succeed(card.abortCause, intentional && card.signal.aborted ? "server" : "here"),
        { discard: true },
      ),
    );

  const forQuery = (): ClaudeQueryForms => {
    const owner = {};
    const onElicitation: OnElicitation = (request, options) =>
      deps
        .runPromise(
          ask(owner, request, options.signal, options.requestId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("An MCP elicitation failed; it was cancelled.", {
                serverName: request.serverName,
                cause,
              }).pipe(Effect.as(CANCEL)),
            ),
          ),
        )
        .catch(() => CANCEL);
    return {
      onElicitation,
      endedHere: markHere(owner, true),
      outputEnded: markHere(owner, false),
    };
  };

  const respond: ClaudeMcpElicitations["respond"] = (input) =>
    Effect.gen(function* () {
      const id = String(input.requestId as RuntimeRequestId);
      // The person's raw answers; the effect itself carries only a redacted
      // summary. Without the hand-off, a redacted summary is never sent on as
      // if it were the answer: the content check then cancels the card.
      const handedOff = takeClaudeFormAnswers(input.requestId);
      const answers = handedOff ?? input.answers;
      const lost =
        handedOff === undefined &&
        Object.values(input.answers ?? {}).includes(REDACTED_FORM_ANSWER);
      const card = pending.get(id);
      if (card === undefined) return closed.has(id);
      const decision: ProviderApprovalDecision =
        input.decision ?? (answers === undefined ? "cancel" : "accept");
      yield* Deferred.succeed(card.answer, {
        by: "person",
        decision,
        ...(answers === undefined ? {} : { answers }),
        ...(lost ? { lost } : {}),
      });
      return true;
    });

  const settleAborted: ClaudeMcpElicitations["settleAborted"] = Effect.suspend(() => {
    const aborted = [...pending.values()].filter((card) => card.aborted);
    if (aborted.length === 0) return Effect.void;
    return Effect.forEach(aborted, (card) => Deferred.succeed(card.abortCause, "server"), {
      discard: true,
    }).pipe(
      // One shared bound: the turn's end never waits on its cards for long.
      Effect.andThen(
        Effect.raceFirst(
          Effect.forEach(aborted, (card) => Deferred.await(card.done), {
            concurrency: "unbounded",
            discard: true,
          }),
          settle,
        ),
      ),
    );
  });

  return { forQuery, respond, settleAborted };
}
