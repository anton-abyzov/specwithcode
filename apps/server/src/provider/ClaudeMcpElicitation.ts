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
 * - URL mode is declined with a note in the thread; no link is shown or opened.
 * - A form the card cannot show is cancelled with a note.
 * - A form that asks for a password, token or other secret is declined with a
 *   note and never shown.
 * - Every form needs the person, even one without fields: the card offers no
 *   Approve, so Full access never presses it, and the orchestrator refuses an
 *   answer that is not the person's own (`ClaudeFormResponses.ts`).
 * - The person's raw answers arrive through an in-process hand-off; the
 *   thread's records keep only which fields were answered.
 * - Stopping the turn closes the card as cancelled.
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
  dropClaudeFormAnswers,
  takeClaudeFormAnswers,
} from "../orchestration-v2/ClaudeFormResponses.ts";
import type * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import type * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";

/** How long a card in a thread nobody watches waits before it is cancelled. */
export const UNATTENDED_MCP_ELICITATION_TIMEOUT_MS = 30 * 60 * 1_000;

const DRIVER = ProviderDriverKind.make("claudeAgent");

/** The parts of the adapter's active turn this module reads. */
export interface ClaudeElicitationTurnContext {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly heldRootFrames: ReadonlyArray<unknown>;
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
}

export interface ClaudeMcpElicitations {
  readonly onElicitation: OnElicitation;
  /** Answers a card raised here; false when the request is not one of them. */
  readonly respond: (
    input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<boolean>;
}

type Answer =
  | {
      readonly by: "person";
      readonly decision: ProviderApprovalDecision;
      readonly answers?: ProviderUserInputAnswers;
    }
  | { readonly by: "stop" }
  | { readonly by: "timeout" };

interface PendingCard {
  readonly answer: Deferred.Deferred<Answer>;
}

const CANCEL: ElicitationResult = { action: "cancel" };
const DECLINE: ElicitationResult = { action: "decline" };

/**
 * A card's generic choices. Submit lives on the form itself, never here, so
 * Full access and the generic approval actions cannot accept a form.
 */
export const ELICITATION_CARD_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
];

/** The person cannot be expected to answer: the thread is a worker's or a routine's. */
export function isUnattendedClaudeTurn(input: ProviderAdapter.ProviderAdapterV2TurnInput): boolean {
  return input.appThread.createdBy !== "user" || input.message.scheduledTaskId !== undefined;
}

export const urlModeNotice = (serverName: string) =>
  `${serverName} wanted to open a link in your browser. SpecWithCode doesn't open MCP sign-in links yet; finish it from the tool's own terminal.`;
export const unreadableFormNotice = (serverName: string) =>
  `${serverName} asked for input in a form SpecWithCode can't show yet; it was cancelled.`;
export const unattendedTimeoutNotice = (serverName: string) =>
  `No one answered ${serverName}'s question in 30 minutes; it was cancelled.`;
export const secretFieldNotice = (serverName: string, fieldTitle: string) =>
  `${serverName} asked for a password or secret ("${fieldTitle}"). SpecWithCode doesn't send those through forms, so it was declined.`;
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

const abortEffect = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const abort = () => resume(Effect.void);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

export function makeClaudeMcpElicitations<C extends ClaudeElicitationTurnContext, E>(
  deps: ClaudeMcpElicitationDeps<C, E>,
): ClaudeMcpElicitations {
  const pending = new Map<string, PendingCard>();
  // Cards this module closed itself; a late answer to one is ignored.
  const closed = new Set<string>();
  const remember = (id: string) => {
    closed.add(id);
    if (closed.size > 200) closed.delete(closed.values().next().value as string);
  };
  const timer =
    deps.unattendedTimer ?? Effect.sleep(Duration.millis(UNATTENDED_MCP_ELICITATION_TIMEOUT_MS));

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

  const ask = (request: ElicitationRequest, signal: AbortSignal, sdkRequestId: string) =>
    Effect.gen(function* () {
      const context = yield* deps.activeTurn;
      if (context === null) {
        yield* Effect.logWarning("Declined an MCP elicitation without an active Claude turn.", {
          serverName: request.serverName,
        });
        return DECLINE;
      }
      const nativeRequestId = `mcp-elicitation:${request.serverName}:${sdkRequestId}`;
      if (request.mode === "url") {
        yield* notice(context, `${nativeRequestId}:notice`, urlModeNotice(request.serverName));
        return DECLINE;
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
      const elicitation: OrchestrationV2McpElicitation = {
        serverName: request.serverName,
        mode: "form",
        message: request.message,
        ...(request.requestedSchema === undefined
          ? {}
          : { requestedSchema: request.requestedSchema }),
      };
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
      pending.set(id, { answer });

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
        // The first to settle the card wins; a person's answer that came in
        // at the same moment as a stop or the timer is kept.
        const won = raced.by === "person" ? true : yield* Deferred.succeed(answer, raced);
        const settled = won ? raced : yield* Deferred.await(answer);
        if (settled.by === "person") {
          const result = elicitationResultForDecision(
            form.fields,
            settled.decision,
            settled.answers,
          );
          if (result !== null) return result;
          yield* notice(
            context,
            `${nativeRequestId}:invalid`,
            invalidAnswerNotice(request.serverName),
          );
          return CANCEL;
        }
        remember(id);
        yield* closeCard(artifacts);
        if (settled.by === "timeout")
          yield* notice(
            context,
            `${nativeRequestId}:timeout`,
            unattendedTimeoutNotice(request.serverName),
          );
        return CANCEL;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
            dropClaudeFormAnswers(artifacts.request.id);
          }),
        ),
      );
    });

  const onElicitation: OnElicitation = (request, options) =>
    deps
      .runPromise(
        ask(request, options.signal, options.requestId).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("An MCP elicitation failed; it was cancelled.", {
              serverName: request.serverName,
              cause,
            }).pipe(Effect.as(CANCEL)),
          ),
        ),
      )
      .catch(() => CANCEL);

  const respond: ClaudeMcpElicitations["respond"] = (input) =>
    Effect.gen(function* () {
      const id = String(input.requestId as RuntimeRequestId);
      // The person's raw answers; the effect itself carries only a redacted summary.
      const answers = takeClaudeFormAnswers(input.requestId) ?? input.answers;
      const card = pending.get(id);
      if (card === undefined) return closed.has(id);
      const decision: ProviderApprovalDecision =
        input.decision ?? (answers === undefined ? "cancel" : "accept");
      yield* Deferred.succeed(card.answer, {
        by: "person",
        decision,
        ...(answers === undefined ? {} : { answers }),
      });
      return true;
    });

  return { onElicitation, respond };
}
