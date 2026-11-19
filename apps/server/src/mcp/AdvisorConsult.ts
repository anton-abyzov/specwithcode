/**
 * The studio-code `advisor` tool: a running thread asks a stronger model to
 * review its work and keeps going. A consult is a delegated task marked
 * `purpose: "advisor"`; the child gets a budgeted brief of the thread
 * (`AdvisorBrief.ts`), runs read-only and answers once.
 *
 * The decisions (refusals, the per-run limit, picking up a consult already
 * running, how long to wait, the result's shape) are pure functions here.
 * `consultAdvisor` runs a consult through ports, so it is tested without a
 * server; `OrchestratorMcpService.consultAdvisor` wires the ports to the
 * delegated-task path.
 *
 * @module AdvisorConsult
 */
import type {
  AdvisorConsultInput,
  AdvisorConsultResult,
  AdvisorRefusalReason,
  AdvisorSettings,
  ModelSelection,
  NodeId,
  OrchestrationV2Subagent,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  RunId,
  ThreadAdvisorMode,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  ADVISOR_SKIP_NOTES,
  type AdvisorResolution,
  type AdvisorSkip,
  threadAdvisorState,
} from "@specweave-studio/shared/advisor";
import * as Effect from "effect/Effect";

import type { AdvisorBrief } from "../orchestration-v2/AdvisorBrief.ts";
import { SUBAGENT_NO_RESULT_TEXT } from "../orchestration-v2/SubagentProjection.ts";

// ── How long a call waits ────────────────────────────────────────────

/**
 * Claude Code keeps a studio-code call open for an hour (its timeout is
 * raised for SpecWithCode), so a Claude thread waits as long as a
 * `delegate_task` wait does, under the 300 s a silent Node fetch call allows.
 */
export const ADVISOR_CLAUDE_WAIT_MS = 4 * 60 * 1_000;
/**
 * Every other provider applies its own MCP call timeout (Codex ends a call at
 * 60 s by default), so the call returns "working" well before that and the
 * advice arrives as a wake-up.
 */
export const ADVISOR_DEFAULT_WAIT_MS = 45 * 1_000;

/** The inline wait for a caller on `driver`; an unknown driver gets the short one. */
export function advisorWaitMs(driver: string | null | undefined): number {
  return driver === "claudeAgent" ? ADVISOR_CLAUDE_WAIT_MS : ADVISOR_DEFAULT_WAIT_MS;
}

// ── The caller's consults ────────────────────────────────────────────

const TERMINAL_TASK_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

type SubagentRecord = Pick<
  OrchestrationV2Subagent,
  | "id"
  | "threadId"
  | "runId"
  | "origin"
  | "purpose"
  | "status"
  | "childThreadId"
  | "providerInstanceId"
  | "model"
  | "completionDelivery"
  | "startedAt"
>;

/** The caller's own advisor consults, oldest first. */
export function advisorTasks<T extends SubagentRecord>(
  subagents: ReadonlyArray<T>,
  callerThreadId: ThreadId,
): ReadonlyArray<T> {
  return subagents.filter(
    (task) =>
      task.origin === "app_owned" && task.threadId === callerThreadId && task.purpose === "advisor",
  );
}

/**
 * Consults the caller's run `runId` already started, finished or not. Counted
 * from the app's own task records, never from what a provider reports.
 */
export function advisorConsultsUsed(
  subagents: ReadonlyArray<SubagentRecord>,
  callerThreadId: ThreadId,
  runId: RunId,
): number {
  return advisorTasks(subagents, callerThreadId).filter((task) => task.runId === runId).length;
}

/** Whether the task's record is final; until then its child may still be finishing. */
export function isTerminalAdvisorTask(task: Pick<SubagentRecord, "status">): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

/**
 * The newest consult of this thread a new call should pick up instead of
 * starting another, from any run: one still running, or one that finished
 * after its call returned "working" whose wake-up has not settled yet. That
 * is a wake-up not sent (`pending`), or one sent that the caller's turn has
 * not finished reading (`claimed`: queued, being steered in, or in the turn
 * it started). The wake-up settles the consult (`acknowledged`) once that
 * turn ends or the provider takes the steer; a call after that is a new consult.
 */
export function inFlightAdvisorTask<T extends SubagentRecord>(
  subagents: ReadonlyArray<T>,
  callerThreadId: ThreadId,
): T | undefined {
  return advisorTasks(subagents, callerThreadId)
    .filter(
      (task) =>
        !TERMINAL_TASK_STATUSES.has(task.status) ||
        task.completionDelivery?.state === "pending" ||
        task.completionDelivery?.state === "claimed",
    )
    .at(-1);
}

/**
 * Child threads of this thread's finished consults whose result is no longer
 * waiting to be delivered, so archiving them cannot lose a wake-up.
 */
export function settledAdvisorChildren(
  subagents: ReadonlyArray<SubagentRecord>,
  callerThreadId: ThreadId,
): ReadonlyArray<ThreadId> {
  return advisorTasks(subagents, callerThreadId).flatMap((task) =>
    task.childThreadId !== null &&
    TERMINAL_TASK_STATUSES.has(task.status) &&
    task.completionDelivery?.state !== "pending" &&
    task.completionDelivery?.state !== "claimed"
      ? [task.childThreadId]
      : [],
  );
}

// ── Refusals ─────────────────────────────────────────────────────────

/** A consult that started nothing. */
export function advisorRefusal(
  refusal: AdvisorRefusalReason,
  message: string,
  extra: Pick<AdvisorConsultResult, "consultsRemaining"> = {},
): AdvisorConsultResult {
  return { status: "refused", refusal, message, ...extra };
}

export const ADVISOR_THREAD_REFUSAL =
  "An advisor answers its parent thread only; it cannot consult another advisor.";

export function advisorOffMessage(source: "thread" | "settings"): string {
  return source === "thread"
    ? "This thread has its advisor turned off; turn it back on from the Advisor row in the thread's options menu."
    : "The advisor is off for this thread; turn it on from the Advisor row in the thread's options menu, or for the project in Settings > Models > Advisor.";
}

export function advisorLimitMessage(max: number): string {
  return `This turn already used its ${max} advisor consult${max === 1 ? "" : "s"}, so nothing was started; carry on, or consult again in a later turn.`;
}

/** Why no model can advise, entry by entry. */
export function noAdvisorMessage(
  skipped: ReadonlyArray<AdvisorSkip>,
  label: (selection: ModelSelection) => string,
): string {
  if (skipped.length === 0)
    return "No advisor model is available on this machine, so nothing was started; pick one in Settings > Models > Advisor.";
  const reasons = skipped
    .map((skip) => `${label(skip.selection)}: ${ADVISOR_SKIP_NOTES[skip.reason]}`)
    .join("; ");
  return `No advisor model can run now (${reasons}), so nothing was started.`;
}

/** The advisor `resolveAdvisor` found, or a `no-advisor` refusal naming each entry skipped. */
export function advisorFromResolution(
  resolution: AdvisorResolution,
  label: (selection: ModelSelection) => string,
): Refusable<ModelSelection> {
  return resolution.advisor === null
    ? {
        kind: "refused",
        result: advisorRefusal("no-advisor", noAdvisorMessage(resolution.skipped, label)),
      }
    : { kind: "ok", value: resolution.advisor };
}

// ── The gate ─────────────────────────────────────────────────────────

export interface AdvisorCallerThread {
  readonly id: ThreadId;
  readonly advisorMode?: ThreadAdvisorMode | null | undefined;
  readonly purpose?: "advisor" | undefined;
}

export type AdvisorGate<T extends SubagentRecord = SubagentRecord> =
  | { readonly kind: "refused"; readonly result: AdvisorConsultResult }
  /** A consult is already running for this thread: wait for it instead of starting another. */
  | { readonly kind: "pick-up"; readonly task: T; readonly consultsRemaining: number }
  /** Start consult number `ordinal` of this run. */
  | { readonly kind: "start"; readonly ordinal: number; readonly consultsRemaining: number };

/**
 * Whether this call may consult, in order: an advisor never consults, the
 * thread's advisor must be on, a consult already running is picked up, and
 * each run has `maxConsultsPerRun` consults.
 */
export function advisorConsultGate<T extends SubagentRecord>(input: {
  readonly thread: AdvisorCallerThread;
  readonly settings: Pick<AdvisorSettings, "enabled" | "maxConsultsPerRun">;
  readonly subagents: ReadonlyArray<T>;
  readonly runId: RunId;
}): AdvisorGate<T> {
  if (input.thread.purpose === "advisor")
    return { kind: "refused", result: advisorRefusal("advisor-thread", ADVISOR_THREAD_REFUSAL) };
  const state = threadAdvisorState(input.thread.advisorMode, input.settings);
  if (!state.enabled)
    return { kind: "refused", result: advisorRefusal("off", advisorOffMessage(state.source)) };
  const max = input.settings.maxConsultsPerRun;
  const used = advisorConsultsUsed(input.subagents, input.thread.id, input.runId);
  const running = inFlightAdvisorTask(input.subagents, input.thread.id);
  if (running !== undefined)
    return { kind: "pick-up", task: running, consultsRemaining: Math.max(0, max - used) };
  if (used >= max)
    return {
      kind: "refused",
      result: advisorRefusal("limit", advisorLimitMessage(max), { consultsRemaining: 0 }),
    };
  return { kind: "start", ordinal: used + 1, consultsRemaining: max - used - 1 };
}

// ── The result ───────────────────────────────────────────────────────

const ADVISOR_WORKING_MESSAGE =
  "The advisor is still working; do what does not depend on its answer and end your turn, and the advice arrives as your next message. A call to advisor before it arrives picks up this consult instead of starting another.";

/**
 * What the caller hears about a consult's task: the advice when the child
 * answered, `working` while it runs, `failed` when it ended without advice
 * (it still counts toward the run's limit).
 */
export function advisorConsultResult(input: {
  readonly task: Pick<OrchestratorMcpDelegateTaskResult, "taskId" | "status" | "summary">;
  readonly advisor: string;
  readonly advisorModel?: ModelSelection | undefined;
  readonly consultsRemaining: number;
  readonly briefTokens?: number | undefined;
  readonly leftOut?: number | undefined;
}): AdvisorConsultResult {
  const about = {
    advisor: input.advisor,
    ...(input.advisorModel === undefined ? {} : { advisorModel: input.advisorModel }),
    consultsRemaining: input.consultsRemaining,
    ...(input.briefTokens === undefined ? {} : { briefTokens: input.briefTokens }),
    ...(input.leftOut === undefined ? {} : { leftOut: input.leftOut }),
  };
  // A child that said nothing gets the app's own placeholder as its result.
  const summary = input.task.summary?.trim() ?? "";
  const advice = summary === SUBAGENT_NO_RESULT_TEXT ? "" : summary;
  switch (input.task.status) {
    case "completed":
      return advice === ""
        ? {
            status: "failed",
            message: `${input.advisor} finished without giving advice; carry on without it.`,
            taskId: input.task.taskId,
            ...about,
          }
        : {
            status: "advice",
            message: `${input.advisor} reviewed this thread's work.`,
            advice,
            ...about,
          };
    case "failed":
    case "cancelled":
    case "interrupted":
      return {
        status: "failed",
        message: `The advisor's run ${input.task.status === "failed" ? "failed" : `was ${input.task.status}`} before it gave advice; carry on without it.`,
        taskId: input.task.taskId,
        ...about,
      };
    default:
      return {
        status: "working",
        message: ADVISOR_WORKING_MESSAGE,
        taskId: input.task.taskId,
        ...about,
      };
  }
}

/**
 * A consult whose child stopped on an approval or a question. Nobody answers
 * an advisor's requests (it is no thread in the sidebar), so it would wait
 * forever; the consult stops it and says so.
 */
export function advisorBlockedResult(input: {
  readonly taskId: NodeId;
  readonly advisor: string;
  readonly advisorModel?: ModelSelection | undefined;
  readonly consultsRemaining: number;
}): AdvisorConsultResult {
  return {
    status: "failed",
    message: `${input.advisor} stopped to ask for an approval or an answer, which an advisor never gets, so SpecWithCode ended that consult; carry on without its advice.`,
    taskId: input.taskId,
    advisor: input.advisor,
    ...(input.advisorModel === undefined ? {} : { advisorModel: input.advisorModel }),
    consultsRemaining: input.consultsRemaining,
  };
}

const MAX_ADVISOR_TITLE_LENGTH = 120;

/** The advisor child's name: whose work it reviews. */
export function advisorTaskTitle(threadTitle: string): string {
  const title = `Advisor: ${threadTitle.trim() || "thread"}`;
  return title.length <= MAX_ADVISOR_TITLE_LENGTH
    ? title
    : `${title.slice(0, MAX_ADVISOR_TITLE_LENGTH - 3).trimEnd()}...`;
}

// ── A consult ────────────────────────────────────────────────────────

/** The calling thread, as a consult needs it. `context` is the wiring's own. */
export interface AdvisorCaller<C> {
  readonly thread: AdvisorCallerThread & { readonly title: string };
  /** The caller's live turn, or its completed last one. */
  readonly runId: RunId;
  /** The driver of the provider the caller runs on, for the wait budget. */
  readonly driver: string | null | undefined;
  readonly subagents: ReadonlyArray<SubagentRecord>;
  readonly context: C;
}

export interface AdvisorPick {
  /** The advisor's model, with the effort saved on its entry. */
  readonly selection: ModelSelection;
  /** The model and provider as a person reads them. */
  readonly label: string;
}

export type Refusable<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "refused"; readonly result: AdvisorConsultResult };

export interface AdvisorConsultPorts<C, S extends { readonly advisor: AdvisorSettings }, R> {
  /** The caller, or a `no-run` refusal when the call did not come from a thread's turn. */
  readonly caller: Effect.Effect<Refusable<AdvisorCaller<C>>, OrchestratorMcpFailure, R>;
  /** The effective settings for the caller's project. */
  readonly settings: (caller: AdvisorCaller<C>) => Effect.Effect<S, OrchestratorMcpFailure, R>;
  /** The advisor model, or a `no-advisor` refusal. */
  readonly pickAdvisor: (
    caller: AdvisorCaller<C>,
    settings: S,
  ) => Effect.Effect<Refusable<AdvisorPick>, OrchestratorMcpFailure, R>;
  readonly buildBrief: (
    caller: AdvisorCaller<C>,
    input: { readonly focus: string | undefined; readonly budgetTokens: number },
  ) => Effect.Effect<AdvisorBrief, OrchestratorMcpFailure, R>;
  /** Starts the advisor child; returns its task id. */
  readonly start: (input: {
    readonly caller: AdvisorCaller<C>;
    readonly advisor: AdvisorPick;
    readonly brief: AdvisorBrief;
    readonly ordinal: number;
  }) => Effect.Effect<NodeId, OrchestratorMcpFailure, R>;
  /**
   * Waits up to `timeoutMs` for the task to finish and returns it as it then
   * stands. A wait that ends without a result must leave the task set to wake
   * the caller when it finishes.
   */
  readonly wait: (
    taskId: NodeId,
    timeoutMs: number,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure, R>;
  /** The model and provider of a task's advisor as a person reads them. */
  readonly label: (caller: AdvisorCaller<C>, selection: ModelSelection) => string;
  /** Best effort; never fails the consult. */
  readonly archive: (childThreadIds: ReadonlyArray<ThreadId>) => Effect.Effect<void, never, R>;
  /**
   * Whether the child waits on an approval or a question (its thread's
   * pending runtime request). An unreadable child counts as not blocked.
   */
  readonly blocked: (childThreadId: ThreadId) => Effect.Effect<boolean, never, R>;
  /**
   * Ends a blocked consult: drops its wake-up so the stop does not wake the
   * caller, stops the child and archives it. Best effort; never fails.
   */
  readonly abandon: (input: {
    readonly taskId: NodeId;
    readonly childThreadId: ThreadId;
  }) => Effect.Effect<void, never, R>;
  /**
   * Runs `effect` alone among the calling thread's advisor calls: from
   * reading its consults to starting one, so concurrent calls cannot both start.
   */
  readonly serialize: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** What the serialized part of a call decided; only its waits run outside the lock. */
type Prepared<T extends SubagentRecord> =
  | { readonly kind: "done"; readonly result: AdvisorConsultResult }
  | {
      readonly kind: "pick-up";
      readonly task: T;
      readonly advisor: string;
      readonly advisorModel: ModelSelection | undefined;
      readonly consultsRemaining: number;
      readonly waitMs: number;
    }
  | {
      readonly kind: "started";
      readonly taskId: NodeId;
      readonly advisor: AdvisorPick;
      readonly brief: AdvisorBrief;
      readonly consultsRemaining: number;
      readonly waitMs: number;
    };

/** Runs one `advisor` call. Refusals are results; only faults fail. */
export const consultAdvisor = <C, S extends { readonly advisor: AdvisorSettings }, R>(
  ports: AdvisorConsultPorts<C, S, R>,
  input: AdvisorConsultInput,
): Effect.Effect<AdvisorConsultResult, OrchestratorMcpFailure, R> =>
  Effect.gen(function* () {
    // Reading the thread's consults and starting one are serialized, so a
    // call made alongside another sees the consult that one started and
    // picks it up: parallel calls never start two children or pass the limit.
    const prepared: Prepared<SubagentRecord> = yield* ports.serialize(
      Effect.gen(function* () {
        const loaded = yield* ports.caller;
        if (loaded.kind === "refused") return { kind: "done", result: loaded.result } as const;
        const caller = loaded.value;
        if (caller.thread.purpose === "advisor")
          return {
            kind: "done",
            result: advisorRefusal("advisor-thread", ADVISOR_THREAD_REFUSAL),
          } as const;
        const settings = yield* ports.settings(caller);
        const gate = advisorConsultGate({
          thread: caller.thread,
          settings: settings.advisor,
          subagents: caller.subagents,
          runId: caller.runId,
        });
        const waitMs = advisorWaitMs(caller.driver);
        if (gate.kind === "refused") return { kind: "done", result: gate.result } as const;
        if (gate.kind === "pick-up") {
          const advisorModel =
            gate.task.model === null
              ? undefined
              : ({
                  instanceId: gate.task.providerInstanceId,
                  model: gate.task.model,
                } satisfies ModelSelection);
          return {
            kind: "pick-up",
            task: gate.task,
            advisor: advisorModel === undefined ? "The advisor" : ports.label(caller, advisorModel),
            advisorModel,
            consultsRemaining: gate.consultsRemaining,
            waitMs,
          } as const;
        }
        const picked = yield* ports.pickAdvisor(caller, settings);
        if (picked.kind === "refused") return { kind: "done", result: picked.result } as const;
        const advisor = picked.value;
        // Earlier consults whose advice was read leave the project's thread list.
        const settled = settledAdvisorChildren(caller.subagents, caller.thread.id);
        if (settled.length > 0) yield* ports.archive(settled);
        const brief = yield* ports.buildBrief(caller, {
          focus: input.focus?.trim() || undefined,
          budgetTokens: settings.advisor.briefTokenBudget,
        });
        const taskId = yield* ports.start({ caller, advisor, brief, ordinal: gate.ordinal });
        return {
          kind: "started",
          taskId,
          advisor,
          brief,
          consultsRemaining: gate.consultsRemaining,
          waitMs,
        } as const;
      }),
    );
    if (prepared.kind === "done") return prepared.result;
    const { consultsRemaining } = prepared;
    /** A consult still working whose child waits on a request: end it instead of waiting on. */
    const endIfBlocked = (about: {
      readonly taskId: NodeId;
      readonly childThreadId: ThreadId | null;
      readonly advisor: string;
      readonly advisorModel: ModelSelection | undefined;
    }) =>
      Effect.gen(function* () {
        if (about.childThreadId === null || !(yield* ports.blocked(about.childThreadId)))
          return undefined;
        yield* ports.abandon({ taskId: about.taskId, childThreadId: about.childThreadId });
        return advisorBlockedResult({ ...about, consultsRemaining });
      });
    if (prepared.kind === "pick-up") {
      const { task: picked, advisor, advisorModel } = prepared;
      const about = {
        taskId: picked.id,
        childThreadId: picked.childThreadId,
        advisor,
        advisorModel,
      };
      // A consult left blocked by an earlier call ends here rather than
      // holding every later call on the same wait.
      if (!isTerminalAdvisorTask(picked)) {
        const ended = yield* endIfBlocked(about);
        if (ended !== undefined) return ended;
      }
      const task = yield* ports.wait(picked.id, prepared.waitMs);
      const result = advisorConsultResult({ task, advisor, advisorModel, consultsRemaining });
      if (result.status === "working") return (yield* endIfBlocked(about)) ?? result;
      // A failed consult has ended too; only a working one keeps its child.
      if (result.status !== "refused" && picked.childThreadId !== null)
        yield* ports.archive([picked.childThreadId]);
      if (result.status !== "advice") return result;
      // Its record turns final a moment after the child's answer: a call in
      // between sees it running and gets the advice it was already given.
      if (picked.completionDelivery?.state === "acknowledged")
        return {
          ...result,
          message: `${advisor} gave this advice to your previous call; no new consult was started.`,
        };
      // A consult that finished after its call said working: its wake-up may
      // be sent already, so the message holds whether or not it was.
      return isTerminalAdvisorTask(picked)
        ? {
            ...result,
            message: `${advisor} answered the consult your earlier call left working; no new consult was started.`,
          }
        : result;
    }
    const { advisor, brief } = prepared;
    const task = yield* ports.wait(prepared.taskId, prepared.waitMs);
    const result = advisorConsultResult({
      task,
      advisor: advisor.label,
      advisorModel: advisor.selection,
      consultsRemaining,
      briefTokens: brief.tokens,
      leftOut: brief.leftOut,
    });
    if (result.status === "working")
      return (
        (yield* endIfBlocked({
          taskId: task.taskId,
          childThreadId: task.childThreadId,
          advisor: advisor.label,
          advisorModel: advisor.selection,
        })) ?? result
      );
    if (result.status !== "refused") yield* ports.archive([task.childThreadId]);
    return result;
  });
