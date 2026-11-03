/**
 * Records a suggested next prompt on each finished run. Claude's SDK offers
 * its own after the reply (PromptSuggestionOffers); every other run that
 * completes without one gets one from the text-generation model, unless the
 * Suggested prompts setting says otherwise. Best effort throughout: a
 * failure only means the run has no suggestion.
 */
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PromptSuggestion,
  type OrchestrationV2Run,
  type PromptSuggestionsMode,
  type RunId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  latestPromptSuggestionRun,
  normalizePromptSuggestion,
  PromptSuggestionOffers,
} from "./PromptSuggestions.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** How long a Claude run waits for the SDK's own suggestion before writing one. */
export const NATIVE_SUGGESTION_GRACE = Duration.seconds(8);
const GENERATION_TIMEOUT = Duration.seconds(45);
/** Generations at once; each is one short call to the text-generation model. */
const GENERATION_WORKERS = 2;
const TRANSCRIPT_USER_CHARS = 2_000;
const TRANSCRIPT_REPLY_CHARS = 6_000;
const MAX_SEEN_RUNS = 2_000;

/** A run that just completed and may get a generated suggestion. */
export function completedRunCandidate(
  event: OrchestrationV2DomainEvent,
): { readonly threadId: ThreadId; readonly run: OrchestrationV2Run } | null {
  if (event.type !== "run.updated" || event.payload.status !== "completed") return null;
  const run = event.payload;
  // Wakes, restart continuations and delegated results are the agent's own turns.
  if (
    run.workStartedAt !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    run.delegatedCompletion !== undefined ||
    run.promptSuggestion !== undefined
  )
    return null;
  return { threadId: run.threadId, run };
}

/**
 * Whether a person reads this thread's replies: not a subagent's, an MCP
 * client's or another machine's fleet work, and not archived or deleted.
 */
export function threadTakesPromptSuggestions(
  thread: Pick<OrchestrationV2AppThread, "lineage" | "origin" | "archivedAt" | "deletedAt">,
): boolean {
  return (
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.origin === undefined &&
    thread.archivedAt === null &&
    thread.deletedAt === null
  );
}

/** Whether the person sent the run's prompt, not a routine or another agent. */
export function runStartedByPerson(
  userMessage: Pick<OrchestrationV2ConversationMessage, "scheduledTaskId" | "senderThreadId">,
): boolean {
  return userMessage.scheduledTaskId === undefined && userMessage.senderThreadId === undefined;
}

/** Whether the run still needs a generated suggestion: latest, completed, without one. */
export function runNeedsGeneratedSuggestion(
  runs: ReadonlyArray<OrchestrationV2Run>,
  runId: RunId,
): boolean {
  const latest = latestPromptSuggestionRun(runs);
  return (
    latest?.id === runId && latest.status === "completed" && latest.promptSuggestion === undefined
  );
}

const keepEnd = (text: string, limit: number) =>
  text.length <= limit ? text : `[Earlier text truncated]\n${text.slice(text.length - limit)}`;

/** The person's message and the agent's reply for one run, for the suggestion prompt. */
export function promptSuggestionTranscript(
  run: Pick<OrchestrationV2Run, "id" | "userMessageId">,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): string | null {
  const settled = messages.filter((message) => !message.streaming);
  const user = settled.find((message) => message.id === run.userMessageId);
  const reply = settled
    .filter((message) => message.role === "assistant" && message.runId === run.id)
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  if (reply.length === 0) return null;
  return [
    ...(user === undefined || user.text.trim().length === 0
      ? []
      : [`Person:\n${keepEnd(user.text.trim(), TRANSCRIPT_USER_CHARS)}`, ""]),
    `Agent:\n${keepEnd(reply, TRANSCRIPT_REPLY_CHARS)}`,
  ].join("\n");
}

export const start = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const offers = yield* PromptSuggestionOffers;

  const mode = serverSettings.getSettings.pipe(
    Effect.map((settings): PromptSuggestionsMode => settings.promptSuggestions),
    Effect.orElseSucceed((): PromptSuggestionsMode => "all"),
  );

  const record = (
    threadId: ThreadId,
    runId: RunId,
    promptSuggestion: OrchestrationV2PromptSuggestion,
  ) =>
    threads
      .dispatch({
        type: "run.prompt-suggestion.record",
        commandId: CommandId.make(`prompt-suggestion:${runId}:${promptSuggestion.source}`),
        threadId,
        runId,
        promptSuggestion,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logDebug("Could not record a suggested prompt", { threadId, runId, cause }),
        ),
      );

  /** The thread's records when its run should get a suggestion, else null. */
  const eligibleRecords = Effect.fn("PromptSuggestionReactor.eligibleRecords")(function* (
    threadId: ThreadId,
    run: Pick<OrchestrationV2Run, "id" | "userMessageId">,
  ) {
    const projection = yield* threads.getThreadRecords(threadId, ["runs", "messages"], {
      messageIds: [run.userMessageId],
    });
    const userMessage = projection.messages.find((message) => message.id === run.userMessageId);
    if (
      !threadTakesPromptSuggestions(projection.thread) ||
      (userMessage !== undefined && !runStartedByPerson(userMessage))
    )
      return null;
    return projection;
  });

  const recordOffer = Effect.fn("PromptSuggestionReactor.recordOffer")(function* (offer: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly text: string;
  }) {
    if ((yield* mode) === "off") return;
    const text = normalizePromptSuggestion(offer.text);
    if (text === null) return;
    const runs = yield* threads.getThreadRecords(offer.threadId, ["runs"]);
    const run = runs.runs.find((candidate) => candidate.id === offer.runId);
    if (run === undefined || (yield* eligibleRecords(offer.threadId, run)) === null) return;
    yield* record(offer.threadId, offer.runId, { text, source: "provider" });
  });

  const generate = Effect.fn("PromptSuggestionReactor.generate")(function* (candidate: {
    readonly threadId: ThreadId;
    readonly run: OrchestrationV2Run;
  }) {
    const { threadId, run } = candidate;
    if ((yield* mode) !== "all") return;
    const projection = yield* eligibleRecords(threadId, run);
    if (projection === null || !runNeedsGeneratedSuggestion(projection.runs, run.id)) return;
    const replies = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["assistant"],
    });
    const transcript = promptSuggestionTranscript(run, [
      ...projection.messages,
      ...replies.messages,
    ]);
    if (transcript === null) return;
    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      projection.thread.projectId,
    ).settings;
    const generatePromptSuggestion = textGeneration.generatePromptSuggestion;
    if (generatePromptSuggestion === undefined) return;
    const generated = yield* generatePromptSuggestion({
      cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
      transcript,
      modelSelection: settings.textGenerationModelSelection,
    }).pipe(Effect.timeoutOption(GENERATION_TIMEOUT));
    if (Option.isNone(generated)) return;
    const text = normalizePromptSuggestion(generated.value.suggestion);
    if (text === null) return;
    yield* record(threadId, run.id, { text, source: "generated" });
  });

  type Candidate = { readonly threadId: ThreadId; readonly run: OrchestrationV2Run };
  const seen = new Set<RunId>();
  const pending = yield* Queue.sliding<Candidate>(64);
  // Claude runs wait here for the SDK's own suggestion, so the wait never
  // holds a generation worker. The grace is fixed, so arrival order is ready order.
  const waiting = yield* Queue.sliding<{ readonly readyAt: number; readonly candidate: Candidate }>(
    256,
  );

  // Adapters ask their provider for suggestions only while the setting allows them.
  const syncWanted = (current: PromptSuggestionsMode) => offers.setWanted(current !== "off");
  yield* syncWanted(yield* mode);
  yield* forkParked(
    Stream.runForEach(serverSettings.streamChanges, (settings) =>
      syncWanted(settings.promptSuggestions),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Suggested prompt settings stream failed", { cause }),
      ),
    ),
  );

  const route = Effect.fn("PromptSuggestionReactor.route")(function* (candidate: Candidate) {
    const instance = yield* registry
      .getInstance(candidate.run.providerInstanceId)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (instance?.driverKind !== CLAUDE_PROVIDER) return yield* Queue.offer(pending, candidate);
    const now = yield* Clock.currentTimeMillis;
    return yield* Queue.offer(waiting, {
      readyAt: now + Duration.toMillis(NATIVE_SUGGESTION_GRACE),
      candidate,
    });
  });

  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      const candidate = completedRunCandidate(event);
      if (candidate === null || seen.has(candidate.run.id)) return Effect.void;
      seen.add(candidate.run.id);
      if (seen.size > MAX_SEEN_RUNS) seen.delete(seen.values().next().value!);
      return route(candidate).pipe(Effect.asVoid);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Suggested prompt event stream failed", { cause }),
      ),
    ),
  );

  const logFailure = (what: string) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logDebug(`Suggested prompt ${what} failed`, { cause });

  yield* forkParked(
    Queue.take(waiting).pipe(
      Effect.flatMap(({ readyAt, candidate }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.sleep(Duration.millis(Math.max(0, readyAt - now)))),
          Effect.andThen(Queue.offer(pending, candidate)),
        ),
      ),
      Effect.forever,
    ),
  );

  for (let worker = 0; worker < GENERATION_WORKERS; worker += 1) {
    yield* forkParked(
      Queue.take(pending).pipe(
        Effect.flatMap((candidate) =>
          generate(candidate).pipe(Effect.catchCause(logFailure("generation"))),
        ),
        Effect.forever,
      ),
    );
  }

  yield* forkParked(
    offers.take.pipe(
      Effect.flatMap((offer) => recordOffer(offer).pipe(Effect.catchCause(logFailure("offer")))),
      Effect.forever,
    ),
  );
});
