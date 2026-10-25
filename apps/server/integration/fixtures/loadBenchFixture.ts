// Deterministic data for the load benchmark (apps/web/tests/load-bench/run.mjs).
// One workspace with many small threads, plus one big thread: several user turns,
// thousands of turn items and a few large tool outputs. Every id and timestamp is
// derived from the scale, so two seeds of the same scale are byte-identical.
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { diagnosticOutput } from "./transferBudget.ts";

export interface LoadBenchScale {
  readonly name: string;
  /** Projects; the first one holds the big thread. */
  readonly projects: number;
  /** Small threads per project, besides the big thread. */
  readonly threadsPerProject: number;
  /** User turns in the big thread. */
  readonly bigThreadTurns: number;
  /** Tool items per big-thread turn. */
  readonly itemsPerTurn: number;
  /** Every Nth item in a big-thread turn carries a large output. */
  readonly largeOutputEvery: number;
  readonly largeOutputBytes: number;
  readonly smallOutputBytes: number;
}

export const LOAD_BENCH_SCALES: Readonly<Record<string, LoadBenchScale>> = {
  // About 3,000 items and 8 MB of tool output in the big thread, 400 threads in the shell.
  default: {
    name: "default",
    projects: 4,
    threadsPerProject: 100,
    bigThreadTurns: 6,
    itemsPerTurn: 500,
    largeOutputEvery: 125,
    largeOutputBytes: 300_000,
    smallOutputBytes: 1_500,
  },
  // Cheap enough for a shared CI runner.
  small: {
    name: "small",
    projects: 2,
    threadsPerProject: 40,
    bigThreadTurns: 3,
    itemsPerTurn: 200,
    largeOutputEvery: 100,
    largeOutputBytes: 200_000,
    smallOutputBytes: 1_000,
  },
};

export const LOAD_BENCH_BIG_THREAD_ID = ThreadId.make("load-bench-big-thread");
export const LOAD_BENCH_BIG_THREAD_TITLE = "Load bench big thread";
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make(provider);
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const epoch = 1_780_272_000_000; // 2026-06-01T00:00:00Z
const at = (seconds: number) => DateTime.makeUnsafe(epoch + seconds * 1000);

export const loadBenchProjectId = (index: number) => ProjectId.make(`load-bench-project-${index}`);
export const loadBenchProjectTitle = (index: number) => `load-bench-${index + 1}`;

export function threadCreated(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly seconds: number;
  readonly settled: boolean;
}): OrchestrationV2DomainEvent {
  const createdAt = at(input.seconds);
  return {
    id: EventId.make(`created:${input.threadId}`),
    type: "thread.created",
    threadId: input.threadId,
    occurredAt: createdAt,
    payload: {
      id: input.threadId,
      projectId: input.projectId,
      title: input.title,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: input.settled ? createdAt : null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

function turnItem(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly turn: number;
  readonly index: number;
  readonly seconds: number;
  readonly outputBytes: number;
  readonly large: boolean;
}): OrchestrationV2DomainEvent {
  const now = at(input.seconds);
  const base = {
    id: TurnItemId.make(`item:${input.threadId}:${input.turn}:${input.index}`),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.index + 1,
    status: "completed" as const,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const output = diagnosticOutput({
    provider,
    turnIndex: input.turn,
    toolIndex: input.index,
    targetBytes: input.outputBytes,
  });
  const kind = input.large ? (input.index % 2 === 0 ? "mcp" : "command") : input.index % 5;
  const payload =
    kind === "mcp"
      ? {
          ...base,
          title: "MCP search",
          type: "dynamic_tool" as const,
          toolName: "mcp__bench__search",
          input: { query: `load bench ${input.turn}` },
          output: { text: output },
        }
      : kind === 3
        ? {
            ...base,
            title: "Thinking",
            type: "reasoning" as const,
            text: `Reasoning about step ${input.index}. `.repeat(12),
            streaming: false,
          }
        : kind === 4
          ? {
              ...base,
              title: `Edit src/module-${input.index % 40}.ts`,
              type: "file_change" as const,
              fileName: `src/module-${input.index % 40}.ts`,
              additions: 6,
              deletions: 2,
              diffStr: output.slice(0, 1_200),
            }
          : {
              ...base,
              title: `Inspect source ${input.index}`,
              type: "command_execution" as const,
              input: `rg -n "load-bench" src/module-${input.index % 40}.ts`,
              output,
              exitCode: 0,
            };
  return {
    id: EventId.make(`item:${input.threadId}:${input.turn}:${input.index}`),
    type: "turn-item.updated",
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    driver: provider,
    providerInstanceId,
    occurredAt: now,
    payload,
  } as OrchestrationV2DomainEvent;
}

/** One finished user turn: run, user message, tool items, assistant answer. */
export function turnEvents(input: {
  readonly threadId: ThreadId;
  readonly turn: number;
  readonly seconds: number;
  readonly items: number;
  readonly smallOutputBytes: number;
  readonly largeOutputEvery: number;
  readonly largeOutputBytes: number;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const key = `${input.threadId}:${input.turn}`;
  const now = at(input.seconds);
  const runId = RunId.make(`run:${key}`);
  const nodeId = NodeId.make(`node:${key}`);
  const userMessageId = MessageId.make(`user:${key}`);
  const run = {
    id: runId,
    threadId: input.threadId,
    ordinal: input.turn + 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId,
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const common = {
    threadId: input.threadId,
    runId,
    nodeId,
    driver: provider,
    providerInstanceId,
    occurredAt: now,
  } as const;
  const message = (role: "user" | "assistant", text: string): OrchestrationV2DomainEvent => ({
    ...common,
    id: EventId.make(`${role}:${key}`),
    type: "message.updated",
    payload: {
      id: MessageId.make(`${role}:${key}`),
      threadId: input.threadId,
      runId,
      nodeId,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "web",
    },
  });
  // Providers record each message twice: as a message and as a timeline item.
  const messageItem = (
    role: "user" | "assistant",
    text: string,
    ordinal: number,
  ): OrchestrationV2DomainEvent => {
    const base = {
      id: TurnItemId.make(`${role}-item:${key}`),
      threadId: input.threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      messageId: MessageId.make(`${role}:${key}`),
      text,
    };
    return {
      ...common,
      id: EventId.make(`${role}-item:${key}`),
      type: "turn-item.updated",
      payload:
        role === "user"
          ? {
              ...base,
              type: "user_message",
              inputIntent: "turn_start",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            }
          : { ...base, type: "assistant_message", streaming: false },
    };
  };
  const request = `Load bench request ${input.turn + 1}: audit the modules and fix what fails.`;
  const answer =
    `Finished load bench turn ${input.turn + 1}. ` +
    "Every module was inspected and the failing checks were fixed. ".repeat(20);
  const events: OrchestrationV2DomainEvent[] = [
    { ...common, id: EventId.make(`run:${key}`), type: "run.created", payload: run },
    message("user", request),
    messageItem("user", request, 0),
  ];
  for (let index = 0; index < input.items; index++) {
    const large = input.largeOutputEvery > 0 && (index + 1) % input.largeOutputEvery === 0;
    events.push(
      turnItem({
        threadId: input.threadId,
        runId,
        nodeId,
        turn: input.turn,
        index,
        seconds: input.seconds,
        outputBytes: large ? input.largeOutputBytes : input.smallOutputBytes,
        large,
      }),
    );
  }
  events.push(message("assistant", answer), messageItem("assistant", answer, input.items + 1), {
    ...common,
    id: EventId.make(`complete:${key}`),
    type: "run.updated",
    payload: { ...run, status: "completed", completedAt: now },
  });
  return events;
}

export interface LoadBenchThreadPlan {
  readonly projectIndex: number;
  readonly created: OrchestrationV2DomainEvent;
  readonly turns: ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>;
}

/** Threads in write order: small threads first, the big thread last so it is newest. */
export function* loadBenchThreads(scale: LoadBenchScale): Generator<LoadBenchThreadPlan> {
  let seconds = 0;
  for (let project = 0; project < scale.projects; project++) {
    for (let index = 0; index < scale.threadsPerProject; index++) {
      seconds += 60;
      const threadId = ThreadId.make(`load-bench-thread-${project}-${index}`);
      yield {
        projectIndex: project,
        created: threadCreated({
          threadId,
          projectId: loadBenchProjectId(project),
          title: `Bench thread ${project + 1}.${index + 1}`,
          seconds,
          // Most of a real sidebar is settled history.
          settled: index % 5 !== 0,
        }),
        turns: [
          turnEvents({
            threadId,
            turn: 0,
            seconds: seconds + 1,
            items: 2,
            smallOutputBytes: 400,
            largeOutputEvery: 0,
            largeOutputBytes: 0,
          }),
        ],
      };
    }
  }
  seconds += 60;
  yield {
    projectIndex: 0,
    created: threadCreated({
      threadId: LOAD_BENCH_BIG_THREAD_ID,
      projectId: loadBenchProjectId(0),
      title: LOAD_BENCH_BIG_THREAD_TITLE,
      seconds,
      settled: false,
    }),
    turns: Array.from({ length: scale.bigThreadTurns }, (_, turn) =>
      turnEvents({
        threadId: LOAD_BENCH_BIG_THREAD_ID,
        turn,
        seconds: seconds + (turn + 1) * 60,
        items: scale.itemsPerTurn,
        smallOutputBytes: scale.smallOutputBytes,
        largeOutputEvery: scale.largeOutputEvery,
        largeOutputBytes: scale.largeOutputBytes,
      }),
    ),
  };
}
